'use strict';
/**
 * sftp-attrs.js — SFTP「权限 / 属主 / 时间戳」对话框的纯函数层
 *
 * 只做解析与校验,**不碰 fs/sftp/electron**,便于 `verify-sftp-attrs.js` 直接单测。
 * 真正的下发(chmod / chown / utimes)在 main.js 里(`sftp:setAttrs`)。
 */

// 八进制权限上限:12 位以内的特殊位(SUID 4 / SGID 2 / Sticky 1 + 9 位 rwx)
const MAX_MODE = 0o7777;

/** 把 mode 数字格式化成对话框里的八进制串:0o644 → '644'、0o4755 → '4755' */
function formatMode(mode) {
  const n = Number(mode);
  if (!Number.isFinite(n) || n < 0) return '';
  const m = (n & MAX_MODE).toString(8);
  // 常规 9 位权限补到 3 位(644),带特殊位的补到 4 位(4755)
  return m.length < 3 ? m.padStart(3, '0') : m;
}

/**
 * 解析用户输入的权限串。
 * 接受:'644' / '0644' / '0o644' / '0O644' / '4755',允许首尾空格。
 * 拒绝:空、非数字、含 8/9、超过 0o7777、负数。
 * @returns {{ok:true, mode:number}|{ok:false, error:string}}
 */
function parseMode(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: false, error: '权限不能为空' };
  let m = raw;
  if (/^0o/i.test(m)) m = m.slice(2);
  if (!/^[0-7]{3,4}$/.test(m)) {
    // 允许用户输 2 位(如 77 想表达 077)?不 —— 交互里歧义太大,明确要求 3~4 位
    return { ok: false, error: '权限要写成 3~4 位八进制数字,例如 644 / 755 / 4755' };
  }
  const mode = parseInt(m, 8);
  if (!Number.isFinite(mode) || mode < 0 || mode > MAX_MODE) {
    return { ok: false, error: `权限不能超过 ${MAX_MODE.toString(8)}(如 7777)` };
  }
  return { ok: true, mode };
}

/**
 * mode → `ls -l` 风格符号串,给对话框做即时预览(用户不用背八进制)。
 * @param {number} mode
 * @param {boolean} isDir 目录首字符用 'd',文件用 '-'
 */
function modeToSymbolic(mode, isDir) {
  const n = Number(mode);
  if (!Number.isFinite(n) || n < 0) return '';
  const m = n & MAX_MODE;
  const special = (m >> 9) & 7; // 4=SUID 2=SGID 1=sticky
  const bits = m & 0o777;
  // suid → 用户位 x 变 s/S, sgid → 组位,s 位的字符映射需要单独处理大小写
  const owner = (() => {
    const r = bits & 0o400 ? 'r' : '-';
    const w = bits & 0o200 ? 'w' : '-';
    const x = bits & 0o100;
    if (special & 4) return r + w + (x ? 's' : 'S');
    return r + w + (x ? 'x' : '-');
  })();
  const group = (() => {
    const r = bits & 0o040 ? 'r' : '-';
    const w = bits & 0o020 ? 'w' : '-';
    const x = bits & 0o010;
    if (special & 2) return r + w + (x ? 's' : 'S');
    return r + w + (x ? 'x' : '-');
  })();
  const other = (() => {
    const r = bits & 0o004 ? 'r' : '-';
    const w = bits & 0o002 ? 'w' : '-';
    const x = bits & 0o001;
    if (special & 1) return r + w + (x ? 't' : 'T');
    return r + w + (x ? 'x' : '-');
  })();
  return (isDir ? 'd' : '-') + owner + group + other;
}

/**
 * 解析 UID / GID 输入。空串 = 不改(返回 null 表示"跳过"),只接受非负整数。
 * @returns {{ok:true, id:(number|null)}|{ok:false, error:string}}
 */
function parseId(input, label) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: true, id: null };
  if (!/^\d{1,7}$/.test(raw)) {
    return { ok: false, error: `${label || 'ID'} 只支持数字(如 0 = root / 1000),不支持用户名` };
  }
  const id = parseInt(raw, 10);
  if (!Number.isFinite(id) || id > 0x7fffffff) return { ok: false, error: `${label || 'ID'} 数值不合法` };
  return { ok: true, id };
}

