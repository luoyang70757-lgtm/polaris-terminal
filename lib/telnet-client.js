'use strict';
/**
 * telnet-client.js — 最小 Telnet 客户端
 *
 * Telnet(NVT)其实很薄:TCP 上跑字节流,特殊字节 255(IAC)后面跟协商命令。
 * 这个客户端只做四件事:
 *   1. 建 raw TCP 连接(默认端口 23,零依赖,用 Node 内置 net)
 *   2. 把服务器发来的 IAC 协商序列从输出里剥掉(否则 \xff\xfd\x01 会变终端乱码)
 *   3. 回 IAC 响应(ECHO 回显 / SGA 抑制 Go-Ahead / NAWS 窗口大小;不认识的选项一律拒绝)
 *   4. 登录宏:检测设备的 login:/password: 提示,自动发送配置的账号密码
 *
 * 复用约定:数据交给调用方后走主进程统一的 pushSshData 管线(录制/会话日志/GBK 转码
 * 都按 sessionId 路由,与 SSH 共用);这里只负责"连上 + 发字节 + 收字节"。
 */

const net = require('net');
const iconv = require('iconv-lite'); // 输入按会话编码发送(GBK 设备不能恒发 UTF-8)

// ---- Telnet 协议常量 ----
const IAC = 255;  // Interpret As Command
const DONT = 254, DO = 253, WONT = 252, WILL = 251;
const SB = 250, SE = 240;      // 子协商开始/结束
const OPT_ECHO = 1;
const OPT_SGA = 3;             // Suppress Go-Ahead(抑制 Go-Ahead,标准 NVT 换行更稳)
const OPT_NAWS = 31;           // Negotiate About Window Size(全屏程序 vi/top 需要)

/**
 * 剥离一段缓冲区里的 IAC 序列,并对需要回应的协商发出响应。
 * @param {Buffer} buf — 待解析数据(可能含不完整的 IAC 尾部,由调用方累积)
 * @param {(cmd:number, opt:number)=>void} send — 协商响应回调
 * @returns {{ text: Buffer, rest: Buffer }} text=已剥离的数据,rest=未消费的尾部(等下一块续上)
 */
function stripIac(buf, send) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b !== IAC) { out.push(b); i++; continue; }
    if (i + 1 >= buf.length) break;             // 缺命令字节,等下一块
    const cmd = buf[i + 1];
    if (cmd === IAC) { out.push(IAC); i += 2; continue; } // 字面量 255
    if (cmd === SB) {
      // 子协商:跳过直到 IAC SE
      let j = i + 2;
      while (j < buf.length - 1 && !(buf[j] === IAC && buf[j + 1] === SE)) j++;
      if (j >= buf.length - 1) break;           // 缺 SE,等下一块
      i = j + 2; continue;
    }
    if (cmd === WILL || cmd === WONT || cmd === DO || cmd === DONT) {
      if (i + 2 >= buf.length) break;           // 缺选项字节,等下一块
      send(cmd, buf[i + 2]);
      i += 3; continue;
    }
    // 其他单字节命令(NOP/DM/IP/AO/AYT/EL/GA...):忽略
    i += 2; continue;
  }
  return { text: Buffer.from(out), rest: buf.slice(i) };
}

/**
 * 建立一个 Telnet 连接。
 * @param {object} o
 *   host, port(默认 23), timeoutMs(连接超时,默认 15000), cols, rows
 *   autoLogin {username, password} | null — 检测 login:/password: 提示自动发送
 *   onConnect(), onData(Buffer), onError(Error), onClose()
 * @returns {object} { write(buf), resize(cols, rows), destroy() }
 */
