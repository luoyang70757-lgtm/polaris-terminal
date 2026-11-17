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
 *   node dev/jumpserver/setup.mjs --seed-only  # 只重跑种子数据（改了 seed() 后不用等容器/迁移）
 *   node dev/jumpserver/setup.mjs --mirror=docker.1ms.run   # 国内网络走镜像源
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
const SEED_ONLY = has('--seed-only'); // 只重跑种子数据（不碰容器/迁移），调 seed() 时很快

const HTTP_PORT = process.env.JMS_HTTP_PORT || '8080';
const KOKO_SSH_PORT = process.env.JMS_KOKO_SSH_PORT || '2222';
const VERSION = process.env.JMS_VERSION || 'v4.10.20-ce';
// 国内网络拉 docker.io 基本必失败：--mirror=docker.1ms.run 把所有镜像走代理前缀
const MIRROR = (args.find((a) => a.startsWith('--mirror=')) || `--mirror=${process.env.JMS_MIRROR || ''}`).split('=').slice(1).join('=').replace(/\/+$/, '');
const BASE = `http://127.0.0.1:${HTTP_PORT}`;

// admin 口令：JumpServer v4 有弱口令策略（ChangeMe 会报 PasswordTooSimple → 登录 500），
// 所以默认用强口令；早年手动改过 admin 口令的，用 JMS_ADMIN_PASSWORD 传进来。
const ADMIN_PASSWORD = process.env.JMS_ADMIN_PASSWORD || 'Polaris@Admin2026';
const SEED = {
  // users[0] 有全部 3 台资产；users[1] 只授权 dev-target-02 —— 用来验「权限隔离」（各自只看到被授权的资产）
  users: [
    { username: 'polaris', name: 'Polaris 开发账号', password: 'Polaris@123', email: 'polaris@example.com', permName: 'polaris-dev-all',
      assets: ['dev-target-01', 'dev-target-02', 'dev-target-03'] },
    { username: 'polaris-ro', name: 'Polaris 受限账号（权限隔离用）', password: 'Polaris@123', email: 'polaris-ro@example.com', permName: 'polaris-ro-limited',
      assets: ['dev-target-02'] },
  ],
  systemUser: { name: 'polaris-dev', username: 'polaris', password: 'Polaris@123' },
  // 多台资产都指向同一台目标机（容器 target）：地址用三个网络别名 target-01/02/03，
  // 不能共用 `target` —— JumpServer 复合用户名里的「资产地址」重复时，KoKo 会当成多台主机
  // 命中而弹出「选择其中一个资产登录 Opt>」，直连（双击）会卡在那里。
  assets: [
    { name: 'dev-target-01', address: 'target-01', port: 2222 },
    { name: 'dev-target-02', address: 'target-02', port: 2222 },
    { name: 'dev-target-03', address: 'target-03', port: 2222 },
  ],
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
  const img = (name) => (MIRROR ? `${MIRROR}/${name}` : name);
  writeIfChanged(ENV_FILE, [
    `VERSION=${VERSION}`,
    `HTTP_PORT=${HTTP_PORT}`,
    `KOKO_SSH_PORT=${KOKO_SSH_PORT}`,
    `KOKO_WEB_PROXY_PORT=${process.env.JMS_KOKO_WEB_PROXY_PORT || '5001'}`,
    `NAMESPACE=${img('jumpserver')}`,
    `DB_IMAGE=${img('library/postgres:16.15-bookworm')}`,
    `REDIS_IMAGE=${img('library/redis:7.4.10-bookworm')}`,
    `TARGET_IMAGE=${img('linuxserver/openssh-server:latest')}`,
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
  if (r.data && r.data.token) return r.data; // JumpServer v4 成功时返回 201（老版本 200），两种都收
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
  const listAssets = async () => {
    let list = await listAll('/api/v1/assets/hosts/?limit=200', t).catch(() => []);
    if (!list.length) list = await listAll('/api/v1/assets/assets/?limit=200', t);
    return list;
  };

  // ① 普通用户（Polaris 里登录用的 JMS 用户）
  let users = await listAll('/api/v1/users/users/?limit=200', t);
  for (const u of SEED.users) {
    const found = users.find((x) => x.username === u.username);
    if (!found) {
      await api('POST', '/api/v1/users/users/', {
        token: t, body: { name: u.name, username: u.username, password: u.password, email: u.email, role: 'user' },
      });
      log(`  · 创建用户 ${u.username}`);
    } else {
      await api('PATCH', `/api/v1/users/users/${found.id}/`, { token: t, body: { password: u.password } });
      log(`  · 用户 ${u.username} 已存在（口令已重置）`);
    }
  }
  users = await listAll('/api/v1/users/users/?limit=200', t); // 重新拉，拿回带 id 的最新列表

  // ② 目标机账号：v4.10 起 “系统用户” 已并入 accounts（/api/v1/assets/system-users/ 现在是 404），
  //    所以不再单独建对象，只在 ④ 里把它作为账号“推送”到每台资产上。

  // ③ 资产（多台，全指向同一台目标机）
  // v4.10 的 platform 字段要 pk（传字符串 'Linux' 会 400：期望 pk 值），这里现查一次
  const platforms = await listAll('/api/v1/assets/platforms/?limit=500', t).catch(() => []);
  const linuxPlatform = findByName(platforms, 'Linux');
  const platformRef = linuxPlatform ? linuxPlatform.id : undefined;
  let assets = await listAssets();
  for (const a of SEED.assets) {
    const body = {
      name: a.name,
      address: a.address,
      ...(platformRef ? { platform: platformRef } : {}),
      protocols: [{ name: 'ssh', port: a.port }],
      nodes: [],
      comment: 'Polaris 回归用目标机（docker compose profile: target）',
    };
    const found = findByName(assets, a.name);
    if (!found) {
      await api('POST', '/api/v1/assets/hosts/', { token: t, body });
      log(`  · 创建资产 ${a.name}（${a.address}:${a.port}）`);
    } else {
      await api('PATCH', `/api/v1/assets/hosts/${found.id}/`, { token: t, body });
      log(`  · 资产 ${a.name} 已存在`);
    }
  }
  assets = await listAssets();

  // ④ 把目标机账号“推送”到每台资产上（等价于 Web 上的「资产 → 账号 → 添加」）
  const accounts = await listAll('/api/v1/accounts/accounts/?limit=500', t);
  for (const a of SEED.assets) {
    const asset = findByName(assets, a.name);
    if (!asset) continue;
    const exists = accounts.find((x) => x.asset && x.asset.id === asset.id && x.username === SEED.systemUser.username);
    if (exists) {
      // 早期建出来的账号可能 secret 是空的（KoKo 连资产时会退化成提示 `password:`），每次都补齐
      await api('PATCH', `/api/v1/accounts/accounts/${exists.id}/`, {
        token: t, body: { secret_type: 'password', secret: SEED.systemUser.password },
      });
      continue;
    }
    await api('POST', '/api/v1/accounts/accounts/', {
      token: t,
      body: {
        asset: asset.id,
        name: SEED.systemUser.username,
        username: SEED.systemUser.username,
        secret_type: 'password',
        secret: SEED.systemUser.password,
        is_active: true,
      },
      allowFail: true,
    });
    log(`  · 资产账号已建立（${a.name}）`);
  }

  // ⑤ 资产授权：每个用户一条，assets 只放他被授权的那几台
  const perms = await listAll('/api/v1/perms/asset-permissions/?limit=200', t);
  for (const u of SEED.users) {
    const user = users.find((x) => x.username === u.username);
    if (!user) continue;
    const assetIds = u.assets
      .map((name) => (findByName(assets, name) || {}).id)
      .filter(Boolean);
    const permBody = {
      name: u.permName,
      users: [user.id],
      assets: assetIds,
      // v4.10：授权对象从 system_users(id) 改成了 accounts(用户名数组)
      accounts: [SEED.systemUser.username],
      actions: ['connect', 'upload', 'download', 'copy', 'paste'],
      is_active: true,
    };
    const perm = perms.find((p) => p.name === u.permName);
    if (!perm) {
      await api('POST', '/api/v1/perms/asset-permissions/', { token: t, body: permBody });
      log(`  · 创建资产授权 ${u.permName}（${assetIds.length} 台）`);
    } else {
      await api('PATCH', `/api/v1/perms/asset-permissions/${perm.id}/`, { token: t, body: permBody });
      log(`  · 资产授权 ${u.permName} 已存在（${assetIds.length} 台）`);
    }
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

  if (SEED_ONLY) {
    log('\n— 种子数据模式：跳过配置 / 容器 / 迁移（--seed-only）—');
  } else {
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
  }

  log('\n— 4/4 等待 Web 就绪 + 建种子数据 —');
  if (!(await waitHttp(`${BASE}/api/health/`, 300))) throw new Error('Web 未就绪，稍后重试：node dev/jumpserver/setup.mjs');
  log('  · Web 就绪');

  if (!INFRA_ONLY) {
    let admin = await login('admin', ADMIN_PASSWORD);
    if (!admin) {
      warn(`  ! admin 登录失败（当前口令不是 ${ADMIN_PASSWORD}）；跳过种子数据。`);
      warn('    口令改过：JMS_ADMIN_PASSWORD=你的口令 node dev/jumpserver/setup.mjs');
      warn('    忘了口令：docker exec -it jms_core bash → cd /opt/jumpserver/apps && python manage.py shell');
    } else {
      await seed(admin.token);
    }
  }

  const env = readEnvFile(ENV_FILE);
  log('\n=== 完成 ===');
  log(`  Web 控制台   : ${BASE}  （admin / ${ADMIN_PASSWORD}）`);
  log(`  SSH/SFTP 网关: 127.0.0.1:${KOKO_SSH_PORT}`);
  log(`  资产         : ${SEED.assets.map((a) => a.name + '@' + a.address).join(' / ')}:${SEED.assets[0].port}（目标机账号 ${SEED.systemUser.username} / ${env.TARGET_PASSWORD || 'Polaris@123'}）`);
  for (const u of SEED.users) {
    log(`  账号         : ${u.username} / ${u.password} → 授权 ${u.assets.length} 台（${u.assets.join(', ')}）`);
  }

  log('\n  Polaris 里两种用法：');
  log('    · 图形界面：会话列表「🛡 堡垒机」右键 → JumpServer API 对接');
  log('    · 一键联调：node dev/jumpserver/polaris-dev.mjs（自动写配置 + 关 mock + 起应用）');
  log(`    地址 http://127.0.0.1:${HTTP_PORT} · 用户 ${SEED.users[0].username} · 密码 ${SEED.users[0].password}`);
  log(`    SSH 网关 127.0.0.1:${KOKO_SSH_PORT}`);

  log('\n  手工验证：');
  log(`    curl -s -X POST ${BASE}/api/v1/authentication/auth/ -H 'Content-Type: application/json' \\`);
  log(`      -d '{"username":"${SEED.users[0].username}","password":"${SEED.users[0].password}"}'`);
  log(`    ssh -p ${KOKO_SSH_PORT} '${SEED.users[0].username}@ssh@${SEED.systemUser.username}@${SEED.assets[0].address}'@127.0.0.1   # 复合用户名直连资产`);
  log('    docker exec -it jms_core bash -c \'(exec 3<>/dev/tcp/target-01/2222) && echo 目标机可达\'');
  log('');
}

main().catch((e) => {
  console.error('\n✗ 部署失败：', e.message);
  console.error('  排查：docker compose -f dev/jumpserver/docker-compose.yml ps');
  console.error('        docker logs --tail 100 jms_core');
  process.exit(1);
});
