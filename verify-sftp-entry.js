'use strict';
/**
 * verify-sftp-entry.js — 「SFTP 只剩一个入口 = 用本机 WinSCP 打开」(纯 Node,不启 Electron)
 *
 * v1.0.25 把内置 SFTP 面板整套删了:面板 DOM/样式、sftp:* IPC、限速/权限/编辑器、
 * 断点续传/尺寸记录模块全部移除,SFTP 只保留 openSftpEntry() → WinSCP 外链。
 * 删干净的代价是"容易删漏一半、留下点了没反应的死入口",所以这里用源码结构断言兜住:
 *   ① 渲染层/样式/桥/主进程里不许再有内置面板与 sftp:* 残留
 *   ② 入口只有一个:工具栏按钮 / ⌘⇧S / 菜单 / 标签右键 全部走 openSftpEntry()
 *   ③ WinSCP 链路仍然完整(探测/拉起/家目录兜底/起始目录只看跟踪到的 cd 目录)
 *   ④ 顺手守住「webview 的 MaxListeners 放宽」这一行(否则堡垒机面板会刷泄漏警告)
 *
 * 运行:node verify-sftp-entry.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const count = (s, sub) => s.split(sub).length - 1;

let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };
const check = (cond, name, detail) => (cond ? ok(name) : bad(name, detail));

console.log('\n=== SFTP 入口 = WinSCP(内置面板已删除) ===\n');

const html = read('src/index.html');
const css = read('src/styles.css');
const pre = read('preload.js');
const main = read('main.js');
const renderer = read('src/renderer.js');
const sshClient = read('lib/ssh-client.js');

// ---------- ① 内置面板必须删干净 ----------
const htmlGone = ['id="sftp-panel"', 'id="sftp-list"', 'id="sftp-path"', 'id="divider-h"',
  'id="attrs-modal"', 'id="edit-modal"', 'id="batch-upload"', 'id="batch-download"', 'id="set-sftp-limit"',
  'id="set-winscp-mode"', 'id="btn-sftp-win"'];
const htmlLeft = htmlGone.filter((t) => html.includes(t));
check(htmlLeft.length === 0, 'index.html 里没有内置面板/编辑器/权限弹窗/限速/三档模式的 DOM', htmlLeft.join(', '));

const cssGone = ['.sftp-panel', '.sftp-list', '.sftp-row', '.attrs-path', '.edit-card', '.divider-h {'];
const cssLeft = cssGone.filter((t) => css.includes(t));
check(cssLeft.length === 0, 'styles.css 里没有内置面板/权限/编辑器/上下分隔条的样式', cssLeft.join(', '));

// preload:除菜单 channel 'menu:sftp'(入口快捷键)外不许再有 sftp 桥
const preSftp = pre.split('\n').filter((l) => /sftp/i.test(l));
const preBad = preSftp.filter((l) => !/menu:sftp/.test(l) && !/^\s*\/\//.test(l));
check(preBad.length === 0, 'preload.js 不再暴露任何 sftp:* 桥接(只留 menu:sftp 菜单通道)', preBad.join(' | ').slice(0, 160));

check(!/ipcMain\.(handle|on)\('sftp:/.test(main), 'main.js 不再注册 sftp:* IPC');

const libSftp = fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => /^sftp-/.test(f));
check(libSftp.length === 0, 'lib/ 下 SFTP 专用模块已删除(权限/续传/限速/尺寸/进度节流)', libSftp.join(', '));

const deadRefs = ['sftp-attrs', 'sftp-partials', 'sftp-throttle', 'sftp-sizes', 'sftp-progress-throttle']
  .filter((m) => main.includes(`lib/${m}`) || renderer.includes(`lib/${m}`) || pre.includes(m));
check(deadRefs.length === 0, '没有代码还在 require 已删除的 SFTP 模块', deadRefs.join(', '));

// ---------- ② 入口只有一个,且处处指向它 ----------
check(/id="btn-sftp-toggle"/.test(html) && /用本机 WinSCP 打开当前会话的 SFTP/.test(html),
  '工具栏按钮保留(文案改成「用 WinSCP 打开」)');
check(/function openSftpEntry\(sessionId\)/.test(renderer), 'renderer 里有统一入口 openSftpEntry()');
check(/function syncSftpEntryButton\(\)/.test(renderer), 'renderer 里有按钮状态同步 syncSftpEntryButton()');
check(/els\.btnSftpToggle\.addEventListener\('click', \(\) => openSftpEntry\(\)\);/ .test(renderer),
  '工具栏按钮点击 → openSftpEntry()');

// 快捷键 / 菜单 / 标签右键 都必须收敛到同一个入口
const shortcut = renderer.match(/case 's':[\s\S]{0,120}/);
check(!!shortcut && /openSftpEntry/.test(shortcut[0]), '⌘⇧S 快捷键走 openSftpEntry()', shortcut && shortcut[0].replace(/\s+/g, ' '));
const menuItem = renderer.match(/ch === 'menu:sftp'[\s\S]{0,80}/);
check(!!menuItem && /openSftpEntry/.test(menuItem[0]), '菜单「SFTP」事件走 openSftpEntry()', menuItem && menuItem[0].replace(/\s+/g, ' '));
const tabMenu = renderer.match(/用 WinSCP 打开 SFTP[\s\S]{0,120}/);
check(!!tabMenu && /openSftpEntry/.test(tabMenu[0]), '标签右键「用 WinSCP 打开 SFTP」走 openSftpEntry()', tabMenu && tabMenu[0].replace(/\s+/g, ' '));

// 三种不能打开的情况必须在入口里给出提示(不出现"点了没反应"的假入口)
const entryBody = (renderer.match(/async function openSftpEntry\(sessionId\) \{[\s\S]*?\n\}/) || [''])[0];
check(/先连接一台主机/.test(entryBody), '入口:没连接时给提示');
check(/Telnet 没有 SFTP|仅支持 SSH/.test(entryBody), '入口:Telnet 会话给提示');
check(/没装 WinSCP/.test(entryBody), '入口:本机没装 WinSCP 时给提示(而不是静默失败)');
check(entryBody.length > 0 && !/toggleSftpPanel|state\.sftp/.test(entryBody), '入口里不再引用已删除的面板逻辑');

// 三档模式与限速设置彻底消失(老配置里残留的字段被忽略即无害)
check(!/winscpMode/.test(renderer), 'renderer 里已无 winscpMode 三档模式(含老配置迁移块)');
check(!/sftpSpeedLimitKBps|sftpPanelHeight/.test(renderer), 'renderer 里已无限速/面板高度状态');

// ---------- ③ WinSCP 链路依旧完整 ----------
check(/ipcMain\.handle\('winScp:detect'/.test(main) && /ipcMain\.handle\('winScp:open'/.test(main),
  '主进程仍提供 winScp:detect / winScp:open');
check(/async function resolveSftpHome\(sessionId\)/.test(main), '主进程仍保留家目录探测 resolveSftpHome()');
check(/sshClient\.openSftp\(s\.conn\)/.test(main), '家目录校验直接开 SFTP 通道(不再依赖已删除的面板缓存)');
check(/RemoteDirectory/.test(main) || /RemoteDirectory/.test(read('lib/winscp-open.js')), '起始目录仍以 RemoteDirectory 传给 WinSCP');
const payload = (renderer.match(/function winScpPayloadFor\(sessionId\) \{[\s\S]*?\n\}/) || [''])[0];
check(/const remotePath = t\.shellCwd/.test(payload) && /\/\^\\\/\//.test(payload),
  '起始目录只看跟踪到的绝对 cd 目录(相对/未知不传,交给主进程现探)');
check(/sshClient\.openSftp|openSftp/.test(sshClient) && !/uploadFile|downloadFile|fastPut|fastGet/.test(sshClient),
  'lib/ssh-client.js 只留连接/exec/SFTP 通道(上传下载实现已随面板删除)');

// ---------- ④ MaxListeners 放宽(堡垒机 webview 反复导航不再刷泄漏警告) ----------
check(/web-contents-created[\s\S]{0,220}setMaxListeners\(50\)/.test(main),
  '主进程给 webview 的 WebContents 放宽 MaxListeners(修 11 did-stop-loading 警告)');

console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
process.exit(failed ? 1 : 0);
