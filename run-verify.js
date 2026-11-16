'use strict';
/**
 * run-verify.js — 全量回归入口(串行执行 verify-*.js 并汇总)
 *
 * 背景:旧的全量入口 `test-all.js` 含真实环境凭据 → 被 .gitignore 排除,新克隆里没有,
 * 导致「怎么跑全量回归」只能靠记忆。本脚本只做「发现 → 串行执行 → 汇总」,
 * 不内置任何凭据或环境假设,因此可以入库、也能在 CI 里跑。
 *
 * 用法:
 *   node run-verify.js                 # 全套(自动跳过需要真机/真实凭据与视觉快照脚本)
 *   node run-verify.js --pure          # 只跑纯 Node 断言(不启 electron,CI 无显示环境可用)
 *   node run-verify.js --e2e           # 只跑 CDP e2e(需要桌面显示;Linux 用 xvfb-run)
 *   node run-verify.js --only=bastion  # 只跑文件名包含该子串的(可多次传)
 *   node run-verify.js --list          # 只列出计划执行的脚本
 *   node run-verify.js --timeout=240   # 单个脚本超时(秒,默认 180)
 *   node run-verify.js --retry=1       # 失败脚本重跑次数(默认 1;e2e 受 CDP/mock 抖动影响,
 *                                      #   重跑通过会标「flaky」;--retry=0 严格一次定生死)
 *   node run-verify.js --fail-fast     # 首个失败即停
 *
 * 退出码:0 = 全部通过;1 = 有失败;2 = 用法错误 / 没有匹配脚本。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;

// 需要真实主机/真实凭据(环境变量)的脚本:默认不跑,避免整套回归被环境卡住。
const NEEDS_REAL = new Set([
  'verify-realjms.js',   // 真实 JumpServer(脚本本身 gitignore,存在才被发现)
  'verify-realdl.js',
  'verify-ui-dl.js',
  'verify-tcc.js',       // macOS TCC 权限实测
]);

// 视觉快照脚本(只看图不产出断言结论):默认不跑。
const VISUAL = new Set(['verify-shots.js']);

// CDP e2e 的判定:脚本自己拉 electron 并开调试端口。纯 Node 断言脚本不含该参数。
const E2E_MARK = /remote-debugging-port/;

function parseArgs(argv) {
  const opt = { only: [], timeoutSec: 180, retry: 1, failFast: false, list: false, mode: 'all' };
  for (const a of argv.slice(2)) {
    if (a === '--pure') opt.mode = 'pure';
    else if (a === '--e2e') opt.mode = 'e2e';
    else if (a === '--all') opt.mode = 'all';
    else if (a === '--list') opt.list = true;
    else if (a === '--fail-fast') opt.failFast = true;
    else if (a.startsWith('--only=')) opt.only.push(a.slice('--only='.length));
    else if (a.startsWith('--timeout=')) opt.timeoutSec = Number(a.slice('--timeout='.length)) || 180;
    else if (a.startsWith('--retry=')) opt.retry = Math.max(0, Number(a.slice('--retry='.length)) || 0);
    else if (a === '-h' || a === '--help') opt.help = true;
    else { console.error(`未知参数:${a}(用 --help 看用法)`); process.exit(2); }
  }
  return opt;
}

function discover() {
  const files = fs.readdirSync(ROOT)
    .filter((f) => /^verify-.*\.js$/.test(f))
    .sort();
  return files.map((f) => {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    return {
      file: f,
      e2e: E2E_MARK.test(text),
      needsReal: NEEDS_REAL.has(f),
      visual: VISUAL.has(f),
    };
  });
}

const SUMMARY_RES = [
  /结果:\s*(\d+)\s*通过[,,]\s*(\d+)\s*失败/,      // "结果: 20 通过, 0 失败"
  /通过\s*(\d+)\s*项断言/,                        // "verify-ssh-config 通过 16 项断言"
  /通过\s*(\d+)\s*\/\s*(\d+)/,                    // "通过 13/13"
];

function parseCounts(out) {
  for (const re of SUMMARY_RES) {
    const m = out.match(re);
    if (m) {
      if (m.length === 3) return { pass: Number(m[1]), fail: Number(m[2]) };
      return { pass: Number(m[1]), fail: 0 };
    }
  }
  return null;
}

function runOne(file, timeoutSec) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(ROOT, file)], {
      cwd: ROOT,
      detached: true, // 独立进程组:超时能连 electron 子进程一起收掉
      env: { ...process.env, POLARIS_VERIFY_RUNNER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let timedOut = false;
    const cap = (s) => { const v = s.toString(); if (out.length < 400000) out += v; };
    child.stdout.on('data', cap);
    child.stderr.on('data', (s) => { const v = s.toString(); if (err.length < 200000) err += v; if (out.length < 400000) out += v; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
    }, Math.max(10, timeoutSec) * 1000);

    child.on('close', (code) => {
      clearTimeout(timer);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const counts = parseCounts(out);
      resolve({
        file, code, timedOut, secs, counts,
        ok: !timedOut && code === 0 && (!counts || counts.fail === 0),
        out, err,
      });
    });
  });
}

(async () => {
  const opt = parseArgs(process.argv);
  if (opt.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^'use strict';\n\/\*\*?\n?/, ''));
    process.exit(0);
  }

  let plan = discover();
  if (opt.mode === 'pure') plan = plan.filter((p) => !p.e2e);
  if (opt.mode === 'e2e') plan = plan.filter((p) => p.e2e);

  const skipped = [];
  plan = plan.filter((p) => {
    if (p.needsReal && !opt.only.length) { skipped.push(`${p.file}(需真实环境)`); return false; }
    if (p.visual && !opt.only.length) { skipped.push(`${p.file}(视觉快照)`); return false; }
    if (opt.only.length && !opt.only.some((s) => p.file.includes(s))) return false;
    return true;
  });

  if (!plan.length) {
    console.error('没有匹配的 verify 脚本');
    process.exit(2);
  }

  if (opt.list) {
    for (const p of plan) console.log(`${p.e2e ? 'e2e ' : 'pure'}  ${p.file}`);
    if (skipped.length) console.log(`\n跳过:${skipped.join('、')}`);
    process.exit(0);
  }

  const modeLabel = opt.mode === 'pure' ? '纯 Node' : opt.mode === 'e2e' ? 'CDP e2e' : '全套';
  console.log(`\n=== Polaris 回归(${modeLabel}) ===`);
  console.log(`计划 ${plan.length} 个脚本,单脚本超时 ${opt.timeoutSec}s`);
  if (skipped.length) console.log(`跳过 ${skipped.length} 个:${skipped.join('、')}`);
  console.log('');

  const results = [];
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    const idx = `[${String(i + 1).padStart(2, ' ')}/${plan.length}]`;
    process.stdout.write(`${idx} ${p.file} … `);
    let r = await runOne(p.file, opt.timeoutSec);
    let flaky = false;
    for (let k = 0; k < opt.retry && !r.ok; k++) {
      process.stdout.write('↻ ');
      r = await runOne(p.file, opt.timeoutSec);
      flaky = r.ok;
    }
    r.flaky = flaky;
    results.push(r);
    const cnt = r.counts ? `${r.counts.pass}/${r.counts.pass + r.counts.fail}` : '-';
    console.log(`${r.ok ? (flaky ? '✅(flaky)' : '✅') : '❌'} ${r.secs}s 断言 ${cnt}${r.timedOut ? ' (超时)' : ''}${!r.ok && !r.counts ? ` exit=${r.code}` : ''}`);
    if (!r.ok) {
      const tail = (r.out || '').trim().split('\n').slice(-25).join('\n');
      console.log(`----- ${p.file} 输出尾部 -----\n${tail}\n---------------------------`);
      if (opt.failFast) { console.log('--fail-fast:已停止'); break; }
    }
  }

  const failed = results.filter((r) => !r.ok);
  const pass = results.length - failed.length;
  const asserts = results.reduce((s, r) => s + (r.counts ? r.counts.pass : 0), 0);
  const assertFails = results.reduce((s, r) => s + (r.counts ? r.counts.fail : 0), 0);

  console.log(`\n=== 汇总 ===`);
  console.log(`脚本:${pass}/${results.length} 通过${failed.length ? `,失败 ${failed.length}:${failed.map((f) => f.file).join('、')}` : ''}`);
  console.log(`断言:${asserts} 通过${assertFails ? `,${assertFails} 失败` : ''}`);
  const flaky = results.filter((r) => r.flaky);
  if (flaky.length) console.log(`flaky(首次失败、重跑通过 ${opt.retry} 次内):${flaky.map((f) => f.file).join('、')}`);
  if (failed.length) {
    console.log('\n失败脚本(逐个单独复跑定位):');
    for (const f of failed) console.log(`  node ${f.file}`);
  }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('runner 异常:', (e && e.stack) || e);
  process.exit(2);
});
