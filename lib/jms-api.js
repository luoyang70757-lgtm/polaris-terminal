'use strict';
/**
 * jms-api.js — JumpServer v4 REST API 客户端(主进程使用)
 * 实现:登录(含双因素 MFA)、资产/主机列表、MFA 挑战。
 * 登录支持双因素:MFA 依赖 session cookie,故 request 会带上/回传 Cookie。
 */

const https = require('https');
const http = require('http');

/**
 * 请求封装(支持 http/https + cookie 保持会话)
 * 返回 { data, cookie } 其中 cookie 是服务端 Set-Cookie(后续请求带上以维持 MFA 会话)
 */
function request(baseUrl, method, path, { token, body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(baseUrl);
    } catch (e) {
      return reject(new Error(`无效的 JumpServer 地址: ${baseUrl}`));
    }
    const mod = url.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cookie) headers.Cookie = cookie;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    // 支持堡垒机部署在子目录: baseUrl 的路径部分(如 /jms)拼进 API 请求
    const basePath = (url.pathname || '').replace(/\/+$/, '');
    const fullPath = basePath + (path.startsWith('/') ? path : `/${path}`);
    const fullUrl = `${url.protocol}//${url.host}${fullPath}`;

    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: fullPath,
        method,
        headers,
        timeout: 15000,
        // 堡垒机常用自签名证书/内网 CA,跳过证书校验(内网工具常见做法)
        rejectUnauthorized: false,
      },
      (res) => {
        let data = '';
        // 收集所有 Set-Cookie(JumpServer 会先发一个前缀 cookie,真正的 session 会话 cookie 在后面)
        const allSet = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]);
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch { /* 非 JSON 响应 */ }
          if (res.statusCode >= 400 && !json) {
            return reject(new Error(`HTTP ${res.statusCode}(请求 ${fullUrl})`));
          }
          resolve({ data: json, cookie: allSet.join('; ') }); // 全部 cookie 拼成 "a=1; b=2" 格式
        });
      }
    );
    req.on('error', (e) => reject(new Error(`无法连接 JumpServer(${fullUrl}): ${e.message}`)));
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * 登录:POST /api/v1/authentication/auth/
 * 无 MFA → 返回 { ok, token, user, cookie }
 * 需 MFA → 返回 { ok, mfaRequired, cookie, choices, challengeUrl }(客户端再提交 OTP)
 */
async function login(baseUrl, username, password) {
  const { data, cookie } = await request(baseUrl, 'POST', '/api/v1/authentication/auth/', {
    body: { username, password },
  });
  if (data && data.token) {
    return { ok: true, token: data.token, user: data.user, cookie };
  }
  if (data && data.error === 'mfa_required') {
    const d = data.data || {};
    return {
      ok: true,
      mfaRequired: true,
      cookie,
      choices: d.choices || [],
      challengeUrl: d.url || '/api/v1/authentication/mfa/challenge/',
    };
  }
  throw new Error((data && (data.msg || data.error)) || '登录失败');
}

/**
 * 提交 MFA 验证码并完成登录:
 *   1) POST challengeUrl { type, code }(带会话 cookie)校验 OTP
 *   2) 再 POST /auth/(带已通过 MFA 的 cookie)拿 token
 */
async function verifyMfaAndLogin(baseUrl, { cookie, challengeUrl, type, code, username, password }) {
  const mfaRes = await request(baseUrl, 'POST', challengeUrl, {
    cookie,
    body: { type: type || 'otp', code },
  });
  if (mfaRes.data && mfaRes.data.error) {
    throw new Error(mfaRes.data.msg || mfaRes.data.error);
  }
  const final = await request(baseUrl, 'POST', '/api/v1/authentication/auth/', {
    // 用 MFA 响应带回的最新 cookie(可能更新了 session),没有新 cookie 才回退入参的
    // (旧版固定用入参 cookie:若 MFA 阶段服务端换了 session cookie,这里会丢失登录态)
    cookie: (mfaRes.cookie && mfaRes.cookie.trim()) ? mfaRes.cookie : cookie,
    body: { username, password },
  });
  if (final.data && final.data.token) {
    return { ok: true, token: final.data.token, user: final.data.user, cookie };
  }
  throw new Error((final.data && (final.data.msg || final.data.error)) || 'MFA 后登录失败');
}

/**
 * 拉取"当前登录用户"可访问的资产(会话列表只显示该用户自己的资产)。
 * 唯一端点 /api/v1/perms/users/my/assets/:JumpServer v4 对普通用户和 admin
 * 都开放,且只返回当前用户有权限的资产;admin 的 /assets/hosts|assets/ 会列出
 * 全部主机,违反"只获取当前用户"的约束,故不再作兜底。
 * 列表接口不含账号/协议,逐资产查详情补齐 permed_accounts。
 * 增量:传入 cachedById = Map<assetId, cachedAsset> —— 已缓存且已有 accounts 的
 * 主机跳过 N+1 详情请求(登录增量同步用,减少对 JMS 的请求;手动刷新不传=全量)。
 * 返回 [{ id, name, address, protocols, accounts, ... }]
 */
async function fetchAssets(baseUrl, token, cachedById) {
  const { data } = await request(baseUrl, 'GET', '/api/v1/perms/users/my/assets/', { token });
  const raw = (data && data.results) || (Array.isArray(data) ? data : []);
  // ponytail: 逐资产详情补齐账号是 N+1 请求;资产数小时无妨,资产量大时可改批量接口
  const detailBase = '/api/v1/perms/users/my/assets/';
  return Promise.all(raw.map(async (asset) => {
    const out = Object.assign({}, asset, { protocols: asset.protocols && asset.protocols.length ? asset.protocols : [{ name: 'ssh' }] });
    if (!Array.isArray(out.accounts) || !out.accounts.length) {
      // 增量:已缓存且有账号 → 复用缓存账号,跳过详情请求(账号可能过期,手动刷新会全量重拉)
      const cached = cachedById && cachedById.get(String(asset.id));
      if (cached && Array.isArray(cached.accounts) && cached.accounts.length) {
        out.accounts = cached.accounts;
        out._fromCache = true;
      } else {
        try {
          const { data: det } = await request(baseUrl, 'GET', detailBase + asset.id + '/', { token });
          if (det && Array.isArray(det.permed_accounts)) out.accounts = det.permed_accounts;
        } catch { /* 账号未知则保留默认 */ }
      }
    }
    return out;
  }));
}

module.exports = { login, verifyMfaAndLogin, fetchAssets, request };
