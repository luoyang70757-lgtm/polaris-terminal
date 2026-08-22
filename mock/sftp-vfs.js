'use strict';
/**
 * mock/sftp-vfs.js — 磁盘后备的"假 SFTP 服务器"
 *
 * ssh2 服务端对 sftp 子系统返回一个"协议层"对象:它解析 SFTP 报文,
 * 把每个请求转成事件抛出来(OPEN / READ / WRITE / READDIR / MKDIR / ...)。
 * 本文件就是这些事件的"应答者"。
 *
 * 重要:这是"磁盘后备"的——真实的文件在 mock/sftp-root/ 目录里。
 * 内存树只是缓存,任何写入(保存/上传/新建/删除/重命名)都会立刻落到磁盘,
 * 所以:①保存的内容不会被 mock 重启丢掉 ②终端/外部工具看到的就是改动后的内容。
 * 这正是"保存要生效"的基础。
 */

const fs = require('fs');
const path = require('path');
const { utils } = require('ssh2');
const { STATUS_CODE } = utils.sftp;

// 假服务器的"磁盘根目录":SFTP 的 / 对应这个文件夹。
// 测试(verify-sftp-stress)可设 MOCK_SFTP_ROOT 指向临时目录,用后自清理,不污染演示磁盘。
const SEED_DIR = process.env.MOCK_SFTP_ROOT || path.join(__dirname, 'sftp-root');

