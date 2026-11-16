'use strict';
/**
 * verify-term-links.js — 终端里的链接:Cmd/Ctrl + 点击 → 系统浏览器打开
 *
 * 背景:用户问「能否支持打开浏览器链接」。v1.0.9 前终端里的 URL 只是死文本。
 * 本用例覆盖:
 *  ① 纯函数 extractTermUrls:尾部标点/括号/引号裁剪、多链接、无主机不认、非 http(s) 不认;
 *  ② isOpenableUrl 白名单:http/https 放行,javascript:/file:/data: 拒绝;
 *  ③ 真实终端注册了 linkProvider(term.registerLinkProvider),能按行号拿到链接与正确的 range;
 *  ④ 折行 URL:窄终端里 URL 被折断后仍能拼回一条链接(跨行 range);
 *  ⑤ 裸点击**不**打开(留给拖选),⌘/Ctrl 点击才打开,且打开的是原 URL(主进程用测试钩子拦截,不弹浏览器);
 *  ⑥ 主进程 app:openExternal 对 javascript: 等多协议返回错误(白名单第二道);
 *  ⑦ 右键菜单:选中一条 URL 时出现「🔗 在系统浏览器打开」。
 *
 * 运行: node verify-term-links.js(需 9396/2298/2398 空闲;mock SSH 密码 admin123)
 */
const { spawn } = require('child_process');
const { freePort, guardTimeout, evaluate } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-termlinks-'));
const PORT = 9396, SSH = 2298, HTTP = 2398;
freePort(PORT); freePort(SSH); freePort(HTTP);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(HTTP);
require('./mock/mock-server').start();

const APP_PW = 'x1234567';
const appProc = spawn(require('electron'), ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  // POLARIS_TEST_NO_EXTERNAL=1:主进程 app:openExternal 只回 {ok:true,skipped:true},不真的弹浏览器
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, POLARIS_TEST_NO_EXTERNAL: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(180000, appProc);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      const j = await r.json();
      if (j.some((t) => t.type === 'page')) return j;
    } catch { /* ignore */ }
    await sleep(400);
  }
  throw new Error('targets 未就绪');
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0; const pending = new Map();
    ws.onopen = () => resolve({
      call(m, p = {}) { return new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p })); }); },
      close() { ws.close(); },
    });
    ws.onerror = reject;
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  });
}
async function ev(c, expr) { return evaluate(c, expr); }

let passed = 0, failed = 0;
const ok = (n, extra) => { passed++; console.log('  ✓ ' + n + (extra ? '  → ' + extra : '')); };
const bad = (n, extra) => { failed++; console.error('  ✗ ' + n + (extra ? '  → ' + extra : '')); };

