'use strict';
/**
 * jump-host.js — "一次性连接"经跳板机(等价 ssh -J 的单条命令版)
 *
 * 为什么要单独一个模块:
 *   主终端会话的跳板隧道在 main.js openJumpTunnel,连接登记在 jumpConns 里随会话关闭;
 *   而 batch:exec(批量执行)/ AI 的 run_command / sessions:detectOs(系统探测)都是
 *   "连上 → 跑一条命令 → 断开",没有会话槽位可用,登记进去会覆盖主会话的跳板连接(泄漏)。
 *   这里自己开跳板连接、自己转发、用完必回收(finally),不复用 jumpConns。
 *
 * 语义与主会话一致:
 *   - 跳板机连不上 / 转发超时 → 抛错,调用方照常走各自的失败分支(不会卡住);
 *   - 跳板机指纹同样校验(known_hosts,可用 verifyHostKey:false 关闭);
 *   - 跳板密码/私钥口令由调用方解密后传入,本模块不碰存储;
 *   - 目标认证仍用用户自己的账号,跳板只转发字节。
 */
const sshClient = require('./ssh-client');
const connectOpts = require('./connect-opts');

const FORWARD_TIMEOUT_MS = 30000; // 跳板握手成功但转发永不响应时的兜底(与主会话一致)

/** 归一化跳板配置:host 为空视为"无跳板";port 缺省 22;兼容 private_key / privateKey 两种写法 */
function normalizeJump(jump) {
  let j = jump;
  if (typeof j === 'string') { try { j = JSON.parse(j); } catch { return null; } }
  if (!j || typeof j !== 'object') return null;
  const host = String(j.host || '').trim();
  if (!host) return null;
  return {
    host,
    port: Number(j.port) || 22,
    username: String(j.username || '').trim(),
    password: j.password || '',
    privateKey: j.private_key || j.privateKey || '',
    passphrase: j.passphrase || '',
  };
}

/** 跳板机连接参数:用户名缺省沿用目标账号(与主会话一致),私钥路径 → 内容,指纹照常校验 */
function jumpConnectOpts(jump, target, extra = {}) {
  const j = normalizeJump(jump);
  if (!j) throw new Error('跳板机配置缺少 host');
  const t = target || {};
  const opts = connectOpts.resolvePrivateKey({
    host: j.host,
    port: j.port,
    username: j.username || t.username || '',
    password: j.password,
    privateKey: j.privateKey,
    passphrase: j.passphrase,
  });
  if (t.verifyHostKey !== false) {
    opts.hostVerifier = connectOpts.makeHostVerifier(j.host, j.port, t.autoTrustHostKey === true);
  }
  if (extra.onKeyboardInteractive) opts.onKeyboardInteractive = extra.onKeyboardInteractive;
  return opts;
}

/**
 * 开一条跳板隧道到目标
 * @returns {Promise<{conn, stream}>} conn = 跳板机连接(必须 end),stream = 目标连接的 sock
 */
async function openTunnel(jump, target, deps = {}) {
  const connectRaw = deps.connectRaw || sshClient.connectRaw;
  const timeoutMs = deps.timeoutMs || FORWARD_TIMEOUT_MS;
  const j = normalizeJump(jump);
  if (!j) throw new Error('跳板机配置缺少 host');
  const t = target || {};
  if (!t.host) throw new Error('目标主机为空');
  const conn = await connectRaw(jumpConnectOpts(j, t, deps));
  try {
    const stream = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`跳板机转发超时(${Math.round(timeoutMs / 1000)}s)`)),
        timeoutMs
      );
      conn.forwardOut(t.host, 0, t.host, Number(t.port) || 22, (err, s) => {
        clearTimeout(timer); // 成功也要清:否则定时器留着,进程空转/延迟退出
        if (err) return reject(err);
        resolve(s);
      });
    });
    return { conn, stream };
  } catch (err) {
    try { conn.end(); } catch { /* ignore */ } // 转发失败:跳板连接不能留
    throw err;
  }
}

/**
 * 用跳板给一条一次性连接装上 sock,并在命令结束后回收跳板连接。
 * 没有 jump 时原样调用 fn(opts)(零开销,不新建任何连接)。
 * @param {object} opts — 目标连接参数(含 jump)
 * @param {(opts) => Promise<any>} fn — 真正建连/执行的地方(如 sshClient.execCommand)
 */
async function withJump(opts, fn, deps = {}) {
  const j = normalizeJump(opts && opts.jump);
  if (!j) return fn(opts);
  const extra = { ...deps };
  if (!extra.onKeyboardInteractive && opts.onKeyboardInteractive) extra.onKeyboardInteractive = opts.onKeyboardInteractive;
  const { conn, stream } = await openTunnel(j, opts, extra);
  try {
    // jump 置空:sock 已经建好,后面若再被 whenJump 包一次也不会重复开隧道
    return await fn({ ...opts, jump: null, sock: stream });
  } finally {
    try { stream.destroy(); } catch { /* ignore */ }
    try { conn.end(); } catch { /* ignore */ }
  }
}

module.exports = { normalizeJump, jumpConnectOpts, openTunnel, withJump, FORWARD_TIMEOUT_MS };
