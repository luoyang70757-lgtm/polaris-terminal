'use strict';
/**
 * fake-shell.js — mock 目标资产上的"假 shell"
 * 用于在本地模拟真实服务器,让 POC 无需真实资产即可演示 SSH 会话。
 *
 * 重要:这个 shell 的文件系统 = SFTP 的磁盘根目录(mock/sftp-root/)。
 * 所以在 SFTP 面板里改的文件,在终端里 ls / cat 能看到同一个结果——
 * 不再出现"SFTP 保存了但命令行看不到"的割裂。
 */

const fs = require('fs');
const path = require('path');

const SFTP_ROOT = path.join(__dirname, 'sftp-root'); // 和 sftp-vfs 共用同一份"磁盘"

const OS_HINTS = {
  'web-server-01': { hostname: 'web01', os: 'Linux web01 5.15.0-91-generic #101-Ubuntu SMP', distro: 'Ubuntu 22.04.3 LTS' },
  'db-server-01': { hostname: 'db01', os: 'Linux db01 3.10.0-1160.el7.x86_64 #1 SMP', distro: 'CentOS Linux 7 (Core)' },
  'app-server-02': { hostname: 'app02', os: 'Linux app02 6.1.0-13-amd64 #1 SMP PREEMPT_DYNAMIC', distro: 'Debian GNU/Linux 12 (bookworm)' },
};
const DEFAULT_HINT = { hostname: 'unknown', os: 'Linux unknown', distro: 'Generic Linux' };

// 列出 SFTP 磁盘根目录(和 SFTP 面板看到的完全一致)
function listRoot() {
  try {
    return fs.readdirSync(SFTP_ROOT).map((name) => {
      const full = path.join(SFTP_ROOT, name);
      const st = fs.statSync(full);
      return { name, size: st.size, dir: st.isDirectory(), mtime: st.mtimeMs };
    });
  } catch {
    return [];
  }
}

function createFakeShell(stream, session, audit) {
  const hint = OS_HINTS[session.asset.name] || DEFAULT_HINT;
  const user = session.account;
  let cwd = '/'; // 与 SFTP 根目录一致
  const history = [];

  const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    green: '\x1b[32m', blue: '\x1b[34m', cyan: '\x1b[36m',
    yellow: '\x1b[33m', red: '\x1b[31m', magenta: '\x1b[35m',
  };

  function out(s) {
    stream.write(s);
    audit.out(s);
  }

  function prompt() {
    return `${C.green}${user}@${hint.hostname}${C.reset}:${C.blue}${cwd}${C.reset}${C.bold}$${C.reset} `;
  }

  function banner() {
    out(`${C.bold}${hint.distro}${C.reset} ${hint.hostname} ${hint.os}\r\n`);
    out(`${C.dim}mock asset: ${session.asset.name} (${session.asset.address})  ·  session via JumpServer KoKo (audited)${C.reset}\r\n\r\n`);
    out(`输入 ${C.yellow}help${C.reset} 查看可用命令。\r\n`);
  }

  function runCmd(line) {
    const [rawCmd, ...args] = line.trim().split(/\s+/);
    const cmd = (rawCmd || '').toLowerCase();
    switch (cmd) {
      case 'help':
        out(`${C.bold}可用命令(mock 演示):${C.reset}\r\n`);
        ['help', 'whoami', 'pwd', 'ls [-l]', 'date', 'echo <text>', 'uname -a', 'cat <file>', 'history', 'clear', 'exit / logout', 'ssh <ip> (模拟跳转到其他资产)'].forEach((c) => {
          out(`  ${C.cyan}${c}${C.reset}\r\n`);
        });
        break;
      case 'whoami':
        out(`${user}\r\n`);
        break;
      case 'pwd':
        out(`${cwd}\r\n`);
        break;
      case 'ls': {
        const long = args.includes('-l') || args.includes('-la') || args.includes('-al');
        for (const f of listRoot()) {
          const perms = f.dir ? 'drwxr-xr-x' : '-rw-r--r--';
          const size = String(f.size).padStart(8, ' ');
          const name = f.dir ? `${C.blue}${f.name}/${C.reset}` : `${C.reset}${f.name}${C.reset}`;
          out(`${long ? `${perms} 1 ${user} ${user} ${size} Jan  1 09:00 ` : ''}${name}\r\n`);
        }
        break;
      }
      case 'date':
        out(new Date().toString() + '\r\n');
        break;
      case 'echo':
        out(args.join(' ') + '\r\n');
        break;
      case 'uname':
        if (args.includes('-a')) out(`${hint.os}\r\n`);
        else out('Linux\r\n');
        break;
      case 'cat': {
        // 读的就是 SFTP 磁盘根目录里的文件(和 SFTP 面板共用一份数据)
        const f = listRoot().find((x) => x.name === args[0]);
        if (!f) { out(`${C.red}cat: ${args[0]}: No such file or directory${C.reset}\r\n`); break; }
        if (f.dir) { out(`${C.red}cat: ${args[0]}: Is a directory${C.reset}\r\n`); break; }
        try {
          let text = fs.readFileSync(path.join(SFTP_ROOT, f.name), 'utf8');
          if (!text.endsWith('\n')) text += '\n';
          out(text.replace(/\n/g, '\r\n'));
        } catch {
          out(`${C.dim}... (无法读取)${C.reset}\r\n`);
        }
        break;
      }
      case 'history':
        history.forEach((h, i) => out(`${String(i + 1).padStart(4)}  ${h}\r\n`));
        break;
      case 'clear':
        out('\x1b[2J\x1b[H');
        break;
      case 'exit':
      case 'logout':
        out('Connection to JumpServer KoKo closed.\r\n');
        stream.exit(0);
        return;
      case 'ssh': {
        // 模拟从一个资产跳转到另一个资产(只换 hostname/OS 展示,文件系统不变)
        const target = args[0];
        out(`${C.yellow}模拟跳板:ssh ${target} (真实环境由 KoKo 转发到目标资产)${C.reset}\r\n`);
        const keys = Object.keys(OS_HINTS);
        const pick = keys[Math.floor(Math.random() * keys.length)];
        const next = OS_HINTS[pick];
        hint.hostname = next.hostname;
        hint.os = next.os;
        hint.distro = next.distro;
        break;
      }
      default:
        if (cmd === '') break;
        out(`${C.red}bash: ${rawCmd}: command not found${C.reset}\r\n`);
        out(`${C.dim}(mock 环境只支持 help 列出的命令)${C.reset}\r\n`);
    }
  }

  banner();

  let buf = '';
  stream.on('data', (d) => {
    const s = d.toString();
    audit.in(s);
    for (const ch of s) {
      if (ch === '\r' || ch === '\n') {
        if (buf.trim()) {
          history.push(buf.trim());
          runCmd(buf);
          audit.cmd(buf.trim());
        }
        buf = '';
        out(prompt());
      } else if (ch === '\x7f' || ch === '\b') {
        if (buf.length > 0) { buf = buf.slice(0, -1); out('\b \b'); }
      } else if (ch === '\x03') { // Ctrl+C
        buf = '';
        out('^C\r\n');
        out(prompt());
      } else if (ch === '\x1b') {
        // 忽略方向键等 ANSI 序列(简化的行编辑器)
      } else if (ch >= ' ') {
        buf += ch;
        out(ch);
      }
    }
  });

  stream.on('close', () => { audit.close(); });
  stream.on('error', () => { audit.close(); });

  // PTY 窗口尺寸变化(真实场景会发送 SIGWINCH)
  stream.on('resize', () => {});
}

module.exports = { createFakeShell };
