const { freePort, killTree, guardTimeout, evaluate } = require('./test-helper');
// 验证「堡垒机登录后分组默认折叠」:
//   ① H3C:登录钩子 collapseBastionGroupsState() 把业务根/目录/未分组/收藏子组全部置为折叠
//      (即使资产目录是登录前从缓存恢复的,即 bastionDirsInit 已为 true 也要折叠 → 修掉旧漏洞)
//   ② 渲染结果:分组头全部是 ▶(折叠),且不渲染任何设备行
//   ③ JMS:登录钩子 collapseJmsGroupsState(s) 折叠该服务器的节点分组
//   ④ 用户手动展开后再渲染 → 保持展开(登录钩子只跑一次,不反复打断用户)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

const OUT = process.env.VERIFY_OUT || os.tmpdir() + '/verify-bastion-login-collapse.txt';
const w = (s) => fs.appendFileSync(OUT, s + '\n');
const log = (s) => { try { console.log(s); } catch { /* ignore */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets(PORT) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      const j = await r.json();
      if (j.find((t) => t.type === 'page' && /解锁|Polaris/.test(t.title || ''))) return j;
    } catch { /* not ready */ }
    await sleep(400);
  }
  throw new Error('CDP targets 未就绪');
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0; const pending = new Map();
    ws.onopen = () => resolve({
      call(m, p = {}) { return new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p })); }); },
      close() { ws.close(); },
    });
    ws.onerror = (e) => reject(e);
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  });
}

