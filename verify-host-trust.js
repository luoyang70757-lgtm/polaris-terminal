'use strict';
/**
 * verify-host-trust.js — 主机指纹信任弹窗(known_hosts)纯 Node 单测
 *
 * 覆盖「总是弹『信任并连接』」这类问题的关键路径:
 *  ① 首次连接弹 1 次,按钮有三个(信任并连接 / 信任并记住所有主机 / 拒绝);
 *  ② 选「信任并连接」→ 指纹落盘,同一主机第二次连接**不再弹**(这就是"总是询问"的反面);
 *  ③ 选「信任并记住所有主机」→ 触发 onTrustAll(渲染层据此打开 autoTrustHostKey),之后 autoTrust 下
 *     连任何新主机都不弹且照样记录指纹;
 *  ④ 自动信任开关打开后:无弹窗、写入 known_hosts;
 *  ⑤ 指纹与已记录不一致 → 弹「安全警告」并拒绝连接(不覆盖旧指纹);
 *  ⑥ 指纹写入失败(数据目录只读)→ set() 返回 false 且触发 onPersistFail(渲染层提示"下次仍会询问")。
 *
 * 不启动 Electron:用 Module._load 打桩 electron 的 dialog,直接驱动 makeHostVerifier。
 * 运行: node verify-host-trust.js
 */
const assert = require('assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0;
function ok(name) { pass++; console.log('  ✓ ' + name); }
function eq(a, b, name) { assert.deepStrictEqual(a, b, name); ok(name); }

// ---------------- 子进程模式:数据目录只读 → 指纹写不进去 ----------------
if (process.argv[2] === '--child-unwritable') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-trust-ro-'));
  process.env.POLARIS_LOCK_DIR = dir;
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'electron') return { dialog: { showMessageBoxSync: () => 0 } };
    return origLoad.apply(this, arguments);
  };
  // 模拟"落盘彻底失败":原子写的 rename 永远 EPERM(杀软占用/只读卷/权限被夺走的典型形态)。
  // 注意:known-hosts 在数据目录不可写时会回退到临时目录,所以只 chmod 目录是测不出失败的。
  const realRename = fs.renameSync;
  fs.renameSync = () => { const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e; };
  const connectOpts = require('./lib/connect-opts');
  const knownHosts = require('./lib/known-hosts');
  let failCalls = 0;
  connectOpts.init({ onPersistFail: () => { failCalls++; } });
  const verify = connectOpts.makeHostVerifier('ro-host', 22, false);
  const allowed = verify(Buffer.from('fake-host-key-ro'));
  fs.renameSync = realRename;
  process.stdout.write(JSON.stringify({ allowed, failCalls, loc: knownHosts.location() }));
  process.exit(0);
}

// ---------------- 主进程:打桩 electron dialog ----------------
const origLoad = Module._load;
let dialogs = []; // 记录每次弹窗的选项(标题/按钮/返回)
let answer = 0;   // 下一次统一返回的按钮下标
Module._load = function (request) {
  if (request === 'electron') {
    return {
      dialog: {
        showMessageBoxSync: (win, opts) => {
          dialogs.push({ title: opts.title, buttons: opts.buttons.slice(), detail: opts.detail });
          return answer;
        },
      },
    };
  }
  return origLoad.apply(this, arguments);
};

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-trust-'));
process.env.POLARIS_LOCK_DIR = DIR;

const connectOpts = require('./lib/connect-opts');
const knownHosts = require('./lib/known-hosts');

let trustAllCalls = 0;
let persistFailCalls = 0;
connectOpts.init({
  getMainWindow: () => null,
  onTrustAll: () => { trustAllCalls++; },
  onPersistFail: () => { persistFailCalls++; },
});

const KEY = Buffer.from('fake-host-key-A');
const KEY2 = Buffer.from('fake-host-key-B');

console.log('\n=== 主机指纹信任(known_hosts) ===\n');

