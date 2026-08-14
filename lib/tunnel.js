'use strict';
/**
 * tunnel.js — SSH 隧道 / 端口转发(本地转发、远程转发、动态 SOCKS5)
 *
 * 原理:所有数据都走"已建立的 SSH 连接"(ssh2 Client 的 conn),不新建 SSH。
 *   本地转发  L:  本地监听端口 → SSH → 远程 host:port
 *   远程转发  R:  远程监听端口 ← SSH ← 本地 host:port
 *   动态 SOCKS:   本地 SOCKS5 代理,每个连接按请求目标经 SSH 转发
 *
 * 每个 start* 返回 { stop() } 用于关闭隧道。
 */

const net = require('net');

// ---- 本地转发:本地端口监听,收到连接就经 SSH 转发到 remoteHost:remotePort ----
function startLocal(conn, spec) {
  const localHost = spec.localHost || '127.0.0.1';
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      conn.forwardOut('127.0.0.1', 0, spec.remoteHost, spec.remotePort, (err, stream) => {
        if (err) { socket.destroy(); return; }
        // stream 必须挂 error 监听:SSH 断连时 forwardOut 的 stream 会抛 'error',
        // 不监听就成了 uncaughtException 且 socket 悬空(旧版 bug)
        stream.on('error', () => { try { socket.destroy(); } catch { /* ignore */ } });
        socket.on('error', () => { try { stream.destroy(); } catch { /* ignore */ } });
        socket.pipe(stream).pipe(socket); // 双向转发
      });
      socket.on('error', () => socket.destroy());
    });
    server.on('error', reject);
    server.listen(spec.localPort, localHost, () => resolve({ stop: () => server.close(), server }));
  });
}

// ---- 远程转发:让 SSH 服务器监听 remotePort,连上来就转发回本地 localHost:localPort ----
function startRemote(conn, spec) {
  const bindAddr = spec.bindAddr || '127.0.0.1'; // 远程服务器上绑定的地址
  return new Promise((resolve, reject) => {
    conn.forwardIn(bindAddr, spec.remotePort, (err) => {
      if (err) return reject(err);
      // 服务器收到连接时触发 tcp connection,把它接回本地
      const onConn = (info, accept) => {
        const stream = accept();
        const sock = net.connect(spec.localPort, spec.localHost || '127.0.0.1', () => {
          sock.pipe(stream).pipe(sock);
        });
        sock.on('error', () => stream.destroy());
        stream.on('error', () => sock.destroy());
      };
      conn.on('tcp connection', onConn);
      resolve({
        stop: () => {
          conn.removeListener('tcp connection', onConn);
          try { conn.unforwardIn(bindAddr, spec.remotePort, () => {}); } catch { /* ignore */ }
        },
      });
    });
  });
}

// ---- 动态 SOCKS5 代理:本地端口起一个 SOCKS5 服务器 ----
// 握手:客户端发 [5, 方法数, 方法...] → 回 [5, 0](无需认证)
// 请求: [5, 1, 0, ATYP, 地址, 端口] → 回成功,然后双向转发
// 解析 SOCKS5 CONNECT 请求,返回 { host, port, headerLen(请求头长度,用于转发剩余字节) }
function parseSocks5Request(buf) {
  if (buf.length < 7 || buf[0] !== 5 || buf[1] !== 1) return null; // VER/CMD 不对
  let host, offset;
  if (buf[3] === 1) { // IPv4
    host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
    offset = 8;
  } else if (buf[3] === 3) { // 域名
    const len = buf[4];
    if (buf.length < 5 + len + 2) return null;
    host = buf.slice(5, 5 + len).toString();
    offset = 5 + len;
  } else if (buf[3] === 4) { // IPv6
    if (buf.length < 20 + 2) return null;
    host = Array.from(buf.slice(4, 20)).map((b) => b.toString(16).padStart(2, '0')).join(':');
    offset = 20;
  } else {
    return null;
  }
  if (buf.length < offset + 2) return null;
  const port = buf.readUInt16BE(offset);
  return { host, port, headerLen: offset + 2 };
}
const SOCKS_SUCCESS = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
const SOCKS_FAIL = Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]); // connection refused

function startDynamic(conn, spec) {
  const localHost = spec.localHost || '127.0.0.1';
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let phase = 0; // 0=握手,1=请求
      let handBuf = Buffer.alloc(0); // 握手可能被 TCP 分段,攒够再解析
      let reqBuf = Buffer.alloc(0);  // 请求头同理
      socket.on('data', (buf) => {
        try {
          if (phase === 0) {
            handBuf = Buffer.concat([handBuf, buf]);
            if (handBuf.length < 2) return; // 还差 VER+NMETHODS
            if (handBuf[0] !== 5) { socket.destroy(); return; } // 非 SOCKS5
            const nm = handBuf[1];
            if (handBuf.length < 2 + nm) return; // 方法列表没到齐,继续等
            socket.write(Buffer.from([5, 0])); // 无需认证
            phase = 1; handBuf = null;
            return;
          }
          reqBuf = Buffer.concat([reqBuf, buf]);
          const target = parseSocks5Request(reqBuf);
          if (!target) {
            // 解析失败有两种:①协议错误(VER/CMD 不对,确定失败)②请求头没到齐(继续等)。
            // 旧版一律当失败销毁 → TCP 分段(如 TLS ClientHello 被切开)直接误判拒绝。
            if (reqBuf.length >= 2 && (reqBuf[0] !== 5 || reqBuf[1] !== 1)) {
              socket.write(SOCKS_FAIL); socket.destroy(); return;
            }
            return; // 数据不足,等更多
          }
          const leftover = reqBuf.slice(target.headerLen); // 请求头之后的先行数据
          reqBuf = null;
          conn.forwardOut('127.0.0.1', 0, target.host, target.port, (err, stream) => {
            if (err) { socket.write(SOCKS_FAIL); socket.destroy(); return; }
            socket.write(SOCKS_SUCCESS); // 成功应答
            // CONNECT 头之后可能还跟着第一批数据(如 TLS ClientHello/HTTP 请求),
            // 必须一起转发,否则会丢包
            if (leftover.length) stream.write(leftover);
            stream.on('error', () => { try { socket.destroy(); } catch { /* ignore */ } }); // SSH 断连不悬空
            socket.on('error', () => { try { stream.destroy(); } catch { /* ignore */ } });
            socket.pipe(stream).pipe(socket);
          });
        } catch { socket.destroy(); }
      });
      socket.on('error', () => socket.destroy());
    });
    server.on('error', reject);
    server.listen(spec.localPort, localHost, () => resolve({ stop: () => server.close(), server }));
  });
}

module.exports = { startLocal, startRemote, startDynamic, parseSocks5Request };
