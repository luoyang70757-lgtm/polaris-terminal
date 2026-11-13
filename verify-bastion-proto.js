'use strict';
/**
 * verify-bastion-proto.js — H3C 资产「协议识别」纯 Node 回归(不启 Electron)
 *
 * 背景(真实 HAR bastion-5.har):
 *   H3C 资产的服务键就是 proto 名 —— `services.services` 可能是
 *     { ssh: {port:22} }                    → 可接终端
 *     { rdp: {...} }                        → mstsc 图形会话
 *     { Device_Storage_web: {url:'https://…'} } → 存储 Web 控制台
 *   旧代码只认 srv.ssh / srv.sftp,其余类型一律当 ssh:点 RDP 资产会拿 proto='ssh'
 *   去请求 /deviceAccess/accessUrl(堡垒机协议不匹配),或者拿到一个没有 pw/pn 的
 *   图形客户端 token,最后只报「堡垒机连接信息不完整」—— 用户完全看不出是资产类型不支持。
 *
 * 做法:直接从 src/renderer.js 里切出纯函数区块(bastionTagPaths → 协议识别辅助),
 * 在 Node 里 eval 后断言,不需要 DOM / 堡垒机 / HAR(HAR 存在时额外加真实数据断言)。
 *
 *   node verify-bastion-proto.js
 */
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };

// ---------- 从 renderer.js 切出纯函数区块 ----------
const SRC = fs.readFileSync(path.join(__dirname, 'src', 'renderer.js'), 'utf8');
const START = 'function bastionTagPaths(d2, paths) {';
const END = '// 合并:按 devId 去重';
const s = SRC.indexOf(START), e = SRC.indexOf(END, s);
if (s < 0 || e < 0) {
  console.error('  ✗ 找不到纯函数区块(bastionTagPaths … // 合并:按 devId 去重)——函数被改名/移动了?');
  process.exit(1);
}
const BLOCK = SRC.slice(s, e);
let F;
try {
  F = new Function(
    BLOCK + '\nreturn { bastionParseDevs, bastionAssetProtos, bastionAssetSupportsSsh, bastionProtoLabels, bastionUnsupportedAssetMsg, bastionNonSshEntry, accessClientSessionKind };'
  )();
} catch (err) {
  console.error('  ✗ 区块无法求值: ' + err.message);
  process.exit(1);
}
const { bastionParseDevs, bastionAssetSupportsSsh, bastionProtoLabels, bastionUnsupportedAssetMsg, bastionNonSshEntry, accessClientSessionKind } = F;

console.log('\n=== H3C 资产协议识别(RDP/Web 不能当 SSH 连) ===\n');

// 造一份与真实响应同形的 content
const content = (dev) => ({ content: [{ id: dev.id, dev, recent: { account: 'root' } }] });
const devOf = (services, extra) => Object.assign({
  id: 1001, name: 'host-a', ip: '10.0.0.1', services: { services },
  accounts: { accounts: [{ name: 'root' }, { name: 'admin' }] },
}, extra || {});

// ① SSH 资产(真实 HAR 形状:{ssh:{port:22,proto:'ssh',state:1}})
{
  const a = bastionParseDevs(content(devOf({ ssh: { port: 22, proto: 'ssh', state: 1 } })), ['IDC'])[0];
  if (a && a.proto === 'ssh' && a.port === 22) ok('① SSH 资产 → proto=ssh / port=22');
  else bad('① SSH 资产识别错误', JSON.stringify(a && { proto: a.proto, port: a.port }));
  if (a && a.protocols && a.protocols.length === 1 && a.protocols[0] === 'ssh') ok('① protocols=["ssh"]');
  else bad('① protocols 缺失', JSON.stringify(a && a.protocols));
  if (a && bastionAssetSupportsSsh(a) === true) ok('① 判定可接终端(SSH)');
  else bad('① SSH 资产被判成不可连');
}