let pass = 0; let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; log(`  ✓ ${name}${extra ? ' → ' + extra : ''}`); }
  else { fail++; log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`); }
}

async function main() {
  fs.writeFileSync(OUT, '');
  const PORT = 9457;
  const DIR = fs.mkdtempSync(os.tmpdir() + '/polaris-login-collapse-');
  freePort(PORT);
  const app = spawn(require('electron'), ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
    env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
    stdio: 'ignore', detached: true,
  });
  guardTimeout(150000, app);
  try {
    const ts = await targets(PORT);
    const lockUrl = (ts.find((t) => /解锁/.test(t.title || '')) || {}).webSocketDebuggerUrl;
    if (lockUrl) {
      const lock = await connect(lockUrl);
      for (let i = 0; i < 30; i++) { if (await evaluate(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
      await sleep(300);
      await evaluate(lock, `document.getElementById('pw').value='x12345678'; document.getElementById('pw2').value='x12345678'; document.getElementById('btn').click();`);
    }
    let c = null;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const t2 = await targets(PORT);
      const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || ''));
      if (m) { c = await connect(m.webSocketDebuggerUrl); break; }
    }
    if (!c) throw new Error('主窗口未出现');

    const r = await evaluate(c, `(() => {
      const out = {};

      // ---------- ① H3C:登录钩子折叠全部分组(模拟"资产已在缓存,bastionDirsInit 已初始化") ----------
      state.bastionAssets = [
        { devId: 'd1', name: '设备1', ip: '10.0.0.1', dir: '生产', dirs: ['生产'], dirPath: ['大连IDC', '生产'], favorite: false },
        { devId: 'd2', name: '设备2', ip: '10.0.0.2', dir: '测试', dirs: ['测试'], dirPath: ['大连IDC', '测试'], favorite: false },
        { devId: 'd3', name: '设备3', ip: '10.0.0.3', dir: '', dirs: [], dirPath: [], favorite: false },
        { devId: 'd4', name: '设备4', ip: '10.0.0.4', dir: '', dirs: [], dirPath: [], favorite: true, favGroup: '重要/核心' },
      ];
      state.bastionDirCollapsed.clear();
      state.bastionDirsInit = true; // 关键:模拟登录前分组已初始化过(旧的唯一一次初始化不会再跑)
      collapseBastionGroupsState();
      const col = state.bastionDirCollapsed;
      out.h3cAllDirsCollapsed = col.has('生产') && col.has('测试') && col.has('__ungrouped__') && col.has('__fav__')
        && col.has('__root__大连IDC') && col.has('__fav__重要') && col.has('__fav__重要/核心');

      // ---------- ② 渲染结果:分组头全是 ▶,无设备行 ----------
      const box = document.createElement('div');
      document.body.appendChild(box);
      state.bastionCollapsed = false; // 展开 H3C 区块,让分组渲染出来
      renderBastionInSessionList(box, '');
      // 只算分组头:'🌐 H3C 堡垒机(N)' 是本区块自己的头(测试里特意展开),不算分组
      const heads = [...box.querySelectorAll('.asset-group-head')]
        .filter((h) => !(h.textContent || '').includes('🌐 H3C'));
      const carets = heads.map((h) => (h.querySelector('.asset-group-caret') || {}).textContent || '');
      out.headCount = heads.length;
      out.heads = heads.map((h) => carets[0] && ((h.querySelector('.asset-group-caret') || {}).textContent || '?') + '|' + (h.textContent || '').trim().slice(0, 24));
      out.allCaretsCollapsed = heads.length > 0 && carets.every((t) => t === '▶');
      out.visibleAssetRows = box.querySelectorAll('.asset-item').length;

      // ---------- ④ 用户手动展开后再次渲染 → 保持展开 ----------
      col.delete('__root__大连IDC'); // 先展开父级业务根,子目录才会被渲染
      col.delete('生产');
      renderBastionInSessionList(box, '');
      const prodHead = [...box.querySelectorAll('.asset-group-head')]
        .filter((h) => !(h.textContent || '').includes('🌐 H3C'))
        .find((h) => (h.textContent || '').includes('生产'));
      out.staysExpanded = !col.has('生产') && !!prodHead && ((prodHead.querySelector('.asset-group-caret') || {}).textContent === '▼');
      box.remove();

      // ---------- ③ JMS:登录钩子折叠该服务器的节点分组 ----------
      const fake = { id: 'jms-9', name: '测试JMS', baseUrl: 'https://jms.example.com',
        assets: [ { id: '1', name: 'A', address: '1.1.1.1', nodes: [{ name: '生产' }, { name: '堡垒机' }] },
                  { id: '2', name: 'B', address: '2.2.2.2', nodes: [] } ] };
      state.bastionDirCollapsed.clear();
      collapseJmsGroupsState(fake);
      out.jmsCollapsed = state.bastionDirCollapsed.has('jms:jms-9:生产')
        && state.bastionDirCollapsed.has('jms:jms-9:堡垒机')
        && state.bastionDirCollapsed.has('jms:jms-9:__ungrouped__');

      // ---------- 空资产/无 id 不炸 ----------
      collapseJmsGroupsState(null);
      collapseJmsGroupsState({});
      out.noThrowOnEmpty = true;
      return out;
    })()`);

    log('\n=== 堡垒机登录后分组默认折叠 ===\n');
    check('H3C 登录钩子折叠全部业务根/目录/未分组/收藏子组', r.h3cAllDirsCollapsed === true);
    check('渲染后所有分组头都是 ▶(折叠)', r.allCaretsCollapsed === true, `分组头 ${r.headCount} 个`);
    check('折叠状态不渲染设备行', r.visibleAssetRows === 0, `可见设备 ${r.visibleAssetRows} 行`);
    check('用户展开后保持展开(不被重复折叠)', r.staysExpanded === true);
    check('JMS 登录钩子折叠节点分组', r.jmsCollapsed === true);
    check('空参/null 不抛异常', r.noThrowOnEmpty === true);

    log(`\n结果: ${pass} 通过, ${fail} 失败`);
    w(`RESULT ${JSON.stringify(r)}`);
    w(`SUMMARY ${pass} passed, ${fail} failed`);
    await sleep(300);
    process.exit(fail ? 1 : 0);
  } catch (e) {
    w('ERROR ' + ((e && e.stack) || String(e)).slice(0, 800));
    log('error: ' + e);
    process.exit(1);
  } finally {
    killTree(app);
  }
}

main();