/** 秒级时间戳 → `<input type="datetime-local">` 要的本地时间串(YYYY-MM-DDTHH:MM:SS) */
function toDatetimeLocal(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * datetime-local 串 → 秒级时间戳(按本机时区解释,和输入框显示一致)。
 * @returns {{ok:true, sec:(number|null)}|{ok:false, error:string}}
 */
function parseDatetimeLocal(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: true, sec: null };
  // 浏览器可能给 '2026-11-13T10:30' 或带秒 '…:00' —— Date 都能解析(本地时区)
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return { ok: false, error: '时间格式不正确,请用 年-月-日 时:分 的格式' };
  return { ok: true, sec: Math.floor(d.getTime() / 1000) };
}

/**
 * 复核主进程收到的 patch(渲染层传的是数字,但 IPC 不是只有对话框能调)。
 * @param {{mode?:number, uid?:number, gid?:number, mtime?:number}} p
 * @returns {{ok:true, empty:boolean, patch:object}|{ok:false, errors:string[]}}
 */
function validatePatch(p) {
  const o = p || {};
  const errors = [];
  const patch = {};
  if (o.mode !== undefined && o.mode !== null) {
    if (!Number.isInteger(o.mode) || o.mode < 0 || o.mode > MAX_MODE) errors.push(`权限数值不合法(0~${MAX_MODE.toString(8)})`);
    else patch.mode = o.mode;
  }
  for (const k of ['uid', 'gid']) {
    if (o[k] === undefined || o[k] === null) continue;
    if (!Number.isInteger(o[k]) || o[k] < 0 || o[k] > 0x7fffffff) errors.push(`${k === 'uid' ? '属主 UID' : '属组 GID'} 数值不合法`);
    else patch[k] = o[k];
  }
  if (o.mtime !== undefined && o.mtime !== null) {
    // 上限 2100-01-01:挡住"秒/毫秒搞混"传进来的 13 位数字
    if (!Number.isFinite(o.mtime) || o.mtime < 0 || o.mtime > 4102444800) errors.push('修改时间不合法');
    else patch.mtime = Math.floor(o.mtime);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, empty: Object.keys(patch).length === 0, patch };
}

/**
 * 把对话框里的四项输入收成一次下发用的 patch(**字符串**形态,给对话框/单测用)。
 * mode 留空视为"不改权限";一项都没改 → `empty:true`(调用方直接关框,不必惊动服务器)。
 * @param {{mode?:string, uid?:string, gid?:string, mtime?:string, isDir?:boolean, recursive?:boolean}} v
 * @returns {{ok:true, empty:boolean, patch:object, recursive:boolean}|{ok:false, errors:string[]}}
 */
function buildAttrsPatch(v) {
  const o = v || {};
  const errors = [];
  const patch = {};
  // mode 留空 = 不改(对话框总会填,但 API 调用方可以只改属主/时间)
  if (String(o.mode == null ? '' : o.mode).trim()) {
    const pm = parseMode(o.mode);
    if (!pm.ok) errors.push(pm.error);
    else patch.mode = pm.mode;
  }

  const pu = parseId(o.uid, '属主 UID');
  if (!pu.ok) errors.push(pu.error);
  else if (pu.id !== null) patch.uid = pu.id;

  const pg = parseId(o.gid, '属组 GID');
  if (!pg.ok) errors.push(pg.error);
  else if (pg.id !== null) patch.gid = pg.id;

  const pt = parseDatetimeLocal(o.mtime);
  if (!pt.ok) errors.push(pt.error);
  else if (pt.sec !== null) patch.mtime = pt.sec;

  if (errors.length) return { ok: false, errors };
  const empty = Object.keys(patch).length === 0;
  // 递归只对目录有意义(单文件传 true 会被调用方忽略)
  const recursive = !!(o.recursive && o.isDir);
  return { ok: true, empty, patch, recursive };
}

/** 给用户看的 patch 摘要(状态栏/日志用,不含路径) */
function describePatch(patch) {
  const p = patch || {};
  const parts = [];
  if (typeof p.mode === 'number') parts.push(`权限 ${formatMode(p.mode)}`);
  if (typeof p.uid === 'number') parts.push(`UID ${p.uid}`);
  if (typeof p.gid === 'number') parts.push(`GID ${p.gid}`);
  if (typeof p.mtime === 'number') parts.push(`时间 ${toDatetimeLocal(p.mtime)}`);
  return parts.join(' / ');
}

module.exports = {
  MAX_MODE,
  validatePatch,
  formatMode,
  parseMode,
  modeToSymbolic,
  parseId,
  toDatetimeLocal,
  parseDatetimeLocal,
  buildAttrsPatch,
  describePatch,
};
