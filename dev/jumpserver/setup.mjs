#!/usr/bin/env node
'use strict';
/**
 * dev/jumpserver/setup.mjs — 一键起一套开发/测试用 JumpServer（社区版 v4，Docker Desktop）
 *
 * 做的事：
 *   1) 生成 .env（compose 插值）+ config/config.txt / config_safe.txt（容器 env_file）+ redis.conf
 *   2) docker compose pull / up -d（含可选的测试目标机 target profile）
 *   3) 等容器 healthy → docker exec jms_core ./jms upgrade_db（建表 / 迁移）
 *   4) 调 JumpServer API 建种子数据：测试主机、系统用户、账号、授权、普通用户
 *   5) 打印 Polaris 里该填的「JumpServer 地址 / SSH 网关 / 账号」以及验证命令
 *
 * 用法：
 *   node dev/jumpserver/setup.mjs              # 幂等：已装则只补齐/更新种子数据
 *   node dev/jumpserver/setup.mjs --reset      # 先 down -v 删库重装（数据目录也清）
 *   node dev/jumpserver/setup.mjs --no-target  # 不拉起测试目标机（默认拉起）
 *   node dev/jumpserver/setup.mjs --infra-only # 只起服务，不建种子数据
 *
 * 依赖：Node 18+（内置 fetch）、Docker Desktop（linux 容器）。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const COMPOSE = path.join(HERE, 'docker-compose.yml');
const CONFIG_DIR = path.join(HERE, 'config');
const DATA_DIR = path.join(HERE, 'data');
const ENV_FILE = path.join(HERE, '.env');

const args = process.argv.slice(2);
const has = (k) => args.includes(k);
const RESET = has('--reset');
const WITH_TARGET = !has('--no-target');
const INFRA_ONLY = has('--infra-only');

const HTTP_PORT = process.env.JMS_HTTP_PORT || '8080';
const KOKO_SSH_PORT = process.env.JMS_KOKO_SSH_PORT || '2222';
const VERSION = process.env.JMS_VERSION || 'v4.10.20-ce';
const BASE = `http://127.0.0.1:${HTTP_PORT}`;

const ADMIN_PASSWORD = 'ChangeMe';
const SEED = {
  user: { username: 'polaris', name: 'Polaris 开发账号', password: 'Polaris@123' },
  systemUser: { name: 'polaris-dev', username: 'polaris', password: 'Polaris@123' },
  asset: { name: 'dev-target-01', address: 'target', port: 2222 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);

function sh(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { stdio: 'inherit', cwd: HERE, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} 失败（exit=${r.status}）`);
}
function shOut(cmd, argv, opts = {}) {
  return execFileSync(cmd, argv, { encoding: 'utf8', cwd: HERE, ...opts }).trim();
}
const compose = (argv, opts) => sh('docker', ['compose', '-f', COMPOSE, ...argv], opts);

// ---------------------------------------------------------------- 1. 生成配置
const rand = (n) => {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from(crypto.randomBytes(n)).map((b) => chars[b % chars.length]).join('');
};
const readEnvFile = (file) => {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
};
const writeIfChanged = (file, content) => {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 });
  return true;
};

const REDIS_CONF = `daemonize no
port 6379
timeout 300
loglevel notice
databases 16
save 900 1
save 300 10
save 60 10000
dbfilename dump.rdb
rdbcompression yes
dir /data
maxclients 20480
maxmemory 256mb
maxmemory-policy allkeys-lru
appendonly no
`;

function ensureConfig({ regenerateSecrets = false } = {}) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(path.join(CONFIG_DIR, 'certs'), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'nginx', 'logs'), { recursive: true });

  const old = readEnvFile(ENV_FILE);
  const secretKey = (!regenerateSecrets && old.SECRET_KEY) || rand(50);
  const bootstrapToken = (!regenerateSecrets && old.BOOTSTRAP_TOKEN) || rand(16);
  const dbPassword = (!regenerateSecrets && old.DB_PASSWORD) || rand(24);
  const redisPassword = (!regenerateSecrets && old.REDIS_PASSWORD) || rand(24);
  const targetPassword = (!regenerateSecrets && old.TARGET_PASSWORD) || 'Polaris@123';

  // compose 插值用
  writeIfChanged(ENV_FILE, [
    `VERSION=${VERSION}`,
    `HTTP_PORT=${HTTP_PORT}`,
    `KOKO_SSH_PORT=${KOKO_SSH_PORT}`,
    `KOKO_WEB_PROXY_PORT=${process.env.JMS_KOKO_WEB_PROXY_PORT || '5001'}`,
    `DB_NAME=jumpserver`,
    `DB_USER=postgres`,
    `DB_PASSWORD=${dbPassword}`,
    `REDIS_PASSWORD=${redisPassword}`,
    `TARGET_USER=${SEED.systemUser.username}`,
    `TARGET_PASSWORD=${targetPassword}`,
    `TZ=Asia/Shanghai`,
    '',
  ].join('\n'));

  // core / celery 的 env_file（含数据库口令）
  const config = [
    '### Polaris 开发用 JumpServer 配置（由 dev/jumpserver/setup.mjs 生成，勿提交）',
    `VOLUME_DIR=/opt/jumpserver/data`,
    `SECRET_KEY=${secretKey}`,
    `BOOTSTRAP_TOKEN=${bootstrapToken}`,
    `LOG_LEVEL=INFO`,
    `DB_ENGINE=postgresql`,
    `DB_HOST=postgresql`,
    `DB_PORT=5432`,
    `DB_USER=postgres`,
    `DB_PASSWORD=${dbPassword}`,
    `DB_NAME=jumpserver`,
    `REDIS_HOST=redis`,
    `REDIS_PORT=6379`,
    `REDIS_PASSWORD=${redisPassword}`,
    `CORE_HOST=http://core:8080`,
    `PERIOD_TASK_ENABLED=true`,
    `SESSION_EXPIRE_AT_BROWSER_CLOSE=false`,
    // 网页登录 / 终端 WebSocket 的可信来源：走 localhost 与 127.0.0.1 两种写法
    `DOMAINS=localhost:${HTTP_PORT},127.0.0.1:${HTTP_PORT}`,
    `SERVER_HOSTNAME=jms-dev`,
    `KOKO_SSH_PORT=2222`,
    `KOKO_WEB_PROXY_PORT=5001`,
    `USE_LB=1`,
    `TZ=Asia/Shanghai`,
    `CURRENT_VERSION=${VERSION}`,
    `LANGUAGE_CODE=zh-hans`,
    `JUMPSERVER_ENABLE_FONT_SMOOTHING=true`,
    `CONTAINER_HEALTH_TIMEOUT=300`,
    // CE 没有 video-worker，强制关掉录制机提交，避免 KoKo 反复重试
    `ENABLE_VIDEO_WORKER=false`,
    '',
  ].join('\n');
  writeIfChanged(path.join(CONFIG_DIR, 'config.txt'), config);

  // koko / chen / kael 用安全配置（去掉数据库口令）
  const safe = config
    .split('\n')
    .filter((l) => !/^(DB_HOST|DB_PORT|DB_PASSWORD)=/.test(l))
    .join('\n');
  writeIfChanged(path.join(CONFIG_DIR, 'config_safe.txt'), safe);
  writeIfChanged(path.join(CONFIG_DIR, 'redis.conf'), REDIS_CONF);

  return { secretKey, bootstrapToken, dbPassword, redisPassword, targetPassword };
}

// ---------------------------------------------------------------- 2. 起容器
function composeArgs(extra = []) {
  return ['-f', COMPOSE, ...(WITH_TARGET ? ['--profile', 'target'] : []), ...extra];
}

function up() {
  compose(composeArgs(['pull', '--quiet']), { stdio: 'inherit' });
  compose(composeArgs(['up', '-d']));
}

function containerHealthy(name, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    try {
      const s = shOut('docker', ['inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', name]);
      if (s === 'healthy' || s === 'running') return s;
    } catch { /* 容器还没建好 */ }
    spawnSync('sleep', ['2']);
  }
  return null;
}