// ② RDP 资产(真实 HAR:{rdp:{…}}) —— 旧代码会得到 proto='ssh' + 误判可连
{
  const a = bastionParseDevs(content(devOf({ rdp: { port: 3389, proto: 'rdp' } }, { id: 2002, name: 'win-rdp' })), ['IDC'])[0];
  if (a && a.proto === 'rdp') ok('② RDP 资产 → proto=rdp(不再被当成 ssh)');
  else bad('② RDP 资产被当成 ssh', JSON.stringify(a && { proto: a.proto, protocols: a.protocols }));
  if (a && bastionAssetSupportsSsh(a) === false) ok('② 判定不可接终端(不拿 proto=ssh 去请求)');
  else bad('② RDP 资产仍被判成可连 SSH');
  const labels = bastionProtoLabels(a).join('/');
  if (labels === 'RDP') ok('② 列表标签 = RDP');
  else bad('② 列表标签错误', labels);
  const msg = bastionUnsupportedAssetMsg(a);
  if (/RDP/.test(msg) && /只能在.*SSH|只能打开 SSH/i.test(msg) && /堡垒机网页/.test(msg)) ok('② 双击提示说得清:是 RDP 资产 + 去堡垒机网页打开');
  else bad('② 双击提示文案不对', msg);
}

// ③ 存储 Web 资产(真实 HAR:{Device_Storage_web:{url:'https://10.0.0.9:8088'}})
{
  const a = bastionParseDevs(content(devOf({ Device_Storage_web: { url: 'https://10.0.0.9:8088' } }, { id: 3003, name: 'OceanStor' })), ['IDC'])[0];
  if (a && a.webUrl === 'https://10.0.0.9:8088') ok('③ Web 资产提取 webUrl(可右键用浏览器打开)');
  else bad('③ webUrl 没提取到', JSON.stringify(a && a.webUrl));
  if (a && bastionAssetSupportsSsh(a) === false) ok('③ Web 资产不可接终端');
  else bad('③ Web 资产仍被判成可连 SSH');
  const labels = bastionProtoLabels(a).join('/');
  if (labels === 'Web') ok('③ 列表标签 = Web');
  else bad('③ 列表标签错误', labels);
  const msg = bastionUnsupportedAssetMsg(a);
  if (/Web/.test(msg) && msg.indexOf('https://10.0.0.9:8088') >= 0 && /系统浏览器/.test(msg)) ok('③ 提示带可用的浏览器地址');
  else bad('③ 提示没给浏览器地址', msg);
  if (a && a.protocols && a.protocols[0] === 'Device_Storage_web') ok('③ protocols 保留 H3C 原始服务键');
  else bad('③ 原始服务键丢了', JSON.stringify(a && a.protocols));
}

// ④ 多协议资产(ssh + rdp):SSH 端口优先,仍可接终端
{
  const a = bastionParseDevs(content(devOf({ rdp: { port: 3389 }, ssh: { port: 2222 } }, { id: 4004 })), ['IDC'])[0];
  if (a && a.proto === 'ssh' && a.port === 2222) ok('④ ssh+rdp → proto=ssh / port=2222(端口取 ssh 的,不被 3389 顶掉)');
  else bad('④ 多协议端口/proto 取值错误', JSON.stringify(a && { proto: a.proto, port: a.port }));
  if (a && bastionAssetSupportsSsh(a) === true) ok('④ 多协议资产可接终端');
  else bad('④ 多协议资产被判成不可连');
  const labels = bastionProtoLabels(a).sort().join('/');
  if (labels === 'RDP/SSH') ok('④ 标签同时标 SSH 与 RDP');
  else bad('④ 标签丢了其中一个协议', labels);
}

// ⑤ 只有 sftp 服务 / 完全没有 services
{
  const sftpOnly = bastionParseDevs(content(devOf({ sftp: { port: 22 } })), ['IDC'])[0];
  if (sftpOnly && bastionAssetSupportsSsh(sftpOnly) === true && sftpOnly.proto === 'sftp') ok('⑤ sftp-only 资产可接(proto=sftp)');
  else bad('⑤ sftp-only 资产识别错误', JSON.stringify(sftpOnly && { proto: sftpOnly.proto }));
  const none = bastionParseDevs(content(devOf({})), ['IDC'])[0];
  if (none && none.proto === 'ssh' && none.protocols.join() === 'ssh' && bastionAssetSupportsSsh(none)) ok('⑤ 无 services 的旧数据 → 默认 SSH(向后兼容,老缓存不会全变不可连)');
  else bad('⑤ 无 services 时默认值不对', JSON.stringify(none && { proto: none.proto, protocols: none.protocols }));
}