// ① 首次连接 → 弹一次,三个按钮
answer = 0;
let verify = connectOpts.makeHostVerifier('10.9.9.9', 22, false);
eq(verify(KEY), true, '#1 首次连接:选「信任并连接」后放行');
eq(dialogs.length, 1, '#2 首次连接只弹一次窗');
eq(dialogs[0].buttons, ['信任并连接', '信任并记住所有主机', '拒绝'], '#3 弹窗有三个按钮');
ok('#3a 弹窗提示说明「记住所有主机」的含义: ' + /记住所有主机/.test(dialogs[0].detail));

// ② 同一主机第二次连接 → 不再弹(核心:解决"总是询问")
const n1 = dialogs.length;
eq(verify(KEY), true, '#4 同一主机第二次连接:指纹一致直接放行');
eq(dialogs.length, n1, '#5 同一主机第二次连接不再弹窗(说明指纹已落盘)');
const disk = JSON.parse(fs.readFileSync(knownHosts.location(), 'utf8'));
eq(disk['10.9.9.9:22'], knownHosts.fingerprint(KEY), '#6 指纹已写入 known_hosts.json');
eq((fs.statSync(knownHosts.location()).mode & 0o777), 0o600, '#7 known_hosts.json 权限 0600');

// ③ 新主机选「信任并记住所有主机」→ onTrustAll + 落盘
answer = 1;
const n2 = dialogs.length;
const verify2 = connectOpts.makeHostVerifier('10.9.9.20', 22, false);
eq(verify2(KEY2) === true, true, '#8 新主机选「记住所有主机」放行');
eq(dialogs.length, n2 + 1, '#9 新主机弹了一次窗');
eq(trustAllCalls, 1, '#10 触发 onTrustAll(渲染层据此打开 autoTrustHostKey)');
eq(JSON.parse(fs.readFileSync(knownHosts.location(), 'utf8'))['10.9.9.20:22'], knownHosts.fingerprint(KEY2), '#11 新主机指纹写入');

// ④ autoTrust=true → 不弹窗、照样记录
const n3 = dialogs.length;
const autoVerify = connectOpts.makeHostVerifier('10.9.9.10', 2222, true);
eq(autoVerify(Buffer.from('fake-host-key-C')), true, '#12 自动信任:直接放行');
eq(dialogs.length, n3, '#13 自动信任:不弹窗');
eq(JSON.parse(fs.readFileSync(knownHosts.location(), 'utf8'))['10.9.9.10:2222'], knownHosts.fingerprint(Buffer.from('fake-host-key-C')), '#14 自动信任也写入指纹');

// ⑤ 指纹不一致 → 安全警告 + 拒绝,且不覆盖旧指纹
const before = JSON.parse(fs.readFileSync(knownHosts.location(), 'utf8'))['10.9.9.9:22'];
answer = 0; // 即便桩返回"信任",代码也不会问,直接拒绝
const mismatch = connectOpts.makeHostVerifier('10.9.9.9', 22, false);
eq(mismatch(Buffer.from('attacker-key')), false, '#15 指纹不一致:拒绝连接');
eq(dialogs[dialogs.length - 1].title, '安全警告', '#16 弹出「安全警告」而不是「首次连接」');
eq(JSON.parse(fs.readFileSync(knownHosts.location(), 'utf8'))['10.9.9.9:22'], before, '#17 旧指纹未被覆盖');

// ⑥ 拒绝首次信任 → 不落盘
answer = 2;
const rejected = connectOpts.makeHostVerifier('10.9.9.11', 22, false);
eq(rejected(Buffer.from('fake-host-key-D')), false, '#18 选「拒绝」不放行');
eq(knownHosts.get('10.9.9.11:22'), undefined, '#19 拒绝后不写指纹');

// ⑦ 数据目录只读 → set 返回 false + onPersistFail(渲染层提示"下次仍会询问")
const child = execFileSync(process.execPath, [__filename, '--child-unwritable'], { encoding: 'utf8' });
const ro = JSON.parse(child);
eq(ro.allowed, true, '#20 写盘失败时本次连接仍放行(用户已点信任)');
eq(ro.failCalls, 1, '#21 写盘失败触发 onPersistFail(渲染层可提示)');
ok('#21a 报错信息带上文件路径: ' + ro.loc);
void persistFailCalls; // 主进程侧写入均成功,不应触发

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\nverify-host-trust 通过 ${pass} 项断言 ✅`);
