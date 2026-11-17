#!/usr/bin/env node
/**
 * verify-jms-auth-guard.js — JumpServer 登录熔断（纯 Node，不启 Electron）
 *
 * 背景（现场事故）：在堡垒机浏览器里点「🧹 清除堡垒机历史」→ persist:bastion 的 cookie 被清 → 网页掉登录；
 * 自动重登用的是**保存的错账号/旧密码**（`Admin` ≠ `admin`、密码重置后密文没更新）→ 每次点资产/拉取都扣一次
 * JumpServer 的失败次数，**8 次就把账号临时锁 30 分钟**，锁定期 Web 控制台 / API / KoKo 网关全拒 ——
 * 用户看到的现象就是「和堡垒机网络都不通了」。所以自动路径必须熔断：
 *   · 凭据错（password_failed / 用户名或密码…）→ 永久熔断，直到用户改配置或手动登录成功；
 *   · 需要 MFA → 永不自愈（自动路径给不了验证码）；
 *   · 账号被锁（user_locked）→ 等锁定窗口（30 分钟）自动解除；
 *   · 网络/服务端异常 → 60 秒短冷却（恢复后自动重来）。
 *
 * 断言来源：从 src/renderer.js 切 `JMS-AUTH-GUARD:BEGIN … END` 纯逻辑区块直接 eval（**移动/改名这段会明确报错**），
 * 再加若干结构性断言（熔断必须真的被 ensureJmsLogin 用上、成功后要清除、修改配置/删除连接要清除、不能落盘）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function ok(msg) { passed++; console.log('  ✓ ' + msg); }
function bad(msg, detail) { failed++; console.log('  ✗ ' + msg + (detail !== undefined ? ' → ' + JSON.stringify(detail) : '')); }

const RENDERER = path.join(__dirname, 'src', 'renderer.js');
const src = fs.readFileSync(RENDERER, 'utf8');

// 真实服务端文案（dev JumpServer v4.10.20-ce 实测）
const MSG_BAD_PW = '您输入的用户名或密码不正确，请重新输入。 您还可以尝试 7 次 (账号将被临时 锁定 30 分钟)';
const MSG_LOCKED = '您已输入密码错误次数过多，账号已被锁定，请30分钟后重新登录。';

console.log('\n=== JumpServer 登录熔断 ===\n');

// ① 区块可切出且是纯逻辑
const blockRe = /\/\/ ===== JMS-AUTH-GUARD:BEGIN[\s\S]*?\n([\s\S]*?)\/\/ ===== JMS-AUTH-GUARD:END =====/;
const m = blockRe.exec(src);
let api = null;
if (!m) {
  bad('renderer.js 里找不到 JMS-AUTH-GUARD:BEGIN/END 区块标记（校验脚本依赖这段纯逻辑，请勿移动/改名）');
} else {
  const block = m[1];
  try {
    api = new Function(block + `
    return { JMS_AUTH_LOCK_MIN, JMS_AUTH_NET_COOLDOWN_MS, JMS_TOKEN_MARGIN_MS, jmsAuthGuard, jmsGuardKey, jmsAuthKind, jmsGuardRecord, jmsGuardClear, jmsGuardClearById, jmsGuardBlocked, jmsGuardHint, jmsTokenExpiry, jmsTokenValid, jmsApplyLogin, jmsLoginOnce, jmsLoginInflight, jmsAuthError };`)();
    ok('JMS-AUTH-GUARD 区块可独立 eval（纯逻辑，不依赖 window/state/document）');
  } catch (e) {
    bad('JMS-AUTH-GUARD 区块 eval 失败', e.message);
  }
  const codeLines = block.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)); // 只查代码行(注释里提到 localStorage 是说明,不算依赖)
  if (/window\.|document\.|state\.|saveSettings\(|localStorage/.test(codeLines.join('\n'))) bad('熔断区块里混进了 UI/持久化依赖（必须保持纯函数、只记在内存里）');
  else ok('熔断状态只在内存（不落 localStorage / 不调 saveSettings）');
}

if (api) {
  const NOW = 1700000000000;
  const srv = (over) => Object.assign({ id: 'bastion-cfg-2', account: 'polaris', url: 'http://127.0.0.1:8080' }, over || {});

  // ② 失败分类（注意：password_failed 的文案里也带「锁定 30 分钟」，必须先判凭据错）
  const k1 = api.jmsAuthKind(MSG_BAD_PW);
  if (k1 === 'credentials') ok('密码错（文案含「还可尝试 N 次/锁定 30 分钟」）判为 credentials，不会误判成 locked');
  else bad('密码错被误分类', k1);
  const k2 = api.jmsAuthKind(MSG_LOCKED);
  if (k2 === 'locked') ok('「账号已被锁定」判为 locked');
  else bad('锁定文案分类错误', k2);
  const k3 = api.jmsAuthKind('fetch failed');
  if (k3 === 'network') ok('网络异常（fetch failed）判为 network');
  else bad('网络异常分类错误', k3);
  const k4 = api.jmsAuthKind('{"error":"password_failed"}');
  if (k4 === 'credentials') ok('原始 error 码 password_failed 也判为 credentials');
  else bad('error 码分类错误', k4);

  // ③ 凭据错 → 永久熔断（不会随时间自愈），提示带剩余次数
  const s1 = srv();
  api.jmsAuthGuard.clear();
  api.jmsGuardRecord(s1, MSG_BAD_PW, { now: NOW });
  const b1 = api.jmsGuardBlocked(s1, NOW);
  const b1late = api.jmsGuardBlocked(s1, NOW + 7 * 24 * 3600 * 1000);
  if (b1 && b1.kind === 'credentials' && b1late) ok('凭据错：1 秒后与 7 天后都仍熔断（不会白白再扣一次服务端次数）');
  else bad('凭据错熔断没有持续生效', { b1: !!b1, later: !!b1late });
  const h1 = api.jmsGuardHint(b1, NOW);
  if (/还可错 7 次/.test(h1) && /8 次/.test(h1) && /停止自动重登/.test(h1)) ok('提示把服务端剩余次数与人话建议都带上：' + h1.slice(0, 60) + '…');
  else bad('凭据错提示不完整', h1);

  // ④ 锁定 → 30 分钟后自动解除
  const s2 = srv({ id: 'jms-server-1' });
  api.jmsGuardRecord(s2, MSG_LOCKED, { now: NOW });
  const b2 = api.jmsGuardBlocked(s2, NOW);
  if (b2 && b2.kind === 'locked' && b2.until === NOW + api.JMS_AUTH_LOCK_MIN * 60000) ok('锁定：熔断窗口 = 30 分钟（与服务端默认一致）');
  else bad('锁定窗口不对', b2);
  const h2 = api.jmsGuardHint(b2, NOW);
  if (/约 30 分钟/.test(h2)) ok('锁定提示给出恢复时间：' + h2);
  else bad('锁定提示缺少时间', h2);
  if (api.jmsGuardBlocked(s2, NOW + 31 * 60000) === null) ok('锁定窗口过后自动解除（不用重启 app）');
  else bad('锁定窗口过后仍在熔断');

  // ⑤ 网络异常 → 60 秒冷却
  const s3 = srv({ id: 'jms-server-2' });
  api.jmsGuardRecord(s3, 'fetch failed', { now: NOW });
  const h3 = api.jmsGuardHint(api.jmsAuthGuard.get(api.jmsGuardKey(s3)), NOW);
  if (api.jmsGuardBlocked(s3, NOW) && api.jmsGuardBlocked(s3, NOW + 61 * 1000) === null) ok('网络类失败只冷却 60 秒，恢复后自动重来');
  else bad('网络类冷却语义不对');
  if (/秒后自动重试/.test(h3)) ok('网络类提示是「N 秒后自动重试」：' + h3);
  else bad('网络类提示不对', h3);

  // ⑥ MFA：永不自愈 + 专门文案
  const s4 = srv({ id: 'jms-server-3' });
  api.jmsGuardRecord(s4, 'mfa', { kind: 'mfa', now: NOW });
  const b4 = api.jmsGuardBlocked(s4, NOW + 24 * 3600 * 1000);
  if (b4 && b4.kind === 'mfa') ok('MFA 账号：自动路径永久熔断（自动重登给不了验证码）');
  else bad('MFA 熔断未生效', b4);
  if (/双因素/.test(api.jmsGuardHint(b4, NOW))) ok('MFA 提示指向「🔑 登录」手动输码');
  else bad('MFA 提示不对', api.jmsGuardHint(b4, NOW));

  // ⑦ 失败计数累加 + 成功清除
  const s5 = srv({ id: 'jms-server-4' });
  api.jmsAuthGuard.clear();
  const g1 = api.jmsGuardRecord(s5, MSG_BAD_PW, { now: NOW });
  const g2 = api.jmsGuardRecord(s5, MSG_BAD_PW, { now: NOW + 1000 });
  if (g1.failCount === 1 && g2.failCount === 2) ok('连续失败计数 1 → 2（供日志/提示用）');
  else bad('失败计数不累加', [g1.failCount, g2.failCount]);
  api.jmsGuardClear(s5);
  if (api.jmsGuardBlocked(s5, NOW + 1000) === null) ok('登录成功调 jmsGuardClear 后立刻解除熔断');
  else bad('清除后仍在熔断');

  // ⑪ token 有效期：别等真失效才换票（服务端默认 24h，跨天第一次请求必失败一次 = 白扣一次失败次数）
  const s6 = srv({ id: 'jms-server-5' });
  api.jmsAuthGuard.clear();
  api.jmsApplyLogin(s6, { token: 'tok', user: 'polaris', dateExpired: new Date(NOW + 24 * 3600 * 1000).toISOString() });
  if (s6.token === 'tok' && s6.user === 'polaris' && s6.tokenExpiredAt === NOW + 24 * 3600 * 1000) ok('登录成功回填 token/用户/到期时间');
  else bad('jmsApplyLogin 没回填到期时间', s6.tokenExpiredAt);
  if (api.jmsTokenValid(s6, NOW)) ok('刚登录：token 可用（不会立刻又登一次）');
  else bad('刚登录就判 token 无效');
  if (api.jmsTokenValid(s6, NOW + 24 * 3600 * 1000 - 6 * 60000)) ok('到期前 6 分钟仍可用（没到换票窗口）');
  else bad('未到换票窗口就判无效（会造成多余登录）');
  if (!api.jmsTokenValid(s6, NOW + 24 * 3600 * 1000 - 4 * 60000)) ok('到期前 4 分钟判无效 → 提前换票，避免跨天白失败一次');
  else bad('临近过期没提前换票');
  if (!api.jmsTokenValid(s6, NOW + 25 * 3600 * 1000)) ok('过期后判无效');
  else bad('过期后仍判可用');
  if (api.jmsTokenValid({ token: 'tok', user: 'u' }, NOW)) ok('没有过期信息的老数据按可用处理（不改变旧行为）');
  else bad('缺过期信息被误判无效');
  if (!api.jmsTokenValid({ token: '', user: 'u' }, NOW)) ok('没 token 判无效');
  else bad('空 token 判可用');
  if (api.jmsTokenExpiry('') === 0 && api.jmsTokenExpiry('not-a-date') === 0) ok('date_expired 缺失/解析失败按 0（不主动换票）');
  else bad('非法 date_expired 没回落 0');
  if (api.jmsTokenExpiry('2026-11-18T09:00:00+08:00') > 0) ok('真实 ISO 时间能解析（带时区）');
  else bad('ISO 时间解析失败');

  // ⑫ 登录单飞：并发调用共用一条请求（否则一次重登被扣成好几次失败次数）
  const s7 = srv({ id: 'jms-server-6' });
  api.jmsAuthGuard.clear();
  const fakeFn = () => Promise.resolve(true);
  const p1 = api.jmsLoginOnce(s7, fakeFn);
  const p2 = api.jmsLoginOnce(s7, fakeFn);
  if (p1 === p2) ok('同一服务器的并发登录返回同一个 Promise（单飞）');
  else bad('并发登录没有单飞（会连发多条登录请求）');
  if (api.jmsLoginInflight.size === 1) ok('在飞表里只有 1 条（按 服务器|账号 归并）');
  else bad('在飞表条数不对', api.jmsLoginInflight.size);
  const s8 = srv({ id: 'jms-server-7', account: 'polaris-ro' });
  if (api.jmsLoginOnce(s8, fakeFn) !== p1) ok('不同服务器/账号互不干扰（各自单飞）');
  else bad('不同账号被错误合并');
  api.jmsLoginInflight.clear();

  // ⑬ 只有"token 失效"类错误才值得强制重登（网络/5xx 重登只会白扣次数）
  if (api.jmsAuthError('HTTP 401') && api.jmsAuthError('token 已过期') && api.jmsAuthError('{"error":"NotAuthenticated"}')) ok('401 / token 过期 / NotAuthenticated 判为登录类错误');
  else bad('登录类错误识别不全');
  if (!api.jmsAuthError('fetch failed') && !api.jmsAuthError('HTTP 502') && !api.jmsAuthError('')) ok('网络异常 / 502 / 空错误不触发强制重登');
  else bad('非登录类错误被误判，会导致多余重登');

  // ⑧ key：同 id 不同账号互不影响；clearById 只清该连接
  const a1 = srv({ id: 'same-id', account: 'admin' });
  const a2 = srv({ id: 'same-id', account: 'polaris' });
  api.jmsAuthGuard.clear();
  api.jmsGuardRecord(a1, MSG_BAD_PW, { now: NOW });
  if (api.jmsGuardBlocked(a2, NOW) === null) ok('同一连接 id 换了账号 → 旧熔断不误伤新账号（key 含 account）');
  else bad('key 未含 account，改账号后仍被拦');
  api.jmsGuardRecord(a2, MSG_BAD_PW, { now: NOW });
  const cleared = api.jmsGuardClearById('same-id');
  if (cleared === 2 && api.jmsGuardBlocked(a1, NOW) === null && api.jmsGuardBlocked(a2, NOW) === null) ok('jmsGuardClearById 清掉该连接的全部 key（改配置/删连接用）');
  else bad('clearById 未清干净', cleared);
  if (api.jmsGuardClearById('') === 0 && api.jmsGuardClearById(undefined) === 0) ok('clearById 传空/undefined 安全（不会误清全部）');
  else bad('clearById 空参数不安全');
}

// ⑨ 结构性接线断言（光有纯逻辑没用，必须真的接在自动路径上）
const srcN = src.split('\r\n').join('\n'); // 仓库在 Windows 上是 CRLF,结构性正则统一在 LF 文本上跑
const wiring = [
  [/async function ensureJmsLogin[\s\S]{0,1200}?jmsGuardBlocked\(s\)/, 'ensureJmsLogin 登录前先查熔断（jmsGuardBlocked）'],
  [/async function ensureJmsLogin[\s\S]{0,1600}?jmsGuardRecord\(s, raw/, '自动重登失败落熔断（jmsGuardRecord）'],
  [/async function jmsAutoLogin[\s\S]{0,1600}?jmsGuardClear\(s\)/, '自动重登成功清熔断（jmsGuardClear）'],
  [/function jmsNeedLoginMsg[\s\S]{0,600}?jmsGuardHint\(g\)/, 'jmsNeedLoginMsg 用熔断文案（不是原始报错）'],
  [/function jmsDoSave[\s\S]{0,900}?jmsGuardClearById\(server\.id\)/, '编辑保存 JumpServer 配置时清熔断'],
  [/function bastionCfgDelete[\s\S]{0,400}?jmsGuardClearById\(id\)/, '删除堡垒机连接时清熔断'],
  [/if \(editingId\) \{[\s\S]{0,900}?jmsGuardClearById\(s\.id\)/, '编辑已保存堡垒机连接时清熔断'],
  [/手动登录成功 → 恢复自动登录\n\s*jmsGuardClear\(server\)/, '手动「登录」成功后清熔断'],
  [/手动登录也记一笔[\s\S]{0,400}?jmsGuardRecord\(server, r\.error\)/, '手动登录失败也落熔断（避免自动路径继续扣次数）'],
  [/if \(!force && jmsTokenValid\(s\)\) return true;/, 'ensureJmsLogin 用 token 有效期判定（不再只看 token 有没有）'],
  [/return jmsLoginOnce\(s, \(\) => jmsAutoLogin\(s, url, stale\)\);/, 'ensureJmsLogin 走单飞包装（并发只发一条登录）'],
  [/const authFail = !r\.ok && jmsAuthError\(r\.error\) && \(await ensureJmsLogin\(s, s\.baseUrl, \{ force: true \}\)\);/, '刷新失败只在登录类错误后才强制重登'],
  [/s\.tokenExpiredAt = jmsTokenExpiry\(r\.dateExpired\);/, '登录响应里的 date_expired 落成 tokenExpiredAt'],
];
for (const [re, name] of wiring) {
  if (re.test(srcN)) ok(name);
  else bad('缺少接线：' + name);
}

// ⑩ 旧写法必须消失（失败后什么都不记 → 轮询/点资产会一直扣服务端次数）
if (/s\.jmsLoginError = \(r && r\.error\) \|\| '账号或密码不正确';/.test(srcN)) bad('还留着「失败只记错误、不落熔断」的旧写法');
else ok('旧的「失败只记错误文本」写法已删除');
const srcNoHelper = srcN.replace(/function jmsApplyLogin\(s, r\) \{[\s\S]*?\n\}/, ''); // 辅助函数自己那行不算
if (/(^|[^A-Za-z0-9_.])(s|server|jmsServer)\.token = (r|lg)\.token/.test(srcNoHelper)) bad('还存在直接 token 赋值（应统一走 jmsApplyLogin 带到期时间）');
else ok('所有 token 回填都走 jmsApplyLogin（不只拿 token，还拿到期时间）');
if (/if \(!pw\) return false;\s*\n/.test(src)) bad('ensureJmsLogin 解不出密码时静默返回，用户看不到原因');
else ok('解不出密码有可读原因（不再静默 return false）');

console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
process.exit(failed ? 1 : 0);
