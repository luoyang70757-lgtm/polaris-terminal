'use strict';
/**
 * h3c-api.js — H3C Shterm 堡垒机 REST API 客户端(主进程使用)
 *
 * 与 jms-api.js 平级的第二个堡垒机客户端。区别在认证形态:
 *   - JumpServer: 显式 token(Bearer),http/https 手拼 Cookie
 *   - H3C shterm: 登录态是 webview(partition="persist:bastion")里的会话 cookie
 *     这里直接用 session.fromPartition('persist:bastion').fetch() —— Chromium 网络栈
 *     自动带 partition 的 cookie(含 HttpOnly),证书错误由 main.js 的 certificate-error
 *     全局放行覆盖(自签名堡垒机证书可通)。webview 只负责登录,资产/连接走这条原生通道。
 *
 * 端点形状全部来自 renderer 注入钩子(__bastionFetchAll/fetchPathDevs/fetchRecent,
 * 见 src/renderer.js 5362-5440)与真实 HAR:
 *   - GET  /shterm/api/asset/getAccessViewTree       → { children:[...] }
 *   - PUT  /shterm/api/asset/getAccessViewDevs       → { content:[...], last, totalPages }
 *         ?page=<n>&size=100, body { page,size, sort:'name,asc', stateIn:'0', paths }
 *   - PUT  /shterm/api/asset/getLoginUserRecentDevs  → 同上 { content } 形状
 *         ?page=<n>&size=100&sort=accessTime,desc, body {}
 *   - POST /shterm/api/deviceAccess/accessUrl        → { url:'accessclient://...' }
 *         body { misc:{resolution,tab,isDualAuth}, sessRemark, account, proto, dev }
 */
const { session } = require('electron');

const PARTITION = 'persist:bastion'; // 与 index.html <webview partition="persist:bastion"> 一致
const bastionSession = () => session.fromPartition(PARTITION);

// baseUrl 允许带子目录(如 https://host/bastion):H3C API 拼在 origin+basePath 下。
// 注意 state.bastionUrl 存的是 origin,JMS/H3C 的请求都落在 origin 根,这里兼容兜底。
function joinPath(base, p) {
  const b = String(base || '').replace(/\/+$/, '');
  return b + String(p || '');
}

/**
 * 核心请求。返回:
 *   { ok:true,  data }                      成功
 *   { ok:false, needLogin:true, status }    未登录/会话过期(401/403、HTML 登录页、登录形 URL、登录错误码)
 *   { ok:false, needLogin:false, error }    真实失败(网络错误/接口错误) —— 绝不误判为需登录
 */
async function request(baseUrl, method, path, { query, body } = {}) {
  let url;
  try {
    const u = new URL(String(baseUrl || ''));
    u.pathname = joinPath(u.pathname, path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
      }
    }
    url = u.href;
  } catch (err) {
    return { ok: false, error: `无效的堡垒机地址: ${baseUrl}`, needLogin: false };
  }
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await bastionSession().fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'include', // 同 partition 会话 cookie
      redirect: 'follow',
    });
  } catch (err) {
    // 网络层失败(连不上/DNS/超时):连控制台都不可达,无法判断登录态 → 不标 needLogin
    return { ok: false, error: `无法连接堡垒机(${err.message})`, networkError: true, needLogin: false };
  }
  const status = res.status;
  const ct = String(res.headers.get('content-type') || '');
  const finalUrl = String(res.url || url);
  const text = await res.text().catch(() => '');

  // 401/403 一律视为未登录
  if (status === 401 || status === 403) return { ok: false, status, needLogin: true };
  // HTML 响应 = 会话过期被 302 到登录页(最终 200 text/html);登录形 URL 同理
  if (ct.includes('text/html') || /\/login|login\.html|\/cas\b|\/sso\b/i.test(finalUrl)) {
    return { ok: false, status, needLogin: true };
  }
  // 非 JSON(且非登录页):真失败
  if (!/json/i.test(ct)) {
    return { ok: false, status, error: status >= 400 ? `HTTP ${status}` : '响应非 JSON', needLogin: false };
  }
  // JSON
  let data;
  try { data = JSON.parse(text); } catch (err) {
    return { ok: false, status, error: '响应解析失败', needLogin: false };
  }
  if (status >= 200 && status < 300) {
    if (data && typeof data === 'object') {
      const msg = data.msg || data.message || '';
      // 登录错误码/文案 → 未登录(部分设备 JSON 错误也回 200)
      if (data.code === 401 || /未登录|请登录|登录过期|login/i.test(String(msg))) {
        return { ok: false, status, needLogin: true };
      }
      if (data.success === false) {
        return { ok: false, status, error: msg || '堡垒机接口返回失败', needLogin: /未登录|请登录|登录过期/i.test(String(msg)) };
      }
      if (typeof data.error === 'string' && data.error) {
        return { ok: false, status, error: data.error, needLogin: /未登录|请登录|登录过期/i.test(data.error) };
      }
    }
    return { ok: true, data };
  }
  // 非 2xx JSON(非 401/403):接口错误,非登录问题
  return { ok: false, status, error: (data && (data.msg || data.message)) || `HTTP ${status}`, needLogin: false };
}

module.exports = {
  request,
  getTree: (baseUrl) => request(baseUrl, 'GET', '/shterm/api/asset/getAccessViewTree'),
  getDevs: (baseUrl, paths, page) => request(baseUrl, 'PUT', '/shterm/api/asset/getAccessViewDevs', {
    query: { page: page || 0, size: 100 },
    body: { page: page || 0, size: 100, sort: 'name,asc', stateIn: '0', paths: paths || [] },
  }),
  getRecent: (baseUrl, page) => request(baseUrl, 'PUT', '/shterm/api/asset/getLoginUserRecentDevs', {
    query: { page: page || 0, size: 100, sort: 'accessTime,desc' },
    body: {},
  }),
  accessUrl: (baseUrl, { dev, account, proto }) => request(baseUrl, 'POST', '/shterm/api/deviceAccess/accessUrl', {
    body: {
      misc: { resolution: '80x24', tab: true, isDualAuth: false },
      sessRemark: '',
      account,
      proto: proto || 'ssh',
      dev,
    },
  }),
};