// ⑥ 其他字段没被这次改动破坏
{
  const a = bastionParseDevs(content(devOf({ ssh: { port: 22 } })), ['IDC', '业务组'])[0];
  if (a && a.dir === '业务组' && a.dirPath.join('>') === 'IDC>业务组' && a.accounts.join('/') === 'root/admin' && a.recentAccount === 'root') ok('⑥ dir/dirPath/accounts/recentAccount 仍正确');
  else bad('⑥ 其它字段被改坏', JSON.stringify(a));
  const list = bastionParseDevs(content({ id: 9, ip: '10.0.0.9' }), null); // 没 name
  if (list.length === 0) ok('⑥ 无名资产仍被过滤');
  else bad('⑥ 无名资产没被过滤', JSON.stringify(list));
}

// ⑦ 树结构分支({children})默认 SSH
{
  const t = bastionParseDevs({ children: [{ id: 5, name: 'tree-host', ip: '10.0.5.5', children: [{ id: 6, name: 'deep', ip: '10.0.6.6' }] }] }, ['IDC']);
  if (t.length === 2 && t.every((x) => x.proto === 'ssh' && bastionAssetSupportsSsh(x))) ok('⑦ 树结构({children})节点默认 SSH');
  else bad('⑦ 树结构解析异常', JSON.stringify(t));
  if (t.length === 2 && t.every((x) => Array.isArray(x.protocols) && x.protocols.length === 1 && x.protocols[0] === 'ssh')) ok('⑦ 树节点也带 protocols=[ssh]');
  else bad('⑦ 树节点缺 protocols', JSON.stringify(t.map((x) => x.protocols)));
}

// ⑧ accessclient token 类型判定(真实 HAR 的 RDP token 字段)
{
  // 真实 token(bastion-5.har):app=mstsc + fa=网关:3389 + as=凭据串,没有 pw/pn
  const rdp = accessClientSessionKind({
    app: 'mstsc', st: 'super@OceanStor Pacific 9520', sa: 'super', sh: 'storage.example',
    fa: 'h3c-bastion.example:3389', as: 's:XXXX-XXXX OTP:YYYY-YYYY', use_host: '0', shterm_ver: '2',
  });
  if (rdp.kind === 'graphic' && rdp.app === 'mstsc') ok('⑧ RDP token(真实 HAR 形状) → graphic/mstsc');
  else bad('⑧ RDP token 判定错误', JSON.stringify(rdp));
  const ssh = accessClientSessionKind({ hn: '10.0.0.1', pn: '22', sa: 'root', pw: 'OTP:abc', sn: 'db-01' });
  if (ssh.kind === 'ssh') ok('⑧ SSH token(hn/pn/pw)→ ssh');
  else bad('⑧ SSH token 判定错误', JSON.stringify(ssh));
  const putty = accessClientSessionKind({ app: 'putty', hn: '10.0.0.2', pn: '2222', pw: 'OTP:x' });
  if (putty.kind === 'ssh') ok('⑧ 带 app 但非图形客户端的 SSH token 不被误判');
  else bad('⑧ SSH token 被误判成图形', JSON.stringify(putty));
  const empty = accessClientSessionKind({});
  if (empty.kind === 'incomplete') ok('⑧ 空 token → incomplete');
  else bad('⑧ 空 token 判定错误', JSON.stringify(empty));
  const vnc = accessClientSessionKind({ app: 'vnc', fa: 'h:5900' });
  if (vnc.kind === 'graphic') ok('⑧ VNC token 也归 graphic');
  else bad('⑧ VNC 未归类', JSON.stringify(vnc));
}

