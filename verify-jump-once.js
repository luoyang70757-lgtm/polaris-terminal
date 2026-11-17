'use strict';
/**
 * verify-jump-once.js — 一次性连接经跳板机(纯 Node,不启 Electron)
 *
 * 背景:主终端会话的跳板(ssh -J)早就有(main.js openJumpTunnel),但
 * 批量执行 / AI 的 run_command / 系统类型探测 走的是一次性连接
 * (sshClient.execCommand),以前只拿 host/port/user/password → 目标只在内网可达时
 * 这三条链路必失败,而同一台机器在终端里明明连得上。
 *
 * 这里钉住 lib/jump-host.js 的约定:
 *   ① 归一化(host 为空视为无跳板、端口缺省 22、private_key/privateKey 两种写法)
 *   ② 跳板连接参数(用户名回落到目标账号、私钥路径→内容、指纹校验跟随目标会话设置)
 *   ③ 隧道(forwardOut 目标必须是目标机的 host:port;失败/超时必须收掉跳板连接)
 *   ④ withJump(无跳板零开销;有跳板时安装 sock、置空 jump、finally 必回收)
 * 运行: node verify-jump-once.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jh = require('./lib/jump-host');

let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e.message : '')); };
function t(name, fn) { try { fn(); ok(name); } catch (e) { bad(name, e); } }
async function ta(name, fn) {
  try { await fn(); ok(name); } catch (e) { bad(name, e); }
}
function rejects(p, re) {
  return p.then(
    () => { throw new Error('本该 reject 却成功了'); },
    (e) => { if (re && !re.test(e.message)) throw new Error(`错误信息不符: ${e.message}`); }
  );
}

function fakeConn() {
  const state = { ended: 0, forwarded: [], forwardError: null, hang: false };
  const conn = {
    ended: () => state.ended,
    forwarded: () => state.forwarded,
    forwardOut(srcHost, srcPort, host, port, cb) {
      state.forwarded.push({ srcHost, srcPort, host, port });
      if (state.hang) return; // 永不回调 → 触发转发超时
      cb(state.forwardError, state.forwardError ? null : fakeStream());
    },
    end() { state.ended++; },
  };
  state.conn = conn;
  return state;
}
function fakeStream() {
  return { destroyed: false, destroy() { this.destroyed = true; }, };
}

console.log('\n=== 一次性连接经跳板机(纯 Node) ===\n');

// ---------- ① 归一化 ----------
console.log('① 跳板配置归一化');
t('空值/无 host → 视为无跳板', () => {
  for (const v of [null, undefined, {}, { host: '' }, { host: '   ' }, 0, 1, 'x']) {
    assert.strictEqual(jh.normalizeJump(v), null, String(v));
  }
});
t('JSON 字符串也认(老库 sessions.jump 存的就是字符串)', () => {
  const j = jh.normalizeJump(JSON.stringify({ host: ' jump.example ', port: '2200', username: 'root' }));
  assert.deepStrictEqual(j, { host: 'jump.example', port: 2200, username: 'root', password: '', privateKey: '', passphrase: '' });
});
t('端口缺省 22、host 去空格', () => {
  const j = jh.normalizeJump({ host: ' jump.example ' });
  assert.strictEqual(j.host, 'jump.example');
  assert.strictEqual(j.port, 22);
});
t('private_key / privateKey 两种写法都认', () => {
  assert.strictEqual(jh.normalizeJump({ host: 'h', private_key: '/a/id_rsa' }).privateKey, '/a/id_rsa');
  assert.strictEqual(jh.normalizeJump({ host: 'h', privateKey: '/b/id_rsa' }).privateKey, '/b/id_rsa');
});

// ---------- ② 跳板连接参数 ----------
console.log('② 跳板连接参数');
t('用户名缺省沿用目标账号', () => {
  const o = jh.jumpConnectOpts({ host: 'jump.example', port: 2222 }, { username: 'deploy', verifyHostKey: false });
  assert.strictEqual(o.username, 'deploy');
  assert.strictEqual(o.host, 'jump.example');
  assert.strictEqual(o.port, 2222);
});
t('跳板机自己填了用户名就用它(不覆盖)', () => {
  const o = jh.jumpConnectOpts({ host: 'jump.example', username: 'jumpuser' }, { username: 'deploy' });
  assert.strictEqual(o.username, 'jumpuser');
});
t('私钥路径 → 私钥内容(ssh2 要内容)', () => {
  const f = path.join(os.tmpdir(), `polaris-jump-key-${Date.now()}`);
  fs.writeFileSync(f, '-----KEY-----');
  try {
    const o = jh.jumpConnectOpts({ host: 'h', privateKey: f, passphrase: 'pp' }, {});
    assert.strictEqual(String(o.privateKey), '-----KEY-----');
    assert.strictEqual(o.passphrase, 'pp');
  } finally { try { fs.unlinkSync(f); } catch { /* ignore */ } }
});
t('指纹校验跟随目标会话设置(默认装、verifyHostKey:false 不装)', () => {
  assert.strictEqual(typeof jh.jumpConnectOpts({ host: 'h' }, {}) .hostVerifier, 'function');
  assert.strictEqual(jh.jumpConnectOpts({ host: 'h' }, { verifyHostKey: false }).hostVerifier, undefined);
});
t('没有 host 直接报错(不能静默变成直连)', () => {
  assert.throws(() => jh.jumpConnectOpts({}, {}), /缺少 host/);
});

