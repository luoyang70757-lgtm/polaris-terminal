#!/usr/bin/env node
'use strict';
/**
 * dev/jumpserver/polaris-dev.mjs — 用本地 Docker 里的 JumpServer 联调 Polaris 的「堡垒机」功能
 *
 * 做三件事：
 *   1) 检查 docker JumpServer 是否就绪（http://127.0.0.1:8080/api/health/）
 *   2) 把 JumpServer 连接信息写进 Polaris 数据目录的 jms-servers.json
 *      （渲染层启动时读该文件 → 静默重登 → 自动拉资产，省得每次手填地址/账号）
 *   3) 拉起 Polaris 开发版，并**关掉内置 mock**（POLARIS_NO_MOCK=1）：
 *      mock 默认占 8080/2222，正好和 docker 的 jms_web / jms_koko 撞端口
 *
 * 起来之后：左侧会话列表「🛡 堡垒机」下直接有 `dev-target-01`，双击即经 KoKo 网关连进目标机。
 *
 * 用法：
 *   node dev/jumpserver/polaris-dev.mjs                  # 数据目录 <repo>/.polaris-data
 *   node dev/jumpserver/polaris-dev.mjs --dir=D:\tmp\pl  # 指定数据目录
 *   node dev/jumpserver/polaris-dev.mjs --no-launch      # 只写配置，不开窗口
 *   node dev/jumpserver/polaris-dev.mjs --up             # JumpServer 没起时先跑 setup.mjs
 *
 * 独立冒烟自检（自己起应用、解锁、自动重登、连资产、断言终端出 shell）：
 *   node dev/jumpserver/smoke-bastion.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveEndpoints } from './endpoints.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const has = (name) => args.includes(`--${name}`);

// 地址优先问运行中的 docker 容器（jms_web/jms_koko 的宿主机映射端口），不再写死 8080/2222
const ep = resolveEndpoints({ httpPort: opt('http-port'), kokoPort: opt('koko-port') });
const HTTP_PORT = Number(ep.baseUrl.split(':').pop());
const KOKO_PORT = ep.sshPort;
const BASE_URL = opt('url', ep.baseUrl);
const ACCOUNT = opt('account', 'polaris');
const PASSWORD = opt('password', 'Polaris@123');
const LOCK_DIR = path.resolve(opt('dir', path.join(ROOT, '.polaris-data')));
const SERVER_ID = 'jms-docker-dev';

const health = async () => {
  try {
    const r = await fetch(`${BASE_URL}/api/health/`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
};

const up = () => {
  console.log('[polaris-dev] 拉起 docker JumpServer（node dev/jumpserver/setup.mjs）…');
  const r = spawnSync(process.execPath, [path.join(HERE, 'setup.mjs')], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('setup.mjs 失败，先修好 docker 环境');
};

const writeConfig = () => {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const servers = [{
    id: SERVER_ID,
    name: 'Docker JumpServer (dev)',
    baseUrl: BASE_URL,
    sshHost: '127.0.0.1',
    sshPort: Number(KOKO_PORT) || 2222,
    account: ACCOUNT,
    password: PASSWORD,
    loggedOut: false, // false → 渲染层启动时自动静默重登 + 拉资产
  }];
  const file = path.join(LOCK_DIR, 'jms-servers.json');
  fs.writeFileSync(file, JSON.stringify(servers, null, 2));
  console.log(`[polaris-dev] 写入 ${file}`);
  console.log(`[polaris-dev]   ${BASE_URL} · ${ACCOUNT} · 网关 127.0.0.1:${KOKO_PORT}`);
};

const launch = () => {
  const electron = require('electron'); // 纯 Node 下返回二进制绝对路径
  console.log('[polaris-dev] 启动 Polaris（--dev，mock 已关闭）…');
  const child = spawn(electron, ['.', '--dev', '--no-sandbox', '--disable-gpu'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      POLARIS_LOCK_DIR: LOCK_DIR,
      POLARIS_NO_MOCK: '1', // 不要用 mock 抢 8080/2222
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
  });
  child.on('exit', (code) => process.exit(code == null ? 0 : code));
};

(async () => {
  if (!(await health())) {
    if (has('up')) up();
    else {
      console.error(`[polaris-dev] ✗ ${BASE_URL} 不可用。`);
      console.error('              先起环境：node dev/jumpserver/setup.mjs   （或加 --up 让本脚本代跑）');
      process.exit(1);
    }
  }
  console.log(`[polaris-dev] ✓ JumpServer 就绪 ${BASE_URL}（地址来源：${ep.source.web}）`);
  console.log(`[polaris-dev]   KoKo 网关 127.0.0.1:${KOKO_PORT}（来源：${ep.source.koko}；容器内 ${ep.container.ip || '?'}:${ep.container.kokoPort}）`);
  writeConfig();
  if (has('no-launch')) {
    console.log('[polaris-dev] 只写配置（--no-launch）：现在可自行 `npm run dev`，别忘了 POLARIS_NO_MOCK=1');
    return;
  }
  launch();
})().catch((e) => {
  console.error('[polaris-dev] ✗', e.message);
  process.exit(1);
});
