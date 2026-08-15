'use strict';
/**
 * kb.js — 用户知识库(参考 Chaterm 的知识库特性,本地化简化版)
 *
 * 文档 = 文本类文件(.md/.txt/.log/.conf 等),存放在
 *   <数据目录>/kb/ 下,文件名即文档名。
 * 检索 = 本地关键词搜索:query 拆词(中英文),文档名命中权重大、正文命中其次,
 *   按命中词数排序,返回带命中片段(snippet)的结果 —— 不依赖外部向量库,
 *   几十~几百份文档量级下足够快。
 * AI 集成:对话时把检索到的相关片段注入系统提示(buildKbPromptSection),
 *   让 AI 参考用户导入的运维手册/内部文档回答。
 */

const path = require('path');
const fs = require('fs');

const MAX_DOCS = 200;                    // 文档数量上限
const MAX_DOC_BYTES = 2 * 1024 * 1024;   // 单文档上限 2MB

function kbDir() {
  const { lockDir } = require('./app-lock');
  return path.join(lockDir(), 'kb');
}

// 文档名清洗:去掉路径分隔符/非法字符,防路径穿越
function sanitizeName(name) {
  const safe = String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  return safe || 'unnamed';
}

/** 列出全部文档(文件名 + 大小 + 修改时间) */
function listDocs() {
  const dir = kbDir();
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    const f = path.join(dir, n);
    let st = null;
    try { st = fs.statSync(f); } catch { continue; }
    if (!st.isFile()) continue;
    if (st.size > MAX_DOC_BYTES) continue; // 超大文档不索引
    out.push({ name: n, size: st.size, mtimeMs: st.mtimeMs });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** 读文档全文;不存在返回 null */
function readDoc(name) {
  const f = path.join(kbDir(), sanitizeName(name));
  try { return fs.readFileSync(f, 'utf8'); } catch { return null; }
}

/** 从文本添加文档(重名覆盖) */
function addDocFromText(name, content) {
  const safeName = sanitizeName(name);
  if (!safeName || safeName === 'unnamed') throw new Error('文档名不能为空');
  const text = String(content || '');
  if (!text.trim()) throw new Error('文档内容不能为空');
  const dir = kbDir();
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, safeName);
  const buf = Buffer.from(text, 'utf8');
  if (buf.length > MAX_DOC_BYTES) throw new Error('文档过大(上限 2MB)');
  fs.writeFileSync(f, buf);
  const total = listDocs().length;
  if (total > MAX_DOCS) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
    throw new Error('文档数量超上限(' + MAX_DOCS + '),请先删除部分文档');
  }
  return { name: safeName, size: buf.length };
}

/** 从本地文件导入(复制进知识库);name 缺省用原文件名 */
function importDoc(filePath, name) {
  const src = String(filePath || '');
  if (!src || !fs.existsSync(src)) throw new Error('文件不存在: ' + src);
  const content = fs.readFileSync(src, 'utf8');
  const finalName = (name && String(name).trim()) ? sanitizeName(name) : path.basename(src);
  return addDocFromText(finalName, content);
}

/** 删除文档 */
function removeDoc(name) {
  const f = path.join(kbDir(), sanitizeName(name));
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  return true;
}

// 中英文切词:英文按 字母数字/下划线连字符 切,中文按 2 字以上连续汉字 切
function tokenize(s) {
  return String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}|[\u4e00-\u9fff]{2,}/g) || [];
}

/**
 * 关键词检索:query 拆词,文档名/正文里命中越多越靠前。
 * @returns [{ name, size, score, snippet }] snippet = 命中位置前后的片段
 */
function search(query, opts = {}) {
  const limit = opts.limit || 5;
  const q = String(query || '').trim();
  if (!q) return [];
  const terms = tokenize(q);
  if (!terms.length) return [];
  const results = [];
  for (const d of listDocs()) {
    const content = readDoc(d.name);
    if (!content) continue;
    const lower = content.toLowerCase();
    const nameLower = d.name.toLowerCase();
    let score = 0;
    let snippet = '';
    for (const t of terms) {
      if (nameLower.includes(t)) score += 3; // 标题命中权重大
      const idx = lower.indexOf(t);
      if (idx !== -1) {
        score += 1;
        if (!snippet) {
          const start = Math.max(0, idx - 60);
          snippet = (start > 0 ? '…' : '') + content.slice(start, idx + 120).replace(/\s+/g, ' ') + (start + 180 < content.length ? '…' : '');
        }
      }
    }
    if (score > 0) results.push({ name: d.name, size: d.size, score, snippet });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit).map((r) => ({ ...r, snippet: r.snippet || '' }));
}

/** 全部文档拼接(供 AI 全库上下文;按上限截断) */
function allDocsText(maxBytes = 20000) {
  const out = [];
  let len = 0;
  for (const d of listDocs()) {
    const c = readDoc(d.name);
    if (!c) continue;
    const piece = '【' + d.name + '】\n' + c;
    if (len + piece.length > maxBytes) break;
    out.push(piece);
    len += piece.length;
  }
  return out.join('\n\n');
}

/** 检索到的知识片段,拼成给 AI 的提示段落(无命中返回空串) */
function buildKbPromptSection(query, opts = {}) {
  const hits = search(query, { limit: opts.limit || 3 });
  if (!hits.length) return '';
  const lines = hits.map((h) => '- 【' + h.name + '】' + (h.snippet || ''));
  return [
    '',
    '## 知识库相关片段(用户导入的运维文档,回答/执行时优先参考其中的流程与命令)',
    ...lines,
    '',
  ].join('\n');
}

module.exports = {
  kbDir, listDocs, readDoc, addDocFromText, importDoc, removeDoc,
  search, allDocsText, buildKbPromptSection,
};