function connect(o) {
  const sock = net.connect({ host: o.host, port: o.port || 23 });
  sock.setNoDelay(true);
  const client = {
    localEcho: false,      // 服务器要求我们回显时为 true(网络设备常见)
    _naws: false,          // 服务器是否接受了 NAWS 协商
    _cols: o.cols || 120,
    _rows: o.rows || 32,
    _buf: Buffer.alloc(0), // 未消费完的 IAC 尾部
    _match: '',            // 最近输出(滚窗),用于跨块匹配 login:/password: 提示
    _autoStage: 0,         // 自动登录阶段:0=等账号提示,1=等密码提示,2=完成
  };

  const send = (buf) => { try { sock.write(buf); } catch { /* 已断开 */ } };
  const sendNeg = (cmd, opt) => send(Buffer.from([IAC, cmd, opt]));

  // 协商响应:按选项决定答应/拒绝
  function negotiate(cmd, opt) {
    switch (opt) {
      case OPT_ECHO:
        if (cmd === WILL) { sendNeg(DO, OPT_ECHO); client.localEcho = false; }       // 服务器回显 → 好
        else if (cmd === DO) { sendNeg(WILL, OPT_ECHO); client.localEcho = true; }   // 要我们回显 → 照做
        break;
      case OPT_SGA:
        if (cmd === WILL || cmd === DO) sendNeg(DO, OPT_SGA); // 双方都抑制 Go-Ahead
        break;
      case OPT_NAWS:
        if (cmd === DO) { client._naws = true; sendNaws(); }  // 服务器接受了窗口大小 → 发当前尺寸
        break;
      default:
        // 不认识的选项一律拒绝,免得服务器死等协商
        if (cmd === DO) sendNeg(WONT, opt);
        else if (cmd === WILL) sendNeg(DONT, opt);
    }
  }

  function sendNaws() {
    if (!client._naws) return;
    const c = Math.max(1, Math.min(65535, client._cols));
    const r = Math.max(1, Math.min(65535, client._rows));
    send(Buffer.from([IAC, SB, OPT_NAWS, (c >> 8) & 255, c & 255, (r >> 8) & 255, r & 255, IAC, SE]));
  }

  // 自动登录:提示符匹配(ASCII,跨块用滚窗);发完账号密码就不再干预
  function maybeAutoLogin(text) {
    if (!o.autoLogin || client._autoStage === 2) return;
    client._match = (client._match + text.toString('latin1').toLowerCase()).slice(-200);
    if (client._autoStage === 0 && /(login|username)\s*[:： ]/.test(client._match)) {
      client._autoStage = 1;
      client.write(String(o.autoLogin.username || '') + '\r');
    } else if (client._autoStage === 1 && /password\s*[:：]/.test(client._match)) {
      client._autoStage = 2;
      client.write(String(o.autoLogin.password || '') + '\r');
    }
  }

  // 写数据:NVT 行结束 = CR LF,把 Enter(\r) 映射过去;本地回显时把输入回显给用户。
  // 编码:GBK/GB2312 会话输入按会话编码发送(恒发 UTF-8 会让 GBK 设备解出乱码);
  // 本地回显也用同一编码,这样回显经 pushSshData 的 GBK 解码后显示正常。
  const _enc = () => (o.encoding && o.encoding !== 'utf8') ? o.encoding : null;
  client.write = (data) => {
    let s = String(data);
    if (s.includes('\r')) s = s.replace(/\r(?!\n)/g, '\r\n');
    const enc = _enc();
    send(enc ? iconv.encode(s, enc) : Buffer.from(s));
    if (client.localEcho) {
      const echoStr = s.replace(/\r\n/g, '\n');
      const echo = enc ? iconv.encode(echoStr, enc) : Buffer.from(echoStr); // 回显里 Enter 只换一行
      if (o.onData) o.onData(echo);
    }
  };

  // 窗口尺寸变更 → 若服务器接受了 NAWS 就发新尺寸(全屏程序自动重排)
  client.resize = (cols, rows) => {
    client._cols = cols || client._cols;
    client._rows = rows || client._rows;
    if (client._naws) sendNaws();
  };

  client.destroy = () => { try { sock.destroy(); } catch { /* ignore */ } };

  // ---- 连接生命周期 ----
  sock.on('connect', () => {
    sock.setTimeout(0); // 连上后不再因静默断开(设备可能长时间没输出)
    sendNeg(WILL, OPT_SGA);   // 请求抑制 Go-Ahead
    sendNeg(WILL, OPT_NAWS);  // 声明支持窗口大小
    if (o.onConnect) o.onConnect();
  });
  sock.on('data', (chunk) => {
    client._buf = Buffer.concat([client._buf, chunk]);
    const { text, rest } = stripIac(client._buf, negotiate);
    client._buf = rest;
    if (text.length) {
      maybeAutoLogin(text);
      if (o.onData) o.onData(text);
    }
  });
  sock.setTimeout(o.timeoutMs || 15000); // 连接阶段超时
  sock.on('timeout', () => {
    if (sock.connecting) {
      if (o.onError) o.onError(new Error(`连接超时(${o.host}:${o.port || 23})`));
      client.destroy();
    }
  });
  sock.on('error', (err) => { if (o.onError) o.onError(err); });
  sock.on('close', () => { if (o.onClose) o.onClose(); });

  return client;
}

module.exports = { connect };