// ---------- ③ 隧道 ----------
console.log('③ 跳板隧道');
(async () => {
  await ta('forwardOut 目标 = 目标机 host:port(不是跳板机)', async () => {
    const st = fakeConn();
    const r = await jh.openTunnel({ host: 'jump.example', port: 2222 }, { host: 'inner.example', port: 2022, username: 'u' }, { connectRaw: async () => st.conn });
    assert.strictEqual(r.stream instanceof Object, true);
    assert.deepStrictEqual(st.forwarded, [{ srcHost: 'inner.example', srcPort: 0, host: 'inner.example', port: 2022 }]);
  });
  await ta('跳板连不上 → 抛错且不开转发', async () => {
    const st = fakeConn();
    await rejects(
      jh.openTunnel({ host: 'jump.example' }, { host: 'inner.example' }, { connectRaw: async () => { throw new Error('ECONNREFUSED'); } }),
      /ECONNREFUSED/
    );
    assert.strictEqual(st.forwarded.length, 0);
  });
  await ta('转发失败 → 收掉跳板连接再抛错(泄漏会攒连接)', async () => {
    const st = fakeConn();
    st.forwardError = new Error('forward failed');
    await rejects(
      jh.openTunnel({ host: 'jump.example' }, { host: 'inner.example' }, { connectRaw: async () => st.conn, timeoutMs: 50 }),
      /forward failed/
    );
    assert.strictEqual(st.conn.ended(), 1);
  });
  await ta('跳板握手成功但转发不响应 → 30s 兜底(这里用 50ms 模拟)且收连接', async () => {
    const st = fakeConn();
    st.hang = true;
    await rejects(
      jh.openTunnel({ host: 'jump.example' }, { host: 'inner.example' }, { connectRaw: async () => st.conn, timeoutMs: 50 }),
      /跳板机转发超时/
    );
    assert.strictEqual(st.conn.ended(), 1);
  });
  await ta('FORWARD_TIMEOUT_MS 与主会话一致(30s)', async () => {
    assert.strictEqual(jh.FORWARD_TIMEOUT_MS, 30000);
  });

  // ---------- ④ withJump ----------
  console.log('④ withJump(无跳板零开销 / 有跳板必回收)');
  await ta('没有跳板 → 原样调用,不建任何连接', async () => {
    let calls = 0;
    const opts = { host: 'h', username: 'u', jump: null };
    const out = await jh.withJump(opts, (o) => { calls++; assert.strictEqual(o, opts); return 'ok'; }, { connectRaw: async () => { throw new Error('不该连跳板'); } });
    assert.strictEqual(out, 'ok');
    assert.strictEqual(calls, 1);
  });
  await ta('有跳板 → fn 拿到 sock、jump 置空;sock 和跳板连接都被回收', async () => {
    const st = fakeConn();
    let seen = null;
    let sockAliveInFn = false;
    const out = await jh.withJump({ host: 'inner.example', port: 22, username: 'u', password: 'pw', jump: { host: 'jump.example' } },
      (o) => { seen = o; sockAliveInFn = !o.sock.destroyed; return 'out'; },
      { connectRaw: async (o) => {
        assert.strictEqual(o.host, 'jump.example'); // 连的是跳板机
        assert.strictEqual(String(o.password || ''), '');  // 目标密码不能发给跳板机
        return st.conn;
      } });
    assert.strictEqual(out, 'out');
    assert.strictEqual(sockAliveInFn, true); // 执行期间 sock 可用
    assert.strictEqual(seen.jump, null);
    assert.strictEqual(seen.host, 'inner.example');
    assert.strictEqual(seen.sock.destroyed, true); // finally 已 destroy
    assert.strictEqual(st.conn.ended(), 1);
  });
  await ta('fn 抛错也要回收跳板连接(否则每次失败攒一条)', async () => {
    const st = fakeConn();
    let sock = null;
    await rejects(
      jh.withJump({ host: 'inner.example', jump: { host: 'jump.example' } },
        (o) => { sock = o.sock; throw new Error('exec failed'); },
        { connectRaw: async () => st.conn }),
      /exec failed/
    );
    assert.strictEqual(sock.destroyed, true);
    assert.strictEqual(st.conn.ended(), 1);
  });
  await ta('跳板连不上 → fn 一次都不执行', async () => {
    let calls = 0;
    await rejects(
      jh.withJump({ host: 'inner.example', jump: { host: 'jump.example' } }, () => { calls++; }, { connectRaw: async () => { throw new Error('jump down'); } }),
      /jump down/
    );
    assert.strictEqual(calls, 0);
  });

  // ---------- ⑤ 接线(源码结构断言) ----------
  console.log('⑤ 三条一次性连接链路都已接线');
  const root = __dirname;
  const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const ipcSrc = fs.readFileSync(path.join(root, 'lib/session-ipc.js'), 'utf8');
  const renSrc = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');
  t('main.js:批量执行与 AI 命令都走 jumpHost.withJump', () => {
    assert.strictEqual((mainSrc.match(/jumpHost\.withJump\(/g) || []).length, 2);
    assert.ok(/jump: \(h && h\.jump\) \|\| null/.test(mainSrc), 'batch/AI 的 opts 要带 jump');
  });
  t('session-ipc:sessions:detectOs 走 jumpHost.withJump', () => {
    assert.strictEqual((ipcSrc.match(/jumpHost\.withJump\(/g) || []).length, 1);
  });
  t('renderer:批量执行 / AI 对话 / OS 探测的 payload 都带 jump', () => {
    assert.strictEqual((renSrc.match(/jump: t\.session\.jump && t\.session\.jump\.host \? t\.session\.jump : null/g) || []).length, 3);
  });
  t('会话弹窗「测试连接」也经跳板(否则内网主机永远显示端口未开放)', () => {
    assert.strictEqual((mainSrc.match(/jumpHost\.openTunnel\(/g) || []).length, 1);
    assert.ok(/跳板机连接失败/.test(mainSrc));
    assert.ok(/window\.api\.testConnect\(\{[\s\S]{0,120}jump,/.test(renSrc), '测试连接 payload 要带 jump');
  });
  t('没有把跳板字段顺手发到 WinSCP payload(那条链路独立,另案)', () => {
    assert.ok(!/winScpPayloadFor[\s\S]{0,400}jump:/.test(renSrc));
  });

  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
})();
