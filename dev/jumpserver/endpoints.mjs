#!/usr/bin/env node
'use strict';
/**
 * dev/jumpserver/endpoints.mjs — 从**运行中的 docker 容器**里解析 JumpServer 的访问地址
 *
 * 背景：以前地址是写死的 127.0.0.1:8080 / 2222，只对「默认 compose 配置 + 没改端口」成立。
 * 一旦 .env 里换了 HTTP_PORT、或者同时起了别的实例，脚本就会连错地方。
 * 这里改成优先问 docker（容器名固定为 jms_web / jms_koko）：
 *
 *   1. 显式参数 / 环境变量（JMS_HTTP_PORT / JMS_KOKO_SSH_PORT / --url / --koko-port）
 *   2. `docker port jms_web 80` / `docker port jms_koko 2222` → 宿主机映射端口（Polaris 跑在宿主机上，走这个）
 *   3. dev/jumpserver/.env 里的 HTTP_PORT / KOKO_SSH_PORT（容器没起时兜底）
 *   4. 默认 8080 / 2222
 *
 * 容器内地址（192.168.250.x:80 / :2222）也一并返回，仅用于日志/排查：
 * Docker Desktop 里宿主机访问不到容器 IP，所以真正连接一律用「宿主机映射端口」。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_CONTAINER = 'jms_web';
const KOKO_CONTAINER = 'jms_koko';

/** 读 setup.mjs 生成的 .env（只关心端口，不打印口令） */
export function readEnvFile(file = path.join(HERE, '.env')) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
  } catch { /* 没生成过 → 空对象 */ }
  return out;
}

function docker(args) {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

/** `docker port <容器> <端口>/tcp` → 宿主机端口（取第一条，IPv4 优先） */
export function hostPort(container, containerPort) {
  const out = docker(['port', container, `${containerPort}/tcp`]);
  if (!out) return null;
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const v4 = lines.find((l) => !l.startsWith('[')) || lines[0];
  const m = /:(\d+)$/.exec(v4 || '');
  return m ? Number(m[1]) : null;
}

/** 容器在 compose 网络里的 IP（只用于日志） */
export function containerIp(container) {
  const out = docker(['inspect', container, '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}']);
  const ip = (out || '').split(/\s+/).find((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x));
  return ip || null;
}

export function isRunning(container) {
  const out = docker(['inspect', container, '--format', '{{.State.Status}}']);
  return out === 'running';
}

/**
 * @param {{httpPort?: string|number, kokoPort?: string|number, env?: Record<string,string>}} opt
 * @returns {{baseUrl:string, sshHost:string, sshPort:number, source:{web:string, koko:string}, container:{ip:string|null, webPort:number, kokoPort:number}}}
 */
export function resolveEndpoints(opt = {}) {
  const env = opt.env || readEnvFile();
  const e = process.env;

  // Web
  let webPort = null;
  let webSource = '';
  if (opt.httpPort) { webPort = Number(opt.httpPort); webSource = '参数 --http-port'; }
  else if (e.JMS_HTTP_PORT) { webPort = Number(e.JMS_HTTP_PORT); webSource = '环境变量 JMS_HTTP_PORT'; }
  else {
    const p = hostPort(WEB_CONTAINER, 80);
    if (p) { webPort = p; webSource = `docker port ${WEB_CONTAINER} 80`; }
    else if (env.HTTP_PORT) { webPort = Number(env.HTTP_PORT); webSource = '.env HTTP_PORT'; }
  }
  if (!webPort) { webPort = 8080; webSource = '默认值'; }

  // KoKo SSH 网关
  let sshPort = null;
  let kokoSource = '';
  if (opt.kokoPort) { sshPort = Number(opt.kokoPort); kokoSource = '参数 --koko-port'; }
  else if (e.JMS_KOKO_SSH_PORT) { sshPort = Number(e.JMS_KOKO_SSH_PORT); kokoSource = '环境变量 JMS_KOKO_SSH_PORT'; }
  else {
    const p = hostPort(KOKO_CONTAINER, 2222);
    if (p) { sshPort = p; kokoSource = `docker port ${KOKO_CONTAINER} 2222`; }
    else if (env.KOKO_SSH_PORT) { sshPort = Number(env.KOKO_SSH_PORT); kokoSource = '.env KOKO_SSH_PORT'; }
  }
  if (!sshPort) { sshPort = 2222; kokoSource = '默认值'; }

  return {
    baseUrl: `http://127.0.0.1:${webPort}`,
    sshHost: '127.0.0.1',
    sshPort,
    source: { web: webSource, koko: kokoSource },
    container: {
      ip: containerIp(WEB_CONTAINER),
      webPort: 80,
      kokoPort: 2222,
    },
  };
}
