'use strict';
/**
 * lib/connect-opts.js — SSH 连接参数共享构造
 *
 * makeHostVerifier / resolvePrivateKey / withHostVerify 被 ssh:connect 和多个
 * "一次性连接"(批量执行/AI/系统探测/导入)共用,从 main.js 抽出避免多模块重复。
 * mainWindow 延迟可用(建窗后才赋值),启动时用 init() 注入 getter。
 */
const fs = require('fs');
const { dialog } = require('electron');
const knownHosts = require('./known-hosts');

let getMainWindow = () => null;
// 通知回调(主进程注入 → 广播给渲染层):
//   onTrustAll   : 用户在信任框里选了"信任并记住所有主机" → 渲染层把 settings.autoTrustHostKey 置 true 并落盘
//   onPersistFail: 指纹写不进数据目录 → 渲染层提示"下次仍会询问 + 去检查哪个目录",避免这个 bug 无迹可查
let onTrustAll = null;
let onPersistFail = null;
/** mainWindow 延迟可用(建窗后才赋值),主进程启动早期调用注入 getter */
function init(deps) {
  if (!deps) return;
  if (typeof deps.getMainWindow === 'function') getMainWindow = deps.getMainWindow;
  if (typeof deps.onTrustAll === 'function') onTrustAll = deps.onTrustAll;
  if (typeof deps.onPersistFail === 'function') onPersistFail = deps.onPersistFail;
}

function notifyTrustAll() {
  try { onTrustAll && onTrustAll(); } catch { /* ignore */ }
}
function notifyPersistFail(id) {
  try { onPersistFail && onPersistFail(id, knownHosts.location()); } catch { /* ignore */ }
}

// 指纹校验(known_hosts):首次连接弹信任框,不匹配弹安全警告
function makeHostVerifier(host, port, autoTrust) {
  return (key) => {
    try {
      const fp = knownHosts.fingerprint(key);
      const id = `${host}:${port}`;
      const known = knownHosts.get(id);
      if (known) {
        if (known === fp) return true;
        dialog.showMessageBoxSync(getMainWindow(), {
          type: 'error', title: '安全警告',
          message: '主机密钥不匹配,可能被中间人攻击!',
          detail: `${id}\n已记录指纹: ${known}\n本次指纹:   ${fp}`,
          buttons: ['断开连接'],
        });
        return false;
      }
      // 自动信任:跳过弹窗,直接记录指纹并放行(仍写入 known_hosts,之后照常校验)
      if (autoTrust) {
        const saved = knownHosts.set(id, fp);
        console.warn(`[MAIN] 自动信任新主机 ${id}(指纹 ${fp.slice(0, 20)}…),已写入 known_hosts`);
        if (!saved) notifyPersistFail(id);
        return true;
      }
      // 三个选项:单次信任 / 信任并记住所有主机(不再询问) / 拒绝
      // 第二个选项是为了解决"每台新主机都要点一次确认":以前只能去设置里手动找"自动信任"开关
      const r = dialog.showMessageBoxSync(getMainWindow(), {
        type: 'question', title: '首次连接',
        message: `是否信任 ${host}:${port} 的主机密钥?`,
        detail: `指纹: ${fp}\n\n选"信任并记住所有主机"后,以后连接任何新主机都不再弹窗(仍会记录并校验指纹)。`,
        buttons: ['信任并连接', '信任并记住所有主机', '拒绝'],
        defaultId: 0,
        cancelId: 2,
      });
      if (r === 0 || r === 1) {
        const saved = knownHosts.set(id, fp);
        if (!saved) notifyPersistFail(id);
        if (r === 1) notifyTrustAll();
        return true;
      }
      return false;
    } catch (err) {
      console.warn('[MAIN] 指纹校验异常,拒绝连接:', err.message);
      return false;
    }
  };
}

// 把私钥文件路径换成私钥内容(ssh2 要的是内容不是路径)
function resolvePrivateKey(opts) {
  if (!opts || !opts.privateKey) return opts;
  try {
    return { ...opts, privateKey: fs.readFileSync(opts.privateKey) };
  } catch (err) {
    console.warn('[MAIN] 读取私钥失败:', err.message); // 读不到就保留路径,让 ssh2 报错更清楚
    return opts;
  }
}

// 给"一次性连接"(批量传输/AI 助手/系统探测)也自动装上指纹校验。
// 规则与 ssh:connect 一致:传了 verifyHostKey:false 就跳过,否则一律校验。
function withHostVerify(opts) {
  if (!opts || !opts.host) return opts;
  if (opts.verifyHostKey === false) return opts;
  return { ...opts, hostVerifier: makeHostVerifier(opts.host, opts.port || 22, opts.autoTrustHostKey === true) };
}

module.exports = { init, makeHostVerifier, resolvePrivateKey, withHostVerify };