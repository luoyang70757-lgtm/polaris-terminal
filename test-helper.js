'use strict';
/**
 * test-helper.js — verify-*.js (CDP e2e) 共用的进程/端口工具
 *
 * 背景:本文件被 .gitignore 排除(/test-helper.js),克隆后需要本地重建。
 * 原版是 macOS 专用(lsof / kill -9 / process.kill(-pid)),在 Windows 上全部静默失效
 * (端口清不掉、进程杀不掉、electron 起不来)。这里改成跨平台实现:
 *   - freePort(port)        : 结束占用该 TCP 端口的进程(Windows: netstat + taskkill;macOS/Linux: lsof + kill -9)
 *   - killTree(proc)        : 结束 spawn 出来的进程及其子进程(Windows: taskkill /T /F;POSIX: 杀进程组)
 *   - guardTimeout(ms,proc) : 超时兜底(打印原因 → killTree → exit 1),并 unref 不阻塞退出
 *   - waitPort(port, ms)    : 轮询等待端口可连接(部分脚本自带同名实现,不冲突)
 *   - spawnElectron(args, opts) : 跨平台启动 electron(spawn('node_modules/.bin/electron') 在 Windows 下 ENOENT)
 *
 * 用法(verify 脚本):
 *   const { freePort, killTree, guardTimeout } = require('./test-helper');
 *   const appProc = spawn(require('electron'), ['.', '--dev', `--remote-debugging-port=${PORT}`], { ... });
 */

const { execSync, spawn: rawSpawn } = require('child_process');
const net = require('net');
const path = require('path');

const IS_WIN = process.platform === 'win32';

/** 结束占用 TCP 端口的进程(同步)。端口空闲/无权限/tool 缺失时静默忽略。 */
function freePort(port) {
  const p = Number(port);
  if (!Number.isFinite(p) || p <= 0) return;
  if (IS_WIN) {
    try {
      // netstat -ano: 例 "  TCP    0.0.0.0:9351    0.0.0.0:0    LISTENING    12345"
      const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
        if (m && Number(m[1]) === p && m[2] !== '0') pids.add(m[2]);
      }
      for (const pid of pids) {
        try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', windowsHide: true }); } catch { /* 已退出 */ }
      }
    } catch { /* ignore */ }
    return;
  }
  try {
    execSync(`lsof -ti tcp:${p} | xargs kill -9 2>/dev/null`, { stdio: 'ignore', shell: '/bin/sh' });
  } catch { /* ignore */ }
}

/** 结束进程树(同步)。脚本在 process.exit 前直接调用,必须同步完成。 */
function killTree(proc, signal) {
  if (!proc || !proc.pid) return;
  if (IS_WIN) {
    try { execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore', windowsHide: true }); } catch { /* 已退出 */ }
    return;
  }
  try {
    process.kill(-proc.pid, signal || 'SIGKILL'); // detached:true 时进程组为 -pid
  } catch {
    try { process.kill(proc.pid, signal || 'SIGKILL'); } catch { /* 已退出 */ }
  }
}

/** 超时兜底:到点打印、杀进程树、退出码 1。返回 timer(可自行 clearTimeout)。 */
function guardTimeout(ms, proc, label) {
  // 测试脚本普遍在 try 里直接 process.exit()(finally 不执行)→ 进程残留。
  // 统一在这里登记退出钩子:无论正常退出、断言失败还是超时,都把子进程树收干净。
  if (proc && proc.pid) {
    try { process.once('exit', () => killTree(proc)); } catch { /* ignore */ }
  }
  const timer = setTimeout(() => {
    try {
      console.error(`\n⏱ 测试超时(${ms}ms)${label ? ' · ' + label : ''} —— 强制结束并退出`);
    } catch { /* ignore */ }
    killTree(proc);
    process.exit(1);
  }, ms);
  if (timer.unref) timer.unref(); // 测试正常结束时不让这个定时器拖住进程
  return timer;
}

/** 轮询等待端口可连接(返回 Promise<boolean>)。 */
function waitPort(port, ms = 10000, host = '127.0.0.1') {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const s = net.connect({ port: Number(port), host });
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() - t0 > ms) resolve(false);
        else setTimeout(tick, 200);
      });
    };
    tick();
  });
}

/**
 * 跨平台启动 electron。
 * Windows 下 `node_modules/.bin/electron` 是无扩展名的 shell 脚本,CreateProcess 无法执行(ENOENT);
 * `require('electron')` 会解析到 node_modules/electron/dist/electron.exe(即 install.js 下载的二进制)。
 * 注意:arg0 文本仍是相对路径 '.' / 项目根,脚本需从项目根运行。
 */
function spawnElectron(args, opts = {}) {
  return rawSpawn(require('electron'), args, {
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
    ...opts,
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * CDP `Runtime.evaluate` 封装(带启动竞态重试)。
 * 主窗口的 page target 一出现就 connect 时,renderer.js 可能还没执行完 ——
 * 此时 `state` / 页面函数尚未就绪,求值会抛 ReferenceError(冷启动/Windows 上更容易遇到)。
 * 这类错误短暂重试即可;真正的 JS 异常仍抛出(测试据此失败)。
 */
async function evaluate(c, expr, { retries = 40, delay = 250 } = {}) {
  // ① 就绪闸门:主窗口 page target 一出现就 connect 时,页面可能还在 loading(renderer.js 尚未执行完)。
  //    document.readyState==='complete' 说明末尾的 <script src="renderer.js"> 已同步执行完毕,
  //    此时 state / 页面函数才真实可用(否则 typeof 得到 undefined 而不是抛错,重试也救不回来)。
  //    每个连接只等一次;超时也不阻断,交给下面的 ReferenceError 重试兜底。
  if (!c.__polarisReady) {
    for (let i = 0; i < 40; i++) {
      try {
        const st = await c.call('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
        if (st && st.result && st.result.value === 'complete') { c.__polarisReady = true; break; }
      } catch { /* 页面切换瞬间:忽略,继续等 */ }
      await sleep(200);
    }
  }
  let r;
  for (let i = 0; ; i++) {
    r = await c.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const ex = r && r.exceptionDetails;
    const refErr = !!(ex && ex.exception && ex.exception.className === 'ReferenceError');
    if (!refErr || i >= retries) break;
    await sleep(delay);
  }
  if (r.exceptionDetails) {
    throw new Error('JS异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 600) + ' @ ' + expr.slice(0, 120));
  }
  return r.result && r.result.value;
}

module.exports = {
  IS_WIN,
  freePort,
  killTree,
  guardTimeout,
  waitPort,
  spawnElectron,
  evaluate,
  sleep,
  // 供个别脚本自建路径时使用
  electronPath: () => require('electron'),
  projectRoot: path.resolve(__dirname),
};
