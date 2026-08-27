'use strict';
/**
 * mock-server.js — 本地模拟 JumpServer v4(HTTP API)+ KoKo(SSH 网关)
 *
 * 作用:在没有真实 JumpServer 的环境下,让 POC 可以端到端跑通:
 *   Electron 客户端 → (HTTP) 登录/拉资产 → (SSH) 连 KoKo → 假资产 shell
 *
 * 行为对齐真实 JumpServer v4(基于源码调研):
 *   - POST /api/v1/authentication/auth/  → { token, user }
 *   - GET  /api/v1/assets/assets/        → { count, results: [...] }
 *   - SSH  端口 2222,用户名格式: JMS用户[@协议]@账号@资产IP (分隔符 @ 或 #)
 *   - 密码 = JMS 平台用户密码
 *   - 会话输入输出记录到 logs/audit-*.log(模拟 JumpServer 审计)
 *
 * 用法: node mock/mock-server.js   (默认 HTTP 8080 / SSH 2222)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib'); // H3C accessclient:// token(base64url(zlib(json)))
const { Server: SSHServer } = require('ssh2');
const { createFakeShell } = require('./fake-shell');
const { createSftpServer, diskRoot: MOCK_DISK_ROOT } = require('./sftp-vfs'); // 内存虚拟磁盘 SFTP 服务

// ---------- 配置 ----------
const HTTP_PORT = parseInt(process.env.MOCK_HTTP_PORT || '8080', 10);
const SSH_PORT = parseInt(process.env.MOCK_SSH_PORT || '2222', 10);
let mockPackEnabled = process.env.MOCK_PACK_DISABLED !== '1'; // 打包上传探测开关(verify 可经 HTTP 翻转)
const LOG_DIR = path.join(__dirname, '..', 'logs');

// ---------- mock 数据:用户与资产 ----------
const USERS = [
  { username: 'admin', password: 'admin123', name: '系统管理员', role: 'admin' },
  { username: 'ops', password: 'ops123', name: '运维工程师', role: 'user' },
  // keyboard-interactive 认证测试:kbd 单密码挑战(自动应答);kbd2 密码+OTP 双提示(弹窗)
  { username: 'kbd', password: 'kbd123', name: '键盘交互(单提示)', role: 'user' },
  { username: 'kbd2', password: 'kbd123', name: '键盘交互(密码+OTP)', role: 'user' },
];

const ASSETS = [
  { id: crypto.randomUUID(), name: 'web-server-01', address: '192.168.10.10', protocols: [{ name: 'ssh', port: 22 }], accounts: [{ username: 'root' }, { username: 'deploy' }], comment: '前端 Web 服务器' },
  { id: crypto.randomUUID(), name: 'db-server-01', address: '192.168.10.11', protocols: [{ name: 'ssh', port: 22 }], accounts: [{ username: 'root' }, { username: 'mysql' }], comment: 'MySQL 数据库' },
  { id: crypto.randomUUID(), name: 'app-server-02', address: '192.168.10.12', protocols: [{ name: 'ssh', port: 22 }], accounts: [{ username: 'ubuntu' }], comment: '应用服务器(测试)' },
];

// 权限:ops 只能看前两台
function assetsFor(username) {
  if (username === 'ops') return ASSETS.slice(0, 2);
  return ASSETS;
}

const tokens = new Map(); // token -> username

// ---------- H3C shterm mock(原生 h3c:* IPC 用;webview 与主进程 ses.fetch 同源共享 shterm_session cookie) ----------
const H3C_TREE = {
  children: [
    { id: 'tree-1', name: '生产一', path: ['生产一'], children: [
      { id: 'dev-1', name: 'web-node-1', ip: '192.168.10.99', path: ['生产一'] },
      { id: 'dev-2', name: 'db-node-1', ip: '192.168.10.98', path: ['生产一'] },
      { id: 'dev-3', name: 'app-node-1', ip: '192.168.10.97', path: ['生产一'] },
    ]},
    { id: 'tree-2', name: '生产二', path: ['生产二'], children: [
      { id: 'dev-4', name: 'log-node-2', ip: '192.168.10.96', path: ['生产二'] },
      { id: 'dev-5', name: 'nfs-node-2', ip: '192.168.10.95', path: ['生产二'] },
    ]},
  ],
};
const H3C_DEVICES = [
  { id: 'dev-1', name: 'web-node-1', ip: '192.168.10.99', dir: '生产一' },
  { id: 'dev-2', name: 'db-node-1', ip: '192.168.10.98', dir: '生产一' },
  { id: 'dev-3', name: 'app-node-1', ip: '192.168.10.97', dir: '生产一' },
  { id: 'dev-4', name: 'log-node-2', ip: '192.168.10.96', dir: '生产二' },
  { id: 'dev-5', name: 'nfs-node-2', ip: '192.168.10.95', dir: '生产二' },
];
// getAccessViewDevs/getLoginUserRecentDevs 的 content 形状(与 parseDevs 对齐):
// { content:[{ id, dev:{ id,name,ip,services:{services:{ssh:{port}}},accounts:{accounts:[{name}]} }, recent:{account} }] }
function h3cDevsContent(dirs) {
  const list = dirs && dirs.length ? H3C_DEVICES.filter((d) => dirs.includes(d.dir)) : H3C_DEVICES;
  return list.map((d) => ({
    id: d.id,
    dev: { id: d.id, name: d.name, ip: d.ip, services: { services: { ssh: { port: 22 } } }, accounts: { accounts: [{ name: 'root' }, { name: 'admin' }] } },
    recent: { account: 'root' },
  }));
}
const h3cSessions = new Set(); // shterm_session 值集合(模拟 H3C 登录会话)
function h3cAuthed(req) {
  const m = /(?:^|;\s*)shterm_session=([^;]+)/.exec(req.headers.cookie || '');
  return !!(m && h3cSessions.has(m[1]));
}
// accessUrl 响应:与真实 H3C 一致 —— accessclient://<base64url(zlib(json))>,内含一次性密码
function makeH3CAccessUrl(dev) {
  const d = H3C_DEVICES.find((x) => x.id === dev) || H3C_DEVICES[0];
  const info = { mode: 'proxy', hn: '127.0.0.1', pn: SSH_PORT, sa: 'admin', pw: 'admin123', sn: d.name, st: d.name, sh: d.ip, cp: 'UTF-8' };
  const buf = zlib.deflateSync(Buffer.from(JSON.stringify(info), 'utf8'));
  return 'accessclient://' + buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}


// ---------- HTTP API ----------
function authHandler(req, res, body) {
  const { username, password } = body || {};
  const user = USERS.find((u) => u.username === username && u.password === password);
  if (!user) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '用户名或密码错误' }));
    return;
  }
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, user.username);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    token,
    user: { id: crypto.randomUUID(), username: user.username, name: user.name, role: user.role },
    expired_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  }));
}

function assetsHandler(req, res, bearer) {
  const username = tokens.get(bearer);
  if (!username) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '未认证或 token 已过期' }));
    return;
  }
  const list = assetsFor(username).map((a) => ({
    id: a.id,
    name: a.name,
    address: a.address,
    protocols: a.protocols,
    accounts: a.accounts,
    comment: a.comment,
  }));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ count: list.length, results: list }));
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const url = new URL(req.url, `http://localhost:${HTTP_PORT}`);
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* ignore */ }

    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

    console.log(`[HTTP] ${req.method} ${url.pathname}`);

    if (req.method === 'POST' && url.pathname === '/api/v1/authentication/auth/') {
      return authHandler(req, res, body);
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/assets/assets/') {
      return assetsHandler(req, res, bearer);
    }
    // JumpServer v4 资产端点:app 的 lib/jms-api.js 拉"当前用户资产"用这个(列表带 accounts,免逐台详情 N+1)
    if (req.method === 'GET' && url.pathname === '/api/v1/perms/users/my/assets/') {
      return assetsHandler(req, res, bearer);
    }
    // 打包上传开关(verify-pack-upload 用):翻转后新会话走回退递归路径
    if (req.method === 'POST' && url.pathname === '/mock/pack') {
      mockPackEnabled = !body || body.enabled !== false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ packEnabled: mockPackEnabled }));
      return;
    }

    // ---- H3C shterm mock(原生 h3c:* IPC 走这条;webview 登录后与 ses.fetch 同源共享 cookie) ----
    if (url.pathname === '/shterm/' || url.pathname === '/shterm') {
      if (h3cAuthed(req)) {
        // 已登录:控制台页(资产拉取已原生化,页面只需稳定存在,保证 /shterm 站点判定 + 会话保活)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><title>H3C 控制台(mock)</title></head><body><h1>H3C 堡垒机控制台(mock)</h1><div class="asset-list"><span class="node_name">生产一</span><span class="node_name">生产二</span></div><p>已登录:资产由主进程 h3c:* 原生拉取</p></body></html>`);
      } else {
        // 登录页:用户名/密码 + 登录按钮(无验证码 → startBastionAutoFill 自动填并点登录)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><title>H3C 登录(mock)</title></head><body>
          <h1>H3C 堡垒机登录(mock: admin/admin123)</h1>
          <form id="loginForm">
            <input type="text" name="username" id="username" placeholder="用户名" />
            <input type="password" name="password" id="password" placeholder="密码" />
            <button type="submit">登 录</button>
          </form>
          <script>
            document.getElementById('loginForm').addEventListener('submit', function(e){
              e.preventDefault();
              var f = new FormData(document.getElementById('loginForm'));
              fetch('/shterm/login', { method:'POST', body: new URLSearchParams(f), credentials:'include' }).then(function(r){
                window.location.href = '/shterm/';
              });
            });
          </script>
        </body></html>`);
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/shterm/login') {
      // 解析 urlencoded(username=..&password=..) 或 JSON(自动填充走的 fetch 是 urlencoded)
      let username = '', password = '';
      try {
        if (raw.trim().startsWith('{')) { const j = JSON.parse(raw); username = j.username || ''; password = j.password || ''; }
        else { const sp = new URLSearchParams(raw); username = sp.get('username') || ''; password = sp.get('password') || ''; }
      } catch { /* ignore */ }
      if (username !== 'admin' || password !== 'admin123') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '用户名或密码错误' }));
        return;
      }
      const sid = crypto.randomBytes(16).toString('hex');
      h3cSessions.add(sid);
      res.writeHead(302, { 'Location': '/shterm/', 'Set-Cookie': `shterm_session=${sid}; Path=/; HttpOnly` });
      res.end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/shterm/expire') {
      // 验证脚本免页面导航触发会话过期(清 cookie 返回 200 JSON → 原生 needLogin 检测)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'shterm_session=; Path=/; Max-Age=0' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname.startsWith('/shterm/api/')) {
      if (!h3cAuthed(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 401, msg: '未登录或会话已过期' }));
        return;
      }
      if (url.pathname === '/shterm/api/asset/getAccessViewTree') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(H3C_TREE));
        return;
      }
      // 小页(PAGE_SIZE=2)触发客户端翻页逻辑(真实设备 870 台/44 页,这里模拟多页)
      if (url.pathname === '/shterm/api/asset/getAccessViewDevs' && req.method === 'PUT') {
        const page = parseInt(url.searchParams.get('page') || '0', 10) || 0;
        const dirs = (body && Array.isArray(body.paths)) ? body.paths : [];
        const all = h3cDevsContent(dirs);
        const start = page * 2;
        const chunk = all.slice(start, start + 2);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          content: chunk,
          last: start + chunk.length >= all.length,
          totalPages: Math.max(1, Math.ceil(all.length / 2)),
          totalElements: all.length,
        }));
        return;
      }
      if (url.pathname === '/shterm/api/asset/getLoginUserRecentDevs' && req.method === 'PUT') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ content: h3cDevsContent(['生产一']).slice(0, 2), last: true, totalPages: 1 }));
        return;
      }
      if (url.pathname === '/shterm/api/deviceAccess/accessUrl' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: makeH3CAccessUrl((body && body.dev) || '') }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'mock H3C API: not found' }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'mock API: not found' }));
  });
});

// ---------- SSH(KoKo)网关 ----------
// SSH 主机密钥:启动前确保存在(真实环境为 JumpServer 正式密钥,此处临时生成)
ensureLogDir();
const HOST_KEY_FILE = path.join(__dirname, 'hostkey.pem');
if (!fs.existsSync(HOST_KEY_FILE)) {
  require('child_process').execSync(`ssh-keygen -t rsa -b 2048 -m PEM -f ${HOST_KEY_FILE} -N '' -q`);
  console.log(`[KEY] 已生成临时 SSH 主机密钥: ${HOST_KEY_FILE}`);
}

function parseDirectUser(username) {
  // 格式: JMS用户[@协议]@账号@资产IP   分隔符 @ 或 #,3 或 4 段
  // 例: admin@root@192.168.10.10  /  admin#ssh#root#192.168.10.10
  const parts = username.split(/[@#]/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const jmsUser = parts[0];
  let protocol = 'ssh';
  let account, asset;
  if (parts.length === 4) {
    protocol = parts[1];
    account = parts[2];
    asset = parts[3];
  } else {
    account = parts[1];
    asset = parts[2];
  }
  return { jmsUser, protocol, account, asset };
}

function findAsset(assetTarget) {
  return ASSETS.find((a) => a.address === assetTarget || a.id === assetTarget);
}

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}


function makeAudit(session) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(LOG_DIR, `audit-${stamp}-${session.jmsUser}-${session.asset.name}.log`);
  const ws = fs.createWriteStream(file, { flags: 'a' });
  ws.write(`# JumpServer mock audit log\n# user=${session.jmsUser} account=${session.account} asset=${session.asset.name} (${session.asset.address})\n# started=${new Date().toISOString()}\n`);
  let closed = false; // 防止 close() 被调用两次导致 "write after end" 崩溃
  return {
    in: (s) => ws.write(`[IN  ${new Date().toISOString()}] ${JSON.stringify(s)}\n`),
    out: (s) => ws.write(`[OUT ${new Date().toISOString()}] ${JSON.stringify(s)}\n`),
    cmd: (c) => ws.write(`[CMD ${new Date().toISOString()}] ${c}\n`),
    close: () => {
      if (closed) return;
      closed = true;
      ws.write(`# closed=${new Date().toISOString()}\n`);
      ws.end();
      console.log(`[AUDIT] 会话已记录: ${file}`);
    },
  };
}

const sshd = new SSHServer({ hostKeys: [fs.readFileSync(path.join(__dirname, 'hostkey.pem'))] }, (client) => {
  // 认证成功时缓存的会话信息(ssh2 的 stream 上取不到 username)
  let sessionInfo = null;

  client.on('authentication', (ctx) => {
    // 解析 KoKo 直连格式: admin@ssh@root@192.168.10.10 → { jmsUser:'admin', protocol:'ssh', account:'root', asset:'192.168.10.10' }
    // 兼容纯用户名直连: admin
    const parsed = parseDirectUser(ctx.username);
    const jmsUser = parsed ? parsed.jmsUser : ctx.username;
    const user = USERS.find((u) => u.username === jmsUser);
    // 公钥认证:mock 简化版,用户名存在即接受任意公钥(方便本地测密钥认证)
    if (ctx.method === 'publickey') {
      if (!user) {
        console.log(`[SSH] 认证失败: ${ctx.username}`);
        return ctx.reject(['password', 'publickey']);
      }
      sessionInfo = parsed
        ? { jmsUser: user.username, protocol: parsed.protocol, account: parsed.account, asset: findAsset(parsed.asset) || ASSETS[0] }
        : { jmsUser: user.username, account: user.username, asset: ASSETS[0], protocol: 'ssh' };
      console.log(`[SSH] 公钥认证通过: ${ctx.username}(KoKo 格式=${!!parsed})`);
      return ctx.accept(); // 第一轮无签名→accept 让客户端继续发签名;第二轮有签名→accept 即成功
    }
    // keyboard-interactive 认证:kbd 单密码挑战;kbd2 密码+OTP 双提示(测弹窗)
    if (ctx.method === 'keyboard-interactive') {
      const acceptKbd = () => {
        sessionInfo = { jmsUser: user.username, account: user.username, asset: ASSETS[0], protocol: 'ssh' };
        console.log(`[SSH] 键盘交互认证通过: ${ctx.username}`);
        ctx.accept();
      };
      if (ctx.username === 'kbd') {
        return ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) => {
          if (answers[0] === 'kbd123') acceptKbd();
          else { console.log(`[SSH] kbd 认证失败`); ctx.reject(['password', 'keyboard-interactive', 'publickey']); }
        });
      }
      if (ctx.username === 'kbd2') {
        return ctx.prompt([
          { prompt: 'Password: ', echo: false },
          { prompt: 'OTP Code: ', echo: true },
        ], (answers) => {
          if (answers[0] === 'kbd123' && answers[1] === '123456') acceptKbd();
          else { console.log(`[SSH] kbd2 认证失败`); ctx.reject(['password', 'keyboard-interactive', 'publickey']); }
        });
      }
      return ctx.reject(['password', 'keyboard-interactive', 'publickey']);
    }
    // 密码认证
    if (ctx.method !== 'password') return ctx.reject(['password', 'keyboard-interactive', 'publickey']);
    // kbd/kbd2 只允许 keyboard-interactive(测该路径,强制客户端走挑战流程)
    if (ctx.username === 'kbd' || ctx.username === 'kbd2') {
      return ctx.reject(['keyboard-interactive']);
    }
    if (!user || user.password !== ctx.password) {
      console.log(`[SSH] 认证失败: ${ctx.username}`);
      return ctx.reject(['password', 'keyboard-interactive', 'publickey']);
    }
    // 直连会话:KoKo 格式按解析到的资产路由,否则固定落到第一台 mock 资产
    sessionInfo = parsed
      ? { jmsUser: user.username, protocol: parsed.protocol, account: parsed.account, asset: findAsset(parsed.asset) || ASSETS[0] }
      : { jmsUser: user.username, account: user.username, asset: ASSETS[0], protocol: 'ssh' };
    console.log(`[SSH] 认证通过: ${ctx.username}(KoKo 格式=${!!parsed} → 资产=${sessionInfo.asset.name})`);
    ctx.accept();
  });

  client.on('ready', () => {
    console.log('[SSH] 客户端已认证,等待会话请求');
  });

  // keepalive 全局请求(ssh2 客户端每 10s 心跳):必须 accept,否则连续 3 次无回应
  // 客户端判"Keepalive timeout"掉线(真实 KoKo 网关同样回心跳)。
  client.on('request', (accept, reject, name) => {
    if (accept) accept();
  });

  // 直接 TCP 转发(direct-tcpip):本地端口转发 / 动态 SOCKS / 跳板机(ProxyJump)走这个通道。
  // 区分两类目标:
  //   - 本机地址(127.0.0.1/::1)→ 真转发:跳板场景要把隧道接到本机另一个 mock 的 SSH 端口
  //   - 其他(占位域名/内网假地址)→ 回显:发什么原样返回,让本地端口转发/SOCKS 测试无真实目标也能验证隧道通
  client.on('tcpip', (accept, reject, info) => {
    const isLoopback = info.destIP === '127.0.0.1' || info.destIP === '::1' || info.destIP === 'localhost';
    if (isLoopback) {
      const net = require('net');
      const s = net.connect({ host: info.destIP, port: info.destPort, timeout: 1500 }, () => {
        const stream = accept();
        console.log(`[SSH] TCP 转发 → ${info.destIP}:${info.destPort}(真实转发)`);
        stream.pipe(s); s.pipe(stream);
        stream.on('error', () => s.destroy());
        s.on('error', () => stream.destroy());
      });
      s.on('timeout', () => s.destroy());
      s.on('error', () => { try { reject(); } catch { /* ignore */ } }); // 本机端口没监听 → 拒绝通道
    } else {
      const stream = accept();
      console.log(`[SSH] TCP 转发 → ${info.destIP}:${info.destPort}(回显)`);
      stream.on('data', (d) => stream.write(d));
      stream.on('error', () => stream.destroy());
      stream.on('close', () => stream.destroy());
    }
  });

  client.on('session', (accept) => {
    const session = accept();
    let ptyInfo = null;
    session.on('pty', (accept, reject, info) => {
      ptyInfo = info;
      if (accept) accept();
    });
    // 窗口尺寸变化由客户端发起(setWindow 是 Client-only 方法),服务端被动接收
    session.on('window-change', (accept, reject, info) => {
      ptyInfo = info;
      if (accept) accept();
    });
    session.on('shell', (accept) => {
      if (!sessionInfo) {
        console.log('[SSH] 会话请求但没有认证信息,拒绝');
        if (accept) accept().end();
        return;
      }
      const stream = accept();
      const audit = makeAudit(sessionInfo);
      console.log(`[SSH] 会话开始: ${sessionInfo.jmsUser}@${sessionInfo.asset.name} 终端=${ptyInfo ? `${ptyInfo.cols}x${ptyInfo.rows}` : 'unknown'}`);
      createFakeShell(stream, sessionInfo, audit);
      stream.on('close', () => {
        console.log(`[SSH] 会话结束: ${sessionInfo.jmsUser}@${sessionInfo.asset.name}`);
        audit.close();
      });
    });
    session.on('exec', (accept, reject, info) => {
      // 支持 exec 命令模式(真实 KoKo 网关也支持):app 的 SFTP 家目录探测靠 exec('pwd')
      // 拿登录目录。这里 pwd 返回与 SFTP VFS 根一致的 '/',其余命令回显演示。
      // 另模拟"打包上传"的三条命令:探测 / 远端解压 / 清理压缩包。VFS 是磁盘后备的,
      // 远端绝对路径 → 磁盘绝对路径后对真实文件跑 tar,让 verify-pack-upload 能全链路验证。
      const stream = accept();
      const cmd = String(info.command || '').trim();
      const toDisk = (rp) => (rp === '/' ? MOCK_DISK_ROOT : path.join(MOCK_DISK_ROOT, rp.replace(/^\/+/, '')));
      const q = (p) => `'${p.replace(/'/g, `'\\''`)}'`;
      if (mockPackEnabled && /^command -v tar\b/.test(cmd)) {
        // 打包上传探测:远端有 tar+gzip → 回显标记(真实 Linux 上由 command -v 判断)
        stream.write('POLARIS_PACK_OK\r\n');
        stream.exit(0); stream.end(); return;
      }
      const rmM = cmd.match(/^rm -f '([^']*)'$/);
      if (rmM) {
        try { fs.rmSync(toDisk(rmM[1]), { force: true }); } catch { /* ignore */ }
        stream.exit(0); stream.end(); return;
      }
      const xt = cmd.match(/^mkdir -p '([^']*)' && tar -xzf '([^']*)' -C '\1' && rm -f '\2'$/);
      if (xt) {
        const dir = toDisk(xt[1]), archive = toDisk(xt[2]);
        try {
          fs.mkdirSync(dir, { recursive: true });
          require('child_process').execSync(`tar -xzf ${q(archive)} -C ${q(dir)}`, { stdio: 'ignore' });
          fs.rmSync(archive, { force: true }); // 解压成功删压缩包(与真实命令一致)
          stream.exit(0);
        } catch { stream.exit(1); } // 解压失败 → app 会清压缩包 + 回退递归上传
        stream.end(); return;
      }
      if (cmd === 'pwd' || cmd === 'pwd -L' || cmd === 'pwd -P') {
        stream.write('/\r\n'); // 与 sftp-vfs 根一致:家目录探测 → '/' 可访问
      } else {
        stream.write(`(mock) exec: ${cmd}\r\n`);
      }
      stream.exit(0);
      stream.end();
    });
    session.on('sftp', (accept) => {
      // SFTP 子系统:ssh2 会把 sftp 请求解析成一个个协议事件(OPEN/READ/READDIR...),
      // sftp-vfs 就是这些事件的应答者——在内存假文件树上完成浏览/上传/下载。
      const sftpStream = accept();
      createSftpServer(sftpStream);
      console.log('[SSH] SFTP 会话开始(内存虚拟磁盘)');
    });
  });

  client.on('error', (err) => {
    console.log('[SSH] 客户端错误:', err.message);
  });
});

function start() {
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`[MOCK] HTTP 端口 ${HTTP_PORT} 被占用,跳过 mock HTTP`);
    else console.error('[MOCK] HTTP 错误:', e);
  });
  sshd.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`[MOCK] SSH 端口 ${SSH_PORT} 被占用,跳过 mock SSH(不影响应用,可用 MOCK_SSH_PORT 指定其他端口)`);
      return; // 容错:不退出应用
    }
    console.error('[MOCK] SSH 错误:', e);
  });
  // 只绑 127.0.0.1:mock 是本地测试工具,绑 0.0.0.0 会让内网任何机器可连,
  // 配合硬编码凭据/任意公钥认证甚至能借它当枢轴访问开发机(localhost 服务)
  server.listen(HTTP_PORT, '127.0.0.1', () => {
    console.log(`[MOCK] JumpServer HTTP API 已启动: http://127.0.0.1:${HTTP_PORT}`);
    console.log(`[MOCK]   登录接口  POST /api/v1/authentication/auth/`);
    console.log(`[MOCK]   资产接口  GET  /api/v1/assets/assets/`);
  });
  sshd.listen(SSH_PORT, '127.0.0.1', () => {
    console.log(`[MOCK] KoKo SSH 网关已启动: 127.0.0.1:${SSH_PORT}`);
    console.log(`[MOCK]   直连格式  ssh -p ${SSH_PORT} 'admin@root@192.168.10.10'@127.0.0.1`);
    console.log(`[MOCK]   测试账号  admin/admin123 · ops/ops123`);
    console.log(`[MOCK]   审计日志  ${LOG_DIR}/audit-*.log`);
  });
}

module.exports = { start, USERS, ASSETS, parseDirectUser };

if (require.main === module) {
  start();
}
