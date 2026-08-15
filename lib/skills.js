'use strict';
/**
 * skills.js — Agent Skill 技能库(参考 Chaterm 的 skills 设计)
 *
 * 技能 = 一段可复用的运维指令(纯文本 Markdown),以 SKILL.md 文件形式存放在
 *   <数据目录>/skills/<技能名>/SKILL.md
 * 与 recordings/session-logs 一样是数据目录下的普通文件,随 POLARIS_LOCK_DIR 走。
 *
 * 文件格式(极简 frontmatter,手工解析,不引入 yaml 依赖):
 *   ---
 *   name: deploy-docker-app
 *   description: 一键部署 docker 应用(构建/推送/拉取/启动)
 *   enabled: true
 *   ---
 *   ## 技能说明
 *   ...markdown 正文...
 *
 * AI 代理侧:启用中的技能会以 "AVAILABLE SKILLS" 清单出现在系统提示里,
 * 代理通过 use_skill 工具按需加载某个技能的完整内容再执行;
 * summarize_to_skill 工具可以把一段对话沉淀成新技能。
 */

const path = require('path');
const fs = require('fs');

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/; // 技能名:小写字母/数字/连字符(与 Chaterm 一致)
const MAX_SKILLS = 200;                 // 防滥用上限

function skillsDir() {
  // 与 app-lock 的 lockDir 同一数据目录;延迟 require 避免循环依赖
  const { lockDir } = require('./app-lock');
  return path.join(lockDir(), 'skills');
}

function skillDir(name) {
  if (!NAME_RE.test(name)) throw new Error('技能名只能是小写字母/数字/连字符(如 deploy-docker-app)');
  return path.join(skillsDir(), name);
}

/**
 * 解析一份 SKILL.md 内容 → { name, description, enabled, content }
 * 解析失败(缺 name/description)抛错,调用方决定怎么处理。
 */
function parseSkillFile(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, ''); // 去 BOM
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error('SKILL.md 缺少 --- frontmatter 头');
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key && val !== undefined) fm[key] = val;
  }
  if (!fm.name || !fm.description) throw new Error('SKILL.md frontmatter 必须包含 name 和 description');
  if (!NAME_RE.test(fm.name)) throw new Error('技能名只能是小写字母/数字/连字符');
  return {
    name: fm.name,
    description: fm.description,
    enabled: String(fm.enabled).toLowerCase() !== 'false', // 默认启用
    content: (m[2] || '').replace(/^\r?\n/, ''),          // 去掉正文开头的空行
  };
}

function serializeSkill({ name, description, enabled, content }) {
  return `---\nname: ${name}\ndescription: ${description}\nenabled: ${enabled === false ? 'false' : 'true'}\n---\n\n${String(content || '').trim()}\n`;
}

/** 列出全部技能(不读正文,只读 frontmatter + 文件时间) */
function listSkills() {
  const dir = skillsDir();
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const ent of names) {
    if (!ent.isDirectory()) continue;
    const f = path.join(dir, ent.name, 'SKILL.md');
    let stat = null;
    try { stat = fs.statSync(f); } catch { continue; }
    try {
      const s = parseSkillFile(fs.readFileSync(f, 'utf8'));
      out.push({ name: s.name, description: s.description, enabled: s.enabled, mtimeMs: stat.mtimeMs });
    } catch {
      // 坏文件跳过,不影响其他技能
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** 读单个技能(含正文);不存在返回 null */
function getSkill(name) {
  const f = path.join(skillDir(name), 'SKILL.md');
  let raw;
  try { raw = fs.readFileSync(f, 'utf8'); } catch { return null; }
  try {
    return parseSkillFile(raw);
  } catch (err) {
    return { name, description: '(解析失败: ' + err.message + ')', enabled: false, content: raw, _broken: true };
  }
}

/** 保存/新建技能(原子写) */
function saveSkill(skill) {
  const name = String(skill && skill.name || '').trim();
  if (!NAME_RE.test(name)) throw new Error('技能名只能是小写字母/数字/连字符(如 deploy-docker-app)');
  const description = String(skill.description || '').trim();
  if (!description) throw new Error('请填写技能描述(一行,说明何时用这个技能)');
  const dir = skillDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, serializeSkill({ name, description, enabled: skill.enabled !== false, content: skill.content || '' }), 'utf8');
  fs.renameSync(tmp, file); // 原子替换,防写一半
  const total = listSkills().length;
  if (total > MAX_SKILLS) { // 超上限回滚
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error('技能数量超上限(' + MAX_SKILLS + '),请先删除部分技能');
  }
  return { name, description, enabled: skill.enabled !== false };
}

/** 删除技能 */
function deleteSkill(name) {
  const dir = skillDir(name);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  return true;
}

/** 启用/停用(重写 frontmatter 的 enabled 字段) */
function setEnabled(name, enabled) {
  const s = getSkill(name);
  if (!s) throw new Error('技能不存在: ' + name);
  return saveSkill({ name: s.name, description: s.description, enabled: !!enabled, content: s.content });
}

/**
 * 生成系统提示里的 "AVAILABLE SKILLS" 段落(只列启用中的技能),
 * AI 代理靠这段清单决定何时调用 use_skill。没有启用技能时返回空串。
 */
function buildSkillsPromptSection() {
  const list = listSkills().filter((s) => s.enabled);
  if (!list.length) return '';
  const lines = list.map((s) => '- ' + s.name + ': ' + s.description);
  return [
    '',
    '## AVAILABLE SKILLS',
    '以下是本工具中已启用的运维技能清单。当用户任务匹配某个技能的描述时,',
    '先用 use_skill 工具加载该技能,再严格按技能内容执行。',
    ...lines,
    '',
  ].join('\n');
}

module.exports = {
  skillsDir, skillDir, parseSkillFile, serializeSkill,
  listSkills, getSkill, saveSkill, deleteSkill, setEnabled,
  buildSkillsPromptSection, NAME_RE,
};