function waitInfra() {
  const want = [
    ['jms_postgresql', 180],
    ['jms_redis', 60],
  ];
  for (const [name, t] of want) {
    log(`  · 等待 ${name} …`);
    if (!containerHealthy(name, t)) throw new Error(`${name} 未能健康启动`);
  }
}

function waitCore() {
  log('  · 等待 jms_core …');
  if (!containerHealthy('jms_core', 420)) {
    shOut('docker', ['logs', '--tail', '80', 'jms_core'], { stdio: 'inherit' });
    throw new Error('jms_core 未能启动（首启动会做 collectstatic / migrate，慢是正常的，可重跑本脚本）');
  }
}

function migrateDb() {
  log('  · 初始化数据库（./jms upgrade_db）…');
  sh('docker', ['exec', '-i', 'jms_core', 'bash', '-c', './jms upgrade_db']);
}

async function waitHttp(url, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (r.ok) return true;
    } catch { /* not ready */ }
    await sleep(1500);
  }
  return false;
}

// ---------------------------------------------------------------- 3. 种子数据
async function api(method, urlPath, { token, body, allowFail = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(BASE + urlPath, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok && !allowFail) {
    throw new Error(`${method} ${urlPath} → HTTP ${r.status}: ${typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}`);
  }
  return { status: r.status, data };
}

async function login(username, password) {
  const r = await api('POST', '/api/v1/authentication/auth/', {
    body: { username, password },
    allowFail: true,
  });
  if (r.status === 200 && r.data && r.data.token) return r.data;
  return null;
}

/** 分页拉全量（DRF 默认 page_size 可能很小） */
async function listAll(urlPath, token) {
  const out = [];
  let url = urlPath;
  for (let i = 0; i < 50; i++) {
    const r = await api('GET', url.startsWith('http') ? url.replace(BASE, '') : url, { token });
    if (Array.isArray(r.data)) { out.push(...r.data); break; }
    out.push(...((r.data && r.data.results) || []));
    const next = r.data && r.data.next;
    if (!next) break;
    url = next;
  }
  return out;
}

async function seed(adminToken) {
  const t = adminToken;
  const findByName = (list, name) => list.find((x) => x.name === name);

  // ① 普通用户（Polaris 里登录用的 JMS 用户）
  let users = await listAll('/api/v1/users/users/?limit=200', t);
  let user = users.find((u) => u.username === SEED.user.username);
  if (!user) {
    const r = await api('POST', '/api/v1/users/users/', {
      token, body: { name: SEED.user.name, username: SEED.user.username, password: SEED.user.password, role: 'user' },
    });
    user = r.data;
    log(`  · 创建用户 ${SEED.user.username}`);
  } else {
    await api('PATCH', `/api/v1/users/users/${user.id}/`, { token, body: { password: SEED.user.password } });
    log(`  · 用户 ${SEED.user.username} 已存在（口令已重置）`);
  }

  // ② 系统用户（连目标主机用的账号，口令存在堡垒机里）
  let sysUsers = await listAll('/api/v1/assets/system-users/?limit=200', t);
  let sysUser = findByName(sysUsers, SEED.systemUser.name);
  const sysBody = {
    name: SEED.systemUser.name,
    username: SEED.systemUser.username,
    password: SEED.systemUser.password,
    protocol: 'ssh',
  };
  if (!sysUser) {
    sysUser = (await api('POST', '/api/v1/assets/system-users/', { token: t, body: sysBody })).data;
    log(`  · 创建系统用户 ${SEED.systemUser.name}`);
  } else {
    await api('PATCH', `/api/v1/assets/system-users/${sysUser.id}/`, { token: t, body: sysBody });
    log(`  · 系统用户 ${SEED.systemUser.name} 已存在`);
  }

  // ③ 资产（目标主机）
  let assets = await listAll('/api/v1/assets/hosts/?limit=200', { token: t }).catch(() => []);
  if (!assets.length) assets = await listAll('/api/v1/assets/assets/?limit=200', t);
  let asset = findByName(assets, SEED.asset.name);
  const assetBody = {
    name: SEED.asset.name,
    address: SEED.asset.address,
    platform: 'Linux',
    protocols: [{ name: 'ssh', port: SEED.asset.port }],
    nodes: [],
    comment: 'Polaris 回归用目标机（docker compose profile: target）',
  };
  if (!asset) {
    asset = (await api('POST', '/api/v1/assets/hosts/', { token: t, body: assetBody })).data;
    log(`  · 创建资产 ${SEED.asset.name}（${SEED.asset.address}:${SEED.asset.port}）`);
  } else {
    await api('PATCH', `/api/v1/assets/hosts/${asset.id}/`, { token: t, body: assetBody });
    log(`  · 资产 ${SEED.asset.name} 已存在`);
  }

  // ④ 把系统用户"推送"成资产上的账号（等价于 Web 上的「资产 → 账号 → 添加」）
  const accounts = await listAll('/api/v1/accounts/accounts/?limit=500', t);
  const exists = accounts.find((a) => a.asset && a.asset.id === asset.id && a.username === SEED.systemUser.username);
  if (!exists) {
    await api('POST', '/api/v1/accounts/accounts/', {
      token: t,
      body: {
        asset: asset.id,
        username: SEED.systemUser.username,
        secret_type: 'password',
        secret: SEED.systemUser.password,
        systemuser: sysUser.id,
        privileged: false,
        is_active: true,
      },
      allowFail: true,
    });
    log('  · 资产账号已建立');
  }

  // ⑤ 资产授权：polaris 用户 → 资产 → 系统用户
  const perms = await listAll('/api/v1/perms/asset-permissions/?limit=200', t);
  const permName = 'polaris-dev-all';
  const permBody = {
    name: permName,
    users: [user.id],
    assets: [asset.id],
    system_users: [sysUser.id],
    actions: ['connect', 'upload', 'download', 'copy', 'paste'],
    is_active: true,
  };
  const perm = perms.find((p) => p.name === permName);
  if (!perm) {
    await api('POST', '/api/v1/perms/asset-permissions/', { token: t, body: permBody });
    log(`  · 创建资产授权 ${permName}`);
  } else {
    await api('PATCH', `/api/v1/perms/asset-permissions/${perm.id}/`, { token: t, body: permBody });
    log(`  · 资产授权 ${permName} 已存在`);
  }
}

// ---------------------------------------------------------------- main
async function main() {
  log('\n=== JumpServer（开发用，Docker Desktop）部署 ===');
  log(`  目录: ${HERE}`);
  log(`  镜像版本: ${VERSION} / Web: ${BASE} / KoKo SSH: 127.0.0.1:${KOKO_SSH_PORT}`);

  if (RESET) {
    log('\n— 清理旧数据 —');
    try { compose(composeArgs(['down', '-v', '--remove-orphans'])); } catch { /* 没装过 */ }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(ENV_FILE, { force: true });
  }

  log('\n— 1/4 生成配置 —');
  const conf = ensureConfig({ regenerateSecrets: RESET });
  log('  · config/config.txt、config_safe.txt、redis.conf、.env 就绪');

  log('\n— 2/4 拉镜像并启动容器 —');
  up();

  log('\n— 3/4 等待服务 + 初始化数据库 —');
  waitInfra();
  waitCore();
  if (!(await (async () => {
    try {
      const health = shOut('docker', ['exec', 'jms_core', 'bash', '-c', 'curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/api/health/']);
      return health === '200';
    } catch { return false; }
  })())) {
    // core 首次启动可能已建表（数据目录保留），upgrade_db 幂等，直接跑
    log('  · core 健康检查未通过，仍尝试 upgrade_db（幂等）');
  }
  migrateDb();
  shOut('docker', ['restart', 'jms_core']);

  log('\n— 4/4 等待 Web 就绪 + 建种子数据 —');
  if (!(await waitHttp(`${BASE}/api/health/`, 300))) throw new Error('Web 未就绪，稍后重试：node dev/jumpserver/setup.mjs');
  log('  · Web 就绪');

  if (!INFRA_ONLY) {
    let admin = await login('admin', ADMIN_PASSWORD);
    if (!admin) {
      warn('  ! admin/ChangeMe 登录失败（可能已改过密码）；跳过种子数据。');
      warn('    如忘记密码：docker exec -it jms_core bash -c "./jms changepassword"');
    } else {
      await seed(admin.token);
    }
  }

  const env = readEnvFile(ENV_FILE);
  log('\n=== 完成 ===');
  log(`  Web 控制台   : ${BASE}  （admin / ${ADMIN_PASSWORD} → 首次登录会要求改密）`);
  log(`  SSH/SFTP 网关: 127.0.0.1:${KOKO_SSH_PORT}`);
  log(`  测试账号     : ${SEED.user.username} / ${SEED.user.password}`);
  log(`  目标机       : ${SEED.asset.name} = target:${SEED.asset.port}（账号 ${SEED.systemUser.username} / ${env.TARGET_PASSWORD || 'Polaris@123'}）`);
  log('\n  Polaris 里填：会话列表「🛡 堡垒机」右键 → JumpServer API 对接');
  log(`    地址 http://127.0.0.1:${HTTP_PORT} · 用户 ${SEED.user.username} · 密码 ${SEED.user.password}`);
  log(`    SSH 网关 127.0.0.1:${KOKO_SSH_PORT}`);
  log('\n  手工验证：');
  log(`    curl -s -X POST ${BASE}/api/v1/authentication/auth/ -H 'Content-Type: application/json' \\`);
  log(`      -d '{"username":"${SEED.user.username}","password":"${SEED.user.password}"}'`);
  log(`    ssh -p ${KOKO_SSH_PORT} ${SEED.user.username}@127.0.0.1   # 进 Web 上的资产列表后选资产`);
  log(`    docker exec -it jms_koko sh -c 'echo > /dev/tcp/target/2222'   # 目标机连通性`);
  log('');
}

main().catch((e) => {
  console.error('\n✗ 部署失败：', e.message);
  console.error('  排查：docker compose -f dev/jumpserver/docker-compose.yml ps');
  console.error('        docker logs --tail 100 jms_core');
  process.exit(1);
});