// ---------- 磁盘 ↔ 内存树 ----------
// 每个节点都带 _disk(它在磁盘上的绝对路径),写操作直接落盘。
// 如果磁盘根目录还不存在(首次),先铺一份演示文件,保证开箱就有内容可玩。
function ensureSeed() {
  if (fs.existsSync(SEED_DIR)) return;
  fs.mkdirSync(SEED_DIR, { recursive: true });
  const w = (rel, content) => {
    const p = path.join(SEED_DIR, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  w('README.txt', '# Mock SFTP 演示磁盘\n\n这是一台"假服务器"的磁盘,内容存在 mock/sftp-root/ 目录。\n上传/保存的文件都会写到这里。\n');
  w('hello.txt', '你好,SFTP!\nThis is a demo file from the mock virtual disk.\n');
  w('config.yaml', 'server:\n  host: 0.0.0.0\n  port: 8080\nmode: mock\n');
  w('src/main.c', 'int main() { return 0; }\n');
  w('src/notes.md', 'lesson 4: SFTP file panel\n');
  // /tmp 目录:真实系统必备;SFTP 家目录探测"无家目录 → /tmp"时要能列出
  fs.mkdirSync(path.join(SEED_DIR, 'tmp'), { recursive: true });
}

function makeTree() {
  ensureSeed();
  const now = Math.floor(Date.now() / 1000);
  function walk(dir) {
    const children = {};
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      const mtime = Math.floor(st.mtimeMs / 1000);
      if (st.isDirectory()) children[name] = { type: 'dir', children: walk(full), mtime, _disk: full };
      else children[name] = { type: 'file', content: fs.readFileSync(full), mtime, _disk: full };
    }
    return children;
  }
  return { type: 'dir', children: walk(SEED_DIR), mtime: now, _disk: SEED_DIR };
}

// ---------- 路径工具 ----------
// 把 '/a/b'、'a/./b'、'..' 等任意形式解析成干净的段数组:['a','b'] ;根是 []
function normalize(p) {
  const out = [];
  for (const seg of String(p).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out;
}

// 沿段数组走到节点;找不到返回 null
function resolve(node, parts) {
  let cur = node;
  for (const seg of parts) {
    if (!cur || cur.type !== 'dir') return null;
    cur = cur.children[seg];
  }
  return cur || null;
}

// 父目录查找专用:沿路径必须走到"目录",中间或终点是文件都当不存在。
// (避免调用方拿文件节点当父目录后访问 .children 崩掉)
function resolveDir(node, parts) {
  const n = resolve(node, parts);
  return n && n.type === 'dir' ? n : null;
}

// 节点 → SFTP 属性对象(mode 里的 0o4xxxx = 目录位,0o10xxxx = 普通文件位)
function toAttrs(node) {
  return {
    mode: node.type === 'dir' ? 0o40755 : 0o100644,
    uid: 1000,
    gid: 1000,
    size: node.type === 'dir' ? 0 : node.content.length,
    atime: node.mtime,
    mtime: node.mtime,
  };
}

// ---------- 会话句柄(OpenSSH 语义:操作目录/文件前先 OPEN,拿一个 handle) ----------
let handleSeq = 0;
const handles = new Map(); // handleId -> { kind: 'dir'|'file', ... }

function allocHandle(obj) {
  const id = ++handleSeq;
  handles.set(id, obj);
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(id); // 4 字节数字当"句柄"回给客户端
  return buf;
}
function getHandle(buf) {
  if (!buf || buf.length < 4) return null;
  return handles.get(buf.readUInt32BE(0));
}
function freeHandle(buf) {
  if (buf && buf.length >= 4) handles.delete(buf.readUInt32BE(0));
}

// ---------- 主入口:给一个 sftp 协议流挂上所有应答器 ----------
function createSftpServer(sftpStream) {
  const root = makeTree(); // 每次连接从磁盘重建(内存树是磁盘的镜像)

  // 文件内容变了 → 立刻写回磁盘(这就是"保存生效"的关键)
  function persistFile(node) {
    try {
      fs.mkdirSync(path.dirname(node._disk), { recursive: true });
      fs.writeFileSync(node._disk, node.content);
    } catch { /* 磁盘写失败不阻塞协议应答 */ }
  }

  sftpStream.on('REALPATH', (reqid, p) => {
    const node = resolve(root, normalize(p));
    if (!node) return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE); // 不存在:与真实 OpenSSH 一致返回错误(否则 toAttrs(null) 崩)
    const abs = '/' + normalize(p).join('/');
    sftpStream.name(reqid, [{ filename: abs, longname: abs, attrs: toAttrs(node) }]);
  });

  sftpStream.on('OPENDIR', (reqid, p) => {
    const node = resolve(root, normalize(p));
    if (!node || node.type !== 'dir') return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    const names = Object.entries(node.children).map(([name, child]) => ({
      filename: name,
      longname: (child.type === 'dir' ? 'drwxr-xr-x' : '-rw-r--r--') + ` 1 admin admin ${child.type === 'dir' ? 0 : child.content.length} Jan  1 09:00 ${name}`,
      attrs: toAttrs(child),
    }));
    sftpStream.handle(reqid, allocHandle({ kind: 'dir', listed: false, names }));
  });

  sftpStream.on('READDIR', (reqid, handle) => {
    const h = getHandle(handle);
    if (!h || h.kind !== 'dir') return sftpStream.status(reqid, STATUS_CODE.FAILURE);
    if (h.listed) return sftpStream.status(reqid, STATUS_CODE.EOF);
    h.listed = true;
    sftpStream.name(reqid, h.names);
  });

  sftpStream.on('CLOSEDIR', (reqid, handle) => {
    freeHandle(handle);
    sftpStream.status(reqid, STATUS_CODE.OK);
  });

  sftpStream.on('STAT', (reqid, p) => {
    const node = resolve(root, normalize(p));
    if (!node) return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    sftpStream.attrs(reqid, toAttrs(node));
  });
  sftpStream.on('LSTAT', (reqid, p) => sftpStream.emit('STAT', reqid, p));

  sftpStream.on('OPEN', (reqid, p, flags) => {
    const parts = normalize(p);
    const parent = resolveDir(root, parts.slice(0, -1));
    const name = parts[parts.length - 1];
    const node = parent ? parent.children[name] : undefined;
    const wantWrite = !!(flags & 0x00000008); // OPEN_MODE.TRUNC(写模式:创建/截断)

    if (wantWrite) {
      // 写模式:没有就新建空文件,有就截断清空(同时落到磁盘)
      if (!parent) return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
      const disk = path.join(parent._disk, name);
      try { fs.mkdirSync(parent._disk, { recursive: true }); fs.writeFileSync(disk, ''); } catch { /* ignore */ }
      parent.children[name] = { type: 'file', content: Buffer.alloc(0), mtime: Math.floor(Date.now() / 1000), _disk: disk };
      return sftpStream.handle(reqid, allocHandle({ kind: 'file', node: parent.children[name], pos: 0 }));
    }
    // 读模式:文件必须存在且不是目录
    if (!node || node.type !== 'file') return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    sftpStream.handle(reqid, allocHandle({ kind: 'file', node, pos: 0 }));
  });

  sftpStream.on('READ', (reqid, handle, offset, len) => {
    const h = getHandle(handle);
    if (!h || h.kind !== 'file') return sftpStream.status(reqid, STATUS_CODE.FAILURE);
    const buf = h.node.content;
    if (offset >= buf.length) return sftpStream.status(reqid, STATUS_CODE.EOF);
    const chunk = buf.slice(offset, offset + len);
    sftpStream.data(reqid, chunk);
  });

  sftpStream.on('WRITE', (reqid, handle, offset, data) => {
    const h = getHandle(handle);
    if (!h || h.kind !== 'file') return sftpStream.status(reqid, STATUS_CODE.FAILURE);
    const end = offset + data.length;
    if (end > h.node.content.length) {
      const bigger = Buffer.alloc(end);
      h.node.content.copy(bigger);
      h.node.content = bigger;
    }
    data.copy(h.node.content, offset);
    h.node.mtime = Math.floor(Date.now() / 1000);
    persistFile(h.node); // ← 保存到磁盘,这样"保存"才是真的生效
    sftpStream.status(reqid, STATUS_CODE.OK);
  });

  sftpStream.on('CLOSE', (reqid, handle) => {
    freeHandle(handle);
    sftpStream.status(reqid, STATUS_CODE.OK);
  });

  // ssh2 createWriteStream 打开文件后总会先 fchmod;真实 OpenSSH 支持,这里补上避免挂起
  sftpStream.on('FSETSTAT', (reqid, handle, attrs) => {
    const h = getHandle(handle);
    if (h && h.node && attrs && typeof attrs.mode === 'number') h.node.mode = attrs.mode;
    sftpStream.status(reqid, STATUS_CODE.OK);
  });

  sftpStream.on('MKDIR', (reqid, p) => {
    const parts = normalize(p);
    const parent = resolveDir(root, parts.slice(0, -1));
    const name = parts[parts.length - 1];
    if (!parent || parent.type !== 'dir') return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    if (parent.children[name]) return sftpStream.status(reqid, STATUS_CODE.FAILURE);
    const disk = path.join(parent._disk, name);
    try { fs.mkdirSync(disk, { recursive: true }); } catch { /* ignore */ }
    parent.children[name] = { type: 'dir', children: {}, mtime: Math.floor(Date.now() / 1000), _disk: disk };
    sftpStream.status(reqid, STATUS_CODE.OK);
  });

  sftpStream.on('RMDIR', (reqid, p) => {
    const parts = normalize(p);
    const parent = resolveDir(root, parts.slice(0, -1));
    const name = parts[parts.length - 1];
    const node = parent && parent.children[name];
    if (!node) return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    if (node.type !== 'dir' || Object.keys(node.children).length > 0) return sftpStream.status(reqid, STATUS_CODE.FAILURE);
    try { fs.rmdirSync(node._disk); } catch { /* ignore */ }
    delete parent.children[name];
    sftpStream.status(reqid, STATUS_CODE.OK);
  });

  sftpStream.on('REMOVE', (reqid, p) => {
    const parts = normalize(p);
    const parent = resolveDir(root, parts.slice(0, -1));
    const name = parts[parts.length - 1];
    const node = parent && parent.children[name];
    if (!node) return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    if (node.type === 'dir') return sftpStream.status(reqid, STATUS_CODE.FAILURE);
    try { fs.rmSync(node._disk); } catch { /* ignore */ }
    delete parent.children[name];
    sftpStream.status(reqid, STATUS_CODE.OK);
  });

  sftpStream.on('RENAME', (reqid, oldPath, newPath) => {
    const oParts = normalize(oldPath);
    const nParts = normalize(newPath);
    const oParent = resolveDir(root, oParts.slice(0, -1));
    const oName = oParts[oParts.length - 1];
    const nParent = resolveDir(root, nParts.slice(0, -1));
    const nName = nParts[nParts.length - 1];
    const node = oParent && oParent.children[oName];
    if (!node || !nParent) return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    try { fs.renameSync(node._disk, path.join(nParent._disk, nName)); } catch { /* ignore */ }
    node._disk = path.join(nParent._disk, nName);
    delete oParent.children[oName];
    nParent.children[nName] = node;
    sftpStream.status(reqid, STATUS_CODE.OK);
  });
}

module.exports = { createSftpServer };
