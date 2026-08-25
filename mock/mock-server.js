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
const { Server: SSHServer } = require('ssh2');
const { createFakeShell } = require('./fake-shell');
const { createSftpServer } = require('./sftp-vfs'); // 内存虚拟磁盘 SFTP 服务

// ---------- 配置 ----------
const HTTP_PORT = parseInt(process.env.MOCK_HTTP_PORT || '8080', 10);
const SSH_PORT = parseInt(process.env.MOCK_SSH_PORT || '2222', 10);
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
      const stream = accept();
      const cmd = String(info.command || '').trim();
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
