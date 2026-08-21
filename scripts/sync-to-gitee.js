#!/usr/bin/env node
'use strict';
/**
 * sync-to-gitee.js — 把 GitHub Release 产物同步到 gitee Release(码云镜像发布用)。
 * gitee 不构建(无 mac 构建机 / Windows 需 wine),只接收 GitHub 已编译的产物。
 *
 * 用法:
 *   GITEE_TOKEN=xxx [GITEE_OWNER=xxx GITEE_REPO=xxx] \
 *     node scripts/sync-to-gitee.js --tag v1.0.6 --assets-dir <目录>
 *
 * 流程:按 tag 找 gitee Release(没有则创建)→ 逐个上传目录里的附件。
 * 只依赖 Node 18+ 内置 fetch/FormData,无第三方依赖,CI 和本机都能跑。
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--tag') opt.tag = args[++i];
  else if (args[i] === '--assets-dir') opt.assetsDir = args[++i];
  else if (args[i] === '--body') opt.body = args[++i];
}
if (!opt.tag) { console.error('缺少 --tag'); process.exit(1); }

const TOKEN = process.env.GITEE_TOKEN;
const OWNER = process.env.GITEE_OWNER || 'major1937';
const REPO = process.env.GITEE_REPO || 'polaris-terminal';
if (!TOKEN) { console.error('缺少 GITEE_TOKEN 环境变量'); process.exit(1); }

const API = `https://gitee.com/api/v5/repos/${OWNER}/${REPO}`;

async function findRelease() {
  const r = await fetch(`${API}/releases/tags/${encodeURIComponent(opt.tag)}?access_token=${TOKEN}`);
  if (r.ok) return r.json();
  return null; // 404 等 → 需要创建
}

async function createRelease() {
  const form = new URLSearchParams();
  form.set('access_token', TOKEN);
  form.set('tag_name', opt.tag);
  form.set('name', `Polaris ${opt.tag}`);
  form.set('body', opt.body || `Polaris ${opt.tag}（由 GitHub Release 自动同步）`);
  form.set('target_commitish', 'main');
  const r = await fetch(`${API}/releases`, { method: 'POST', body: form });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`创建 gitee Release 失败 HTTP ${r.status}: ${t.slice(0, 300)}`);
  }
  return r.json();
}

const SPLIT_LIMIT = 90 * 1024 * 1024; // gitee 单附件上限 100MB,留余量用 90MB 切段
const SPLIT_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gitee-split-'));

async function uploadOne(releaseId, filePath, name) {
  const fd = new FormData();
  fd.append('access_token', TOKEN);
  fd.append('file', new Blob([fs.readFileSync(filePath)]), name);
  const r = await fetch(`${API}/releases/${releaseId}/attach_files`, { method: 'POST', body: fd });
  if (r.ok) { console.log(`  ✓ ${name}`); return true; }
  console.log(`  ✗ ${name}: HTTP ${r.status} ${(await r.text()).slice(0, 150)}`);
  return false;
}

// 超限文件切成 ≤90MB 多段(纯 Node,不依赖系统 split),返回 [临时文件路径...]
function splitFile(filePath) {
  const size = fs.statSync(filePath).size;
  const chunk = SPLIT_LIMIT;
  const parts = [];
  const buf = Buffer.alloc(1024 * 1024);
  const src = fs.openSync(filePath, 'r'); // readSync/writeSync 第一个参数是 fd,不是路径
  let done = 0, n = 1;
  while (done < size) {
    const want = Math.min(chunk, size - done);
    const p = path.join(SPLIT_DIR, `part-${String(n).padStart(2, '0')}`);
    const fd = fs.openSync(p, 'w');
    let w = 0;
    while (w < want) {
      const r = fs.readSync(src, buf, 0, Math.min(buf.length, want - w), done + w);
      if (r <= 0) break;
      fs.writeSync(fd, buf, 0, r);
      w += r;
    }
    fs.closeSync(fd);
    parts.push(p);
    done += want; n++;
  }
  fs.closeSync(src);
  return parts;
}

async function uploadAssets(releaseId, dir) {
  if (!dir || !fs.existsSync(dir)) { console.log('  (无附件目录,跳过)'); return 0; }
  const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());
  if (!files.length) { console.log('  (附件目录为空)'); return 0; }
  let n = 0;
  const noteParts = [];
  for (const f of files) {
    const p = path.join(dir, f);
    const size = fs.statSync(p).size;
    if (size <= SPLIT_LIMIT) {
      if (await uploadOne(releaseId, p, f)) n++;
    } else {
      const parts = splitFile(p);
      for (const [i, part] of parts.entries()) {
        const partName = `${f}.part${String(i + 1).padStart(2, '0')}`;
        if (await uploadOne(releaseId, part, partName)) { n++; noteParts.push(partName); }
      }
    }
  }
  if (noteParts.length) {
    console.log(`\n⚠️ ${noteParts[0].replace(/\.part\d+$/, '')} 超过 gitee 单附件 100MB 上限,已切成多段。`);
    console.log('   下载全部 part 后拼接再解压:\n   cat ' + noteParts.join(' ') + ' > ' + noteParts[0].replace(/\.part\d+$/, ''));
  }
  return n;
}

(async () => {
  console.log(`同步 ${opt.tag} → gitee(${OWNER}/${REPO})`);
  let rel = await findRelease();
  if (rel) console.log('Release 已存在,复用 id=' + rel.id);
  else { rel = await createRelease(); console.log('已创建 Release id=' + rel.id); }
  const n = await uploadAssets(rel.id, opt.assetsDir);
  console.log(`完成:${n} 个附件已上传`);
  console.log(`地址: https://gitee.com/${OWNER}/${REPO}/releases/tag/${opt.tag}`);
})().catch((e) => { console.error('❌ ' + e.message); process.exit(1); });
