'use strict';
/**
 * lib/session-groups.js — 分组 / 命令历史归档 / 快速命令 / 导入模板 IPC
 *
 * 从 main.js 拆出(原 IPC:分组管理 + 命令记录 + 快速命令区块),依赖面小:
 * 纯 sessionStore 透传 + dialog/shell/XLSX/recommend/ai-stream,无跨区块函数调用。
 * sessionStore / mainWindow 启动早期不可用 → 用 getter 惰性注入。
 */
const fs = require('fs');
const path = require('path');
const { dialog, shell, ipcMain } = require('electron');
const XLSX = require('xlsx');
const appLock = require('./app-lock');
const recommendLib = require('./recommend');
const { normalizeAiUrl, callAiStream } = require('./ai-stream');

let getSessionStore = () => null;
let schedulePersist = () => {};
let getMainWindow = () => null;
const store = () => getSessionStore();

/** main.js 启动早期调用:注入惰性依赖(sessionStore 解锁后才赋值,mainWindow 建窗后才赋值) */
function register(_ipcMain, deps) {
  if (deps) {
    if (typeof deps.getSessionStore === 'function') getSessionStore = deps.getSessionStore;
    if (typeof deps.schedulePersist === 'function') schedulePersist = deps.schedulePersist;
    if (typeof deps.getMainWindow === 'function') getMainWindow = deps.getMainWindow;
  }
  const H = _ipcMain || ipcMain;

  H.handle('groups:list', () => {
    try { return { ok: true, groups: store().listGroups() }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  H.handle('groups:create', (_e, name, parentId) => {
    try { const id = store().createGroup(name, parentId); schedulePersist(); return { ok: true, id }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  H.handle('groups:rename', (_e, id, name) => {
    try { store().renameGroup(id, name); schedulePersist(); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  H.handle('groups:setProd', (_e, id, flag) => {
    try { store().setGroupProd(id, !!flag); schedulePersist(); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  H.handle('groups:delete', (_e, id) => {
    try { store().deleteGroup(id); schedulePersist(); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  // ---- 命令记录持久化(SQLite cmd_history 表) ----
  H.handle('cmd:add', (_e, host, command) => {
    try { store().addCmd(host, command); schedulePersist(); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  H.handle('cmd:list', () => {
    try { return { ok: true, cmds: store().listCmds() }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  H.handle('cmd:clear', () => {
    try { store().clearCmds(); schedulePersist(); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  // 智能命令推荐(参考 Chaterm):该主机的历史高频命令 + 内置常用运维命令库合并。
  // host 为空 → 全量统计(全局常用)。纯函数在 lib/recommend.js,可独立单测。
  H.handle('cmd:recommend', (_e, host) => {
    try {
      const rows = store().listCmdsByHost(host);
      const list = recommendLib.recommend(rows, { host: host || undefined, limit: 12 });
      return { ok: true, host: host || null, list };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // AI 命令推荐(参考 Chaterm 的"智能命令推荐"):单次调用(非 agent 循环),
  // 把"主机 + 最近命令历史 + 终端最近输出"给模型,让它推荐一条下一条要执行的命令。
  H.handle('ai:suggestCmd', async (_e, { apiKey, url, model, format, host, history, context }) => {
    try {
      if (!apiKey) return { ok: false, error: '请先在 AI 面板 ⚙ 里填 API Key' };
      const base = normalizeAiUrl(url || '', format || 'openai');
      const mdl = (model && model.trim()) || 'claude-sonnet-5';
      const system = `你是一名资深 Linux/运维工程师,内嵌在 SSH 终端工具里。
用户给你当前主机的上下文(主机标识、最近执行过的命令、终端最近输出),请你推荐**一条**接下来最值得执行的命令。
要求:
- 只输出一个 JSON 对象,不要任何多余文字: {"command": "命令", "reason": "一句话中文理由"}
- command 必须是单条、非交互、能一次执行完的 shell 命令(不要 vim/less/top 这类需要退出的交互程序;用 top -bn1 这类一次性版本)
- reason 用中文,一句话说明为什么执行它
- 结合终端输出判断:有报错就推荐排查命令,有磁盘/内存告警就推荐对应的检查命令`;
      const user = [
        `当前主机: ${host || '(未知)'}`,
        history ? `最近执行过的命令(按时间):\n${String(history).slice(0, 1500)}` : '最近执行过的命令: (无)',
        context ? `终端最近输出(末尾截取):\n${String(context).slice(-1500)}` : '终端最近输出: (空)',
        '',
        '请严格按系统要求输出 JSON。',
      ].join('\n');
      const r = await callAiStream(base, mdl, format, apiKey, [{ role: 'user', content: user }], null, { systemPrompt: system, tools: [] });
      if (r.error) return { ok: false, error: r.error };
      // 尽量解析 JSON;失败则从文本里兜底提取第一行当命令
      let parsed = null;
      try { parsed = JSON.parse(String(r.text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { /* 非严格 JSON */ }
      if (parsed && parsed.command) {
        return { ok: true, command: String(parsed.command), reason: parsed.reason || '' };
      }
      const lines = String(r.text || '').trim().split('\n').map((x) => x.trim()).filter(Boolean);
      return { ok: true, command: lines[0] || '', reason: lines.slice(1).join(' ').slice(0, 120) || '' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 归档某台主机的命令记录:按当前主机归档,文件名 = 标签页名称_时间戳.txt(不自动打开)
  H.handle('cmd:archive', async (_e, { host, sessionName }) => {
    try {
      const now = new Date();
      const pad = (x) => String(x).padStart(2, '0');
      const archiveId = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const name = String(sessionName || '归档').trim().replace(/[\\/:*?"<>|\s]+/g, '_');
      const count = store().archiveCmds(archiveId, host, ''); // 先占位 file
      if (!count) return { ok: true, archived: 0, path: null };
      const rows = store().archiveDetail(archiveId);
      const dir = path.join(appLock.lockDir(), 'archives');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${name}_${archiveId}.txt`);
      const byHost = {};
      for (const r of rows) {
        const h = r.host || '未知主机';
        if (!byHost[h]) byHost[h] = [];
        byHost[h].push(r);
      }
      let out = `Polaris 命令记录归档  ${archiveId}\n${'='.repeat(50)}\n`;
      for (const h of Object.keys(byHost)) {
        out += `\n===== ${h} =====\n`;
        for (const c of byHost[h]) out += `[${c.created_at}] ${c.command}\n`;
      }
      fs.writeFileSync(file, out, 'utf8');
      // 把文件路径补进批次记录
      try { store().setArchiveFile(archiveId, file); } catch { /* ignore */ }
      schedulePersist();
      return { ok: true, archived: count, archiveId, path: file };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 列出某台主机的归档批次(时间倒序)
  H.handle('cmd:listArchives', (_e, host) => {
    try { return { ok: true, archives: store().listArchives(host || '') }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  // 查看某批归档的明细
  H.handle('cmd:archiveDetail', (_e, archiveId) => {
    try { return { ok: true, rows: store().archiveDetail(archiveId) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  // 列出归档文件夹里的文件(时间倒序)
  H.handle('cmd:listArchiveFiles', () => {
    try {
      const dir = path.join(appLock.lockDir(), 'archives');
      fs.mkdirSync(dir, { recursive: true });
      const files = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.txt'))
        .map((f) => {
          const st = fs.statSync(path.join(dir, f));
          return { name: f, size: st.size, mtime: st.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      return { ok: true, files };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // 归档文件路径必须落在 archives 目录内(渲染层传的路径不可信,防任意文件删/拷)
  const isInArchives = (filePath) => {
    const dir = path.resolve(appLock.lockDir(), 'archives');
    const resolved = path.resolve(String(filePath || ''));
    return resolved === dir || resolved.startsWith(dir + path.sep);
  };

  // 下载归档文件:弹保存对话框 → 复制一份到用户选的位置
  H.handle('cmd:downloadArchive', async (_e, filePath) => {
    try {
      const src = String(filePath || '');
      if (!src || !isInArchives(src)) return { ok: false, error: '归档文件不存在' };
      const save = await dialog.showSaveDialog(getMainWindow(), {
        title: '保存归档文件', defaultPath: path.basename(src),
        filters: [{ name: '文本文件', extensions: ['txt'] }],
      });
      if (save.canceled || !save.filePath) return { ok: false, error: '已取消' };
      fs.copyFileSync(src, save.filePath);
      return { ok: true, path: save.filePath };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // 删除归档:删文件 + 删数据库里对应批次的归档记录
  H.handle('cmd:deleteArchive', (_e, archiveId, filePath) => {
    try {
      if (filePath) {
        if (!isInArchives(filePath)) return { ok: false, error: '非法路径' };
        if (fs.existsSync(filePath)) fs.rmSync(filePath);
      }
      store().deleteArchive(String(archiveId || ''));
      schedulePersist();
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // 打开归档文件夹(查看所有归档文件)
  H.handle('cmd:openArchives', () => {
    try {
      const dir = path.join(appLock.lockDir(), 'archives');
      fs.mkdirSync(dir, { recursive: true });
      shell.openPath(dir);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 选择 SSH 私钥文件(原生对话框),返回路径
  H.handle('pick:keyFile', async () => {
    try {
      const r = await dialog.showOpenDialog(getMainWindow(), {
        title: '选择 SSH 私钥文件',
        properties: ['openFile'],
        filters: [{ name: '私钥文件', extensions: ['*'] }],
      });
      if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
      return { ok: true, path: r.filePaths[0] };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 生成"导入模板"Excel:弹保存对话框 → SheetJS 生成带表头和示例行的 xlsx → 写盘
  H.handle('template:save', async () => {
    try {
      const save = await dialog.showSaveDialog(getMainWindow(), {
        title: '保存导入模板',
        defaultPath: '主机导入模板.xlsx',
        filters: [{ name: 'Excel 文件', extensions: ['xlsx'] }],
      });
      if (save.canceled || !save.filePath) return { ok: false, error: '已取消' };

      // 第一个 sheet:主机列表(表头 + 示例行,示例用文档保留网段 192.0.2.x 避免误连)
      const ws = XLSX.utils.aoa_to_sheet([
        ['名称', '主机', '端口', '用户名', '密码', '分组'],
        ['示例服务器A', '192.0.2.10', '22', 'root', 'password123', '生产'],
        ['', '192.0.2.11', '22', 'ubuntu', '', '测试'],
      ]);
      ws['!cols'] = [{ wch: 16 }, { wch: 16 }, { wch: 8 }, { wch: 14 }, { wch: 16 }, { wch: 10 }];
      // 第二个 sheet:填写说明
      const note = XLSX.utils.aoa_to_sheet([
        ['填写说明'],
        ['1. 在"主机列表"表里填你的服务器,首行表头不要动。'],
        ['2. 每行一台,列顺序:名称,主机,端口,用户名,密码,分组。'],
        ['3. 名称/端口/密码/分组可留空:名称留空用主机地址,端口默认22,分组默认"默认分组"。'],
        ['4. 填好后保存,回软件点"导入 → 从 Excel 文件导入"选择本文件。'],
        ['5. 示例行可直接删掉或用它当格式参照。'],
      ]);
      note['!cols'] = [{ wch: 90 }];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '主机列表');
      XLSX.utils.book_append_sheet(wb, note, '说明');
      XLSX.writeFile(wb, save.filePath);
      return { ok: true, path: save.filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ---- IPC:快速命令(命令收藏) ----
  H.handle('quick:list', () => {
    try { return { ok: true, cmds: store().listQuickCmds() }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  H.handle('quick:add', (_e, { name, command }) => {
    try { const id = store().addQuickCmd(name, command); schedulePersist(); return { ok: true, id }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  H.handle('quick:update', (_e, { id, name, command }) => {
    try { store().updateQuickCmd(id, name, command); schedulePersist(); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  H.handle('quick:del', (_e, id) => {
    try { store().deleteQuickCmd(id); schedulePersist(); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
}

module.exports = { register };