// ⑨ 真实 HAR(存在时):每台资产的「可连 SSH」判定必须与 services 里有无 ssh 一一对应
{
  // 后缀匹配仓库根目录里的 *.har(文件名里可能带内网地址,不写进仓库)
  const harFiles = (() => { try { return fs.readdirSync(__dirname).filter((f) => /\.har$/i.test(f)).map((f) => path.join(__dirname, f)); } catch { return []; } })();
  const cands = [process.env.POLARIS_HAR,
    harFiles.find((p) => /-5\.har$/i.test(p)) || harFiles.find((p) => /-11\.har$/i.test(p))].filter(Boolean);
  const har = cands.find((p) => fs.existsSync(p));
  if (!har) {
    console.log('  (仓库根目录没有 *.har,跳过真实数据断言 ⑨;可用 POLARIS_HAR=<路径> 指定)');
  } else {
    const j = JSON.parse(fs.readFileSync(har, 'utf8'));
    const resp = (j.log.entries || []).find((en) => /getAccessViewDevs/.test(en.request.url) && en.response.content && en.response.content.text);
    const body = resp ? JSON.parse(resp.response.content.text) : null;
    const items = (body && body.content) || [];
    if (!items.length) {
      bad('⑨ HAR 里没有 getAccessViewDevs 响应内容');
    } else {
      const parsed = bastionParseDevs(body, ['HAR']);
      let mismatched = 0, nonssh = 0, sshN = 0, ports = 0;
      for (const c of items) {
        const svc = Object.keys((c.dev && c.dev.services && c.dev.services.services) || {});
        const wantSsh = svc.some((k) => /^(ssh|sftp)$/i.test(k));
        const got = parsed.find((p) => String(p.devId) === String(c.dev && c.dev.id));
        if (!got || bastionAssetSupportsSsh(got) !== wantSsh) mismatched++;
        if (wantSsh) sshN++; else nonssh++;
        if (got && wantSsh && got.port !== ((c.dev.services.services.ssh && c.dev.services.services.ssh.port) || 22)) ports++;
      }
      if (mismatched === 0) ok(`⑨ 真实 HAR ${path.basename(har)}:${items.length} 台资产的协议判定与 services 完全一致(SSH ${sshN} / 非 SSH ${nonssh})`);
      else bad('⑨ 真实 HAR 协议判定不一致', `${mismatched} / ${items.length} 台`);
      if (ports === 0) ok('⑨ SSH 资产端口与 HAR 一致(ssh.port 优先)');
      else bad('⑨ SSH 资产端口取值不一致', `${ports} 台`);
      const labels = new Set();
      parsed.forEach((p) => bastionProtoLabels(p).forEach((l) => labels.add(l)));
      if (nonssh > 0 ? (labels.has('RDP') || labels.has('Web')) : true) ok(`⑨ 非 SSH 资产在列表里能标出来(标签集合:${[...labels].join('/')})`);
      else bad('⑨ 非 SSH 资产没有协议标签', [...labels].join('/'));
    }
  }
}

// ⑩ 非 SSH 资产入口文案:装了 H3C 客户端 → 直接打开;没装 → 查看说明(v1.0.19)
{
  const rdp = bastionParseDevs(content(devOf({ rdp: { port: 3389 } }, { id: 5005, name: 'win-rdp' })), ['IDC'])[0];
  const withClient = bastionNonSshEntry(rdp, true);
  if (withClient && /用堡垒机客户端打开/.test(withClient.menu) && /RDP/.test(withClient.menu)) ok('⑩ 装了客户端 → 菜单项「用堡垒机客户端打开(RDP)」');
  else bad('⑩ 装了客户端时的菜单项不对', JSON.stringify(withClient));
  if (withClient && withClient.menu.indexOf('点此查看说明') === -1) ok('⑩ 装了客户端不再出现「查看说明」');
  else bad('⑩ 装了客户端仍提示查看说明');
  if (withClient && /H3C 客户端/.test(withClient.title)) ok('⑩ 悬浮提示写明「用 H3C 客户端打开」');
  else bad('⑩ 悬浮提示没提客户端', withClient && withClient.title);

  const noClient = bastionNonSshEntry(rdp, false);
  if (noClient && /点此查看说明/.test(noClient.menu) && noClient.menu.indexOf('用堡垒机客户端打开') === -1) ok('⑩ 没装客户端 → 保持「查看说明」');
  else bad('⑩ 没装客户端时的菜单项不对', JSON.stringify(noClient));

  const webAsset = bastionParseDevs(content(devOf({ Device_Storage_web: { url: 'https://10.0.0.9:8088' } }, { id: 6006 })), ['IDC'])[0];
  const webEntry = bastionNonSshEntry(webAsset, true);
  if (/Web/.test(webEntry.menu)) ok('⑩ Web 资产也走同一个入口(标签=Web)');
  else bad('⑩ Web 资产入口标签不对', JSON.stringify(webEntry));

  // 失败/未装时的提示补一句「本机没有客户端」,避免用户以为是密码问题
  const msgMissing = bastionUnsupportedAssetMsg(rdp, { clientMissing: true });
  if (/AccessClient/.test(msgMissing) && /安装/.test(msgMissing)) ok('⑩ 未装客户端时提示指出缺 AccessClient 并给安装指引');
  else bad('⑩ 未装客户端提示缺指引', msgMissing);
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