(async () => {
  console.log('\n=== 终端链接:Cmd/Ctrl+点击打开浏览器 ===\n');
  try {
    const t0 = await targets();
    const lockT = t0.find((t) => /解锁/.test(t.title || '')) || t0.find((t) => t.type === 'page');
    const lock = await connect(lockT.webSocketDebuggerUrl);
    // 首次运行:设置 App 密码并进入(lock.js 是 async IIFE,按钮监听晚于 IPC,整体重试)
    let c = null;
    for (let attempt = 0; attempt < 20 && !c; attempt++) {
      const ready = await ev(lock, `(function(){var b=document.getElementById('btn');return !!b && /设置|解锁/.test(b.textContent||'');})()`);
      if (ready) {
        await ev(lock, `document.getElementById('pw').value=${JSON.stringify(APP_PW)}; document.getElementById('pw2').value=${JSON.stringify(APP_PW)}; document.getElementById('btn').click();`);
      }
      for (let i = 0; i < 4 && !c; i++) {
        await sleep(350);
        const t = await targets();
        const m = t.find((x) => x.type === 'page' && !/解锁/.test(x.title || ''));
        if (m) c = await connect(m.webSocketDebuggerUrl);
      }
    }
    if (!c) throw new Error('主窗口未就绪');
    for (let i = 0; i < 60; i++) { if (await ev(c, `typeof state === 'object' && !!state.settings`)) break; await sleep(200); }
    await ev(c, `state.settings.onboardingDone = true; saveSettings(); var om=document.getElementById('onboarding-modal'); if(om) om.classList.add('hidden'); true;`);

    // ---- ① 纯函数:URL 抽取与尾部裁剪 ----
    const parse = await ev(c, `(function(){
      var f = extractTermUrls;
      return JSON.stringify({
        simple: f('open https://example.com/a now').map(function(x){return x.url;}),
        trailingDot: f('see http://example.com/x.').map(function(x){return x.url;}),
        cjkPunct: f('文档在 https://example.com/文档。然后继续').map(function(x){return x.url;}),
        parenTail: f('(https://example.com/a)').map(function(x){return x.url;}),
        parenKeep: f('https://example.com/a_(b)').map(function(x){return x.url;}),
        multi: f('a https://a.com/1 b http://b.com/2').map(function(x){return x.url;}),
        quoted: f('"https://example.com/q", next').map(function(x){return x.url;}),
        noHost: f('just https:// and text').map(function(x){return x.url;}),
        jsScheme: f('javascript:alert(1)').map(function(x){return x.url;}),
        fileScheme: f('file:///etc/passwd').map(function(x){return x.url;}),
        indexOk: (function(){var r=f('xx https://e.com/aa yy');return r.length? (r[0].index===3 && r[0].length==='https://e.com/aa'.length) : false;})(),
    });})()`);
    const P = JSON.parse(parse);
    const eq = (name, got, want) => {
      const g = JSON.stringify(got), w = JSON.stringify(want);
      if (g === w) ok(name, g); else bad(name, `got ${g} want ${w}`);
    };
    eq('① 单条 URL 抽取', P.simple, ['https://example.com/a']);
    eq('① 句尾英文句号被裁掉', P.trailingDot, ['http://example.com/x']);
    eq('① 中文句末标点被裁掉', P.cjkPunct, ['https://example.com/文档']);
    eq('① 包裹的右括号被裁掉', P.parenTail, ['https://example.com/a']);
    eq('① URL 自带的成对括号保留', P.parenKeep, ['https://example.com/a_(b)']);
    eq('① 一行多条 URL', P.multi, ['https://a.com/1', 'http://b.com/2']);
    eq('① 引号不算 URL 一部分', P.quoted, ['https://example.com/q']);
    eq('① 没有主机名不算链接', P.noHost, []);
    eq('① javascript: 不认', P.jsScheme, []);
    eq('① file: 不认', P.fileScheme, []);
    if (P.indexOk) ok('① 起始列/长度正确(建 range 用)'); else bad('① 起始列/长度不对', parse);

    // ---- ② 白名单 ----
    const wl = await ev(c, `JSON.stringify({
      http: isOpenableUrl('http://x.com'), https: isOpenableUrl('https://x.com/a'),
      js: isOpenableUrl('javascript:alert(1)'), file: isOpenableUrl('file:///etc/passwd'),
      data: isOpenableUrl('data:text/html,<b>x</b>'), ftp: isOpenableUrl('ftp://x.com'), junk: isOpenableUrl('not a url')
    })`);
    const W = JSON.parse(wl);
    if (W.http && W.https) ok('② http/https 允许打开'); else bad('② http/https 被误拒', wl);
    if (!W.js && !W.file && !W.data && !W.ftp && !W.junk) ok('② javascript:/file:/data:/ftp/垃圾串 全部拒绝'); else bad('② 非白名单协议没拦住', wl);

    // ---- 连一台 mock 主机,拿到真实终端 ----
    await ev(c, `connectToServer({ name:'链接测试', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh' }); true`);
    let sid = null;
    for (let i = 0; i < 50; i++) {
      sid = await ev(c, `state.activeSessionId || null`);
      const st = sid ? await ev(c, `(function(){var t=state.tabs.get(${JSON.stringify(sid)});return t?t.status:null;})()`) : null;
      if (st === 'connected') break;
      await sleep(300);
    }
    if (!sid) throw new Error('连接未建立');
    const hasProv = await ev(c, `(function(){var t=state.tabs.get(${JSON.stringify(sid)});return !!(t&&t.linkProvider&&typeof t.linkProvider.dispose==='function');})()`);
    if (hasProv) ok('③ 终端注册了 linkProvider'); else bad('③ 终端没有 linkProvider');

    // ---- ③ 真实缓冲区:写入一行带 URL 的输出,按行号取链接 ----
    const got = await ev(c, `(function(){
      var t=state.tabs.get(${JSON.stringify(sid)});
      var term=t.term;
      term.write('\\r\\nvisit https://example.com/docs?id=7 now\\r\\n');
      return new Promise(function(resolve){
        setTimeout(function(){
          var b=term.buffer.active;
          var target=-1;
          for(var i=b.viewportY; i<b.length; i++){
            var ln=b.getLine(i);
            if(ln && ln.translateToString(true).indexOf('example.com/docs')>=0){ target=i+1; break; }
          }
          if(target<0){ resolve(JSON.stringify({found:false})); return; }
          t.linkProvider.provideLinks(target, function(links){
            if(!links||!links.length){ resolve(JSON.stringify({found:true, links:0})); return; }
            resolve(JSON.stringify({ found:true, count:links.length, text:links[0].text,
              start:links[0].range.start, end:links[0].range.end,
              underline:!!(links[0].decorations&&links[0].decorations.underline),
              lineNo: target }));
          });
        }, 400);
      });
    })()`);
    const G = JSON.parse(got);
    if (G.found && G.count === 1 && G.text === 'https://example.com/docs?id=7') ok('③ 缓冲区里的 URL 被识别(含 query)', JSON.stringify({ text: G.text, start: G.start, end: G.end }));
    else bad('③ 缓冲区 URL 识别失败', got);
    if (G.underline) ok('③ 链接带下划线/手型光标装饰'); else bad('③ 链接缺少 decorations', got);
    if (G.start && G.end && G.start.x === 7 && G.end.x === G.start.x + 'https://example.com/docs?id=7'.length - 1 && G.start.y === G.end.y) {
      ok('③ range 精确覆盖 URL 文本', `${G.start.x}..${G.end.x} @y${G.start.y}`);
    } else bad('③ range 不精确', JSON.stringify({ start: G.start, end: G.end }));

    // ---- ③b 中文行:range 必须按单元格列号(双宽字符占两列),不能按字符串下标 ----
    const cjk = await ev(c, `(function(){
      var host=document.createElement('div');
      host.style.cssText='position:fixed;left:-9999px;top:0;width:400px;height:60px';
      document.body.appendChild(host);
      var t3=new XTermClass({ cols: 40, rows: 3, scrollback: 20 });
      t3.open(host);
      var prov=registerTermLinks(t3);
      t3.write('\\r\\n文档 https://e.com/aa\\r\\n');
      return new Promise(function(resolve){
        setTimeout(function(){
          var b=t3.buffer.active, target=-1;
          for(var i=0;i<b.length;i++){ var ln=b.getLine(i); if(ln && ln.translateToString(true).indexOf('https://e.com/aa')>=0){ target=i+1; break; } }
          if(target<0){ done(JSON.stringify({found:false})); return; }
          prov.provideLinks(target, function(links){
            done(JSON.stringify({ found:true, count:links?links.length:0,
              text: links&&links[0]?links[0].text:null,
              start: links&&links[0]?links[0].range.start:null,
              end: links&&links[0]?links[0].range.end:null }));
          });
          function done(json){ try{prov.dispose();}catch(e){} try{t3.dispose();}catch(e){} host.remove(); resolve(json); }
        }, 400);
      });
    })()`);
    const CJ = JSON.parse(cjk);
    // 文(1-2) 档(3-4) 空格(5) → URL 从第 6 列开始,长度 16 → 结束列 21
    if (CJ.found && CJ.count === 1 && CJ.text === 'https://e.com/aa' && CJ.start.x === 6 && CJ.start.y === CJ.end.y && CJ.end.x === 6 + 'https://e.com/aa'.length - 1) {
      ok('③b 中文行前的 URL 列号正确(按单元格宽度)', `${CJ.start.x}..${CJ.end.x}`);
    } else bad('③b 中文行 URL 列号偏移', cjk);

    // ---- ④ 折行:独立离屏终端(固定 24 列,不受主窗格自动 refit 干扰)----
    const wrap = await ev(c, `(function(){
      var host=document.createElement('div');
      host.style.cssText='position:fixed;left:-9999px;top:0;width:240px;height:120px';
      document.body.appendChild(host);
      var t2=new XTermClass({ cols: 24, rows: 6, scrollback: 100 });
      t2.open(host);
      var prov=registerTermLinks(t2);
      var longUrl='https://example.com/'+Array(81).join('a');
      t2.write('\\r\\n'+longUrl+'\\r\\n');
      return new Promise(function(resolve){
        setTimeout(function(){
          var b=t2.buffer.active;
          var startLine=-1;
          for(var i=0;i<b.length;i++){
            var ln=b.getLine(i);
            if(ln && ln.translateToString(true).indexOf('https://example.com/aaaa')>=0){ startLine=i+1; break; }
          }
          if(startLine<0){ cleanup(JSON.stringify({found:false, len:b.length})); return; }
          var wrapped=false;
          for(var j=startLine;j<Math.min(b.length,startLine+8);j++){ var l2=b.getLine(j); if(l2&&l2.isWrapped){wrapped=true;break;} }
          prov.provideLinks(startLine, function(links){
            cleanup(JSON.stringify({ found:true, wrapped:wrapped, want: longUrl,
              count: links?links.length:0,
              text: links&&links[0]?links[0].text:null,
              multiLine: !!(links&&links[0]&&links[0].range.start.y!==links[0].range.end.y) }));
          });
          function cleanup(json){ try{prov.dispose();}catch(e){} try{t2.dispose();}catch(e){} host.remove(); resolve(json); }
        }, 500);
      });
    })()`);
    const WR = JSON.parse(wrap);
    if (WR.wrapped) ok('④ 24 列窄终端里 URL 确实折行');
    else bad('④ URL 没折行(用例前提不成立)', wrap);
    if (WR.count === 1 && WR.text === WR.want) ok('④ 折行 URL 被拼回一条完整链接', `len=${(WR.text || '').length}`);
    else bad('④ 折行 URL 拼接失败', wrap);
    if (WR.multiLine) ok('④ 跨行 range(y 不同)'); else bad('④ range 没跨行', wrap);

    // ---- ⑤ 裸点击不打开 / 修饰键点击才打开(主进程测试钩子,不弹浏览器)----
    await ev(c, `(function(){ var t=state.tabs.get(${JSON.stringify(sid)}); t.term.resize(120, 30); t.term.write('\\r\\nhttps://example.com/click-test\\r\\n'); setStatus('', 'var(--text-dim)'); return true; })()`);
    await sleep(500);
    const clickNoMod = await ev(c, `(function(){
      var t=state.tabs.get(${JSON.stringify(sid)});
      var b=t.term.buffer.active, target=-1;
      for(var i=0; i<b.length; i++){ var ln=b.getLine(i); if(ln && ln.translateToString(true).indexOf('click-test')>=0){ target=i+1; break; } }
      if(target<0) return JSON.stringify({found:false});
      return new Promise(function(resolve){
        t.linkProvider.provideLinks(target, function(links){
          if(!links||!links.length){ resolve(JSON.stringify({found:true,links:0})); return; }
          links[0].activate({ metaKey:false, ctrlKey:false, preventDefault:function(){} }, links[0].text);
          resolve(JSON.stringify({ found:true, status: els.toolbarStatus.textContent }));
        });
      });
    })()`);
    const CN = JSON.parse(clickNoMod);
    if (CN.found && CN.status && /按住/.test(CN.status) && /click-test/.test(CN.status)) ok('⑤ 裸点击不打开,只提示要按修饰键', CN.status.slice(0, 40) + '…');
    else bad('⑤ 裸点击行为不符', clickNoMod);

    const clickMod = await ev(c, `(function(){
      var t=state.tabs.get(${JSON.stringify(sid)});
      var b=t.term.buffer.active, target=-1;
      for(var i=0; i<b.length; i++){ var ln=b.getLine(i); if(ln && ln.translateToString(true).indexOf('click-test')>=0){ target=i+1; break; } }
      return new Promise(function(resolve){
        t.linkProvider.provideLinks(target, function(links){
          if(!links||!links.length){ resolve(JSON.stringify({found:true,links:0})); return; }
          links[0].activate({ metaKey:true, ctrlKey:false, preventDefault:function(){} }, links[0].text);
          setTimeout(function(){ resolve(JSON.stringify({ found:true, status: els.toolbarStatus.textContent, color: els.toolbarStatus.style.color })); }, 600);
        });
      });
    })()`);
    const CM = JSON.parse(clickMod);
    if (CM.found && /已在系统浏览器打开:https:\/\/example\.com\/click-test/.test(CM.status || '')) ok('⑤ ⌘+点击打开正确 URL', CM.status);
    else bad('⑤ ⌘+点击没有打开/URL 不对', clickMod);

    // ---- ⑥ 主进程白名单:javascript:/file: 直接拒绝 ----
    const ipc = await ev(c, `(async function(){
      var js = await window.api.openExternal('javascript:alert(1)');
      var fl = await window.api.openExternal('file:///etc/passwd');
      var okk = await window.api.openExternal('https://example.com/ipc-ok');
      return JSON.stringify({ js: js, file: fl, https: okk });
    })()`);
    const IPC = JSON.parse(ipc);
    if (IPC.js && IPC.js.ok === false) ok('⑥ 主进程拒绝 javascript:', IPC.js.error);
    else bad('⑥ 主进程没拦住 javascript:', ipc);
    if (IPC.file && IPC.file.ok === false) ok('⑥ 主进程拒绝 file:', IPC.file.error);
    else bad('⑥ 主进程没拦住 file:', ipc);
    if (IPC.https && IPC.https.ok === true && IPC.https.skipped === true) ok('⑥ https 放行(测试钩子已拦截,未弹浏览器)');
    else bad('⑥ https 未放行', ipc);

    // ---- ⑦ 右键菜单:选中 URL 时出现「在系统浏览器打开」----
    const menu = await ev(c, `(function(){
      var t=state.tabs.get(${JSON.stringify(sid)});
      var b=t.term.buffer.active, target=-1, ln=null;
      for(var i=0; i<b.length; i++){ ln=b.getLine(i); if(ln && ln.translateToString(true).indexOf('click-test')>=0){ target=i; break; } }
      if(target<0) return JSON.stringify({found:false});
      var line=ln.translateToString(true);
      var col=line.indexOf('https://example.com/click-test');
      t.term.select(col, target, 'https://example.com/click-test'.length);
      var pane=t.term.element && t.term.element.closest('.term-pane');
      if(!pane) return JSON.stringify({found:true, pane:false});
      pane.dispatchEvent(new MouseEvent('contextmenu', { clientX: 400, clientY: 300, bubbles: true, cancelable: true }));
      var items=Array.prototype.map.call(document.querySelectorAll('#ctx-menu .ctx-item'), function(el){ return el.textContent.trim(); });
      closeCtxMenu();
      t.term.clearSelection();
      return JSON.stringify({ found:true, items: items });
    })()`);
    const M = JSON.parse(menu);
    if (M.found && (M.items || []).some((x) => /在系统浏览器打开/.test(x))) ok('⑦ 选中 URL 后右键有「在系统浏览器打开」', (M.items || []).join(' | '));
    else bad('⑦ 右键菜单缺打开入口', menu);

    const menuNoUrl = await ev(c, `(function(){
      var t=state.tabs.get(${JSON.stringify(sid)});
      t.term.select(0, 0, 5);
      var pane=t.term.element && t.term.element.closest('.term-pane');
      pane.dispatchEvent(new MouseEvent('contextmenu', { clientX: 400, clientY: 300, bubbles: true, cancelable: true }));
      var items=Array.prototype.map.call(document.querySelectorAll('#ctx-menu .ctx-item'), function(el){ return el.textContent.trim(); });
      closeCtxMenu(); t.term.clearSelection();
      return JSON.stringify({ items: items });
    })()`);
    const M2 = JSON.parse(menuNoUrl);
    if (!(M2.items || []).some((x) => /在系统浏览器打开/.test(x))) ok('⑦ 普通选中(非 URL)不出现该菜单项');
    else bad('⑦ 非 URL 也出现了打开菜单项', menuNoUrl);
  } catch (e) {
    failed++;
    console.error(`\n测试异常: ${e && e.message}`);
  } finally {
    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
    try { process.kill(-appProc.pid); } catch { /* ignore */ }
    await sleep(500);
    process.exit(failed ? 1 : 0);
  }
})();
