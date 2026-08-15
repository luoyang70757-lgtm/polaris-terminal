'use strict';
/**
 * preload.js — 渲染进程与主进程之间的"安全桥梁"
 * 渲染进程(网页)不能直接碰 Node,只能调用这里暴露的函数。
 * 每个函数对应主进程的一个 IPC 通道。
 */

const { contextBridge, ipcRenderer, clipboard, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ---- 会话管理(SQLite) ----
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  createSession: (s) => ipcRenderer.invoke('sessions:create', s),
  updateSession: (id, s) => ipcRenderer.invoke('sessions:update', id, s),
  removeSession: (id) => ipcRenderer.invoke('sessions:remove', id),
  importSessions: (list) => ipcRenderer.invoke('sessions:import', list),
  exportSessions: (rows, password) => ipcRenderer.invoke('sessions:export', { rows, password }),
  importBackup: (buf, password) => ipcRenderer.invoke('sessions:importBackup', { buf, password }),
  importExternal: (files) => ipcRenderer.invoke('sessions:importExternal', { files }),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  saveTemplate: () => ipcRenderer.invoke('template:save'),
  pickKeyFile: () => ipcRenderer.invoke('pick:keyFile'),

  // 分组管理
  listGroups: () => ipcRenderer.invoke('groups:list'),
  createGroup: (name, parentId) => ipcRenderer.invoke('groups:create', name, parentId),
  renameGroup: (id, name) => ipcRenderer.invoke('groups:rename', id, name),
  setGroupProd: (id, flag) => ipcRenderer.invoke('groups:setProd', id, flag),
  deleteGroup: (id) => ipcRenderer.invoke('groups:delete', id),

  // ---- SSH 直连 ----
  sshConnect: (sessionId, opts) => ipcRenderer.invoke('ssh:connect', { sessionId, opts }),
  sshWrite: (sessionId, data) => ipcRenderer.send('ssh:write', sessionId, data),
  sshResize: (sessionId, cols, rows) => ipcRenderer.send('ssh:resize', sessionId, cols, rows),
  sshClose: (sessionId) => ipcRenderer.send('ssh:close', sessionId),
  // ---- Telnet 直连(复用整条 ssh:data/ssh:write 管线) ----
  telnetConnect: (sessionId, opts) => ipcRenderer.invoke('telnet:connect', { sessionId, opts }),
  // ---- 批量端口探测 ----
  probePorts: (opts) => ipcRenderer.invoke('probe:ports', opts),
  // ---- 测试连接(协议感知:SSH 须收到 banner) ----
  testConnect: (opts) => ipcRenderer.invoke('test:connect', opts),

  // ---- 终端调试日志:把面板内容存成 .log 文件 ----
  debugSave: (text) => ipcRenderer.invoke('debug:save', text),
  // 传输记录行「📂 打开所在文件夹」:系统文件管理器里定位已下载文件
  revealInFolder: (p) => ipcRenderer.send('fs:reveal', p),

  // ---- 主进程事件(终端数据、连接状态) ----
  onSshData: (cb) => ipcRenderer.on('ssh:data', (_e, sessionId, data) => cb(sessionId, data)),
  onSshStatus: (cb) => ipcRenderer.on('ssh:status', (_e, sessionId, status) => cb(sessionId, status)),
  // 主进程日志 → 渲染层调试面板(MAIN 前缀,排查主进程问题)
  onMainLog: (cb) => ipcRenderer.on('main:log', (_e, level, msg) => cb(level, msg)),
  // keyboard-interactive 认证:主进程推提示 → 弹窗 → 应答
  onSshKbd: (cb) => ipcRenderer.on('ssh:kbd-interactive', (_e, sessionId, data) => cb(sessionId, data)),
  sshKbdRespond: (id, answers, cancelled) => ipcRenderer.send('ssh:kbd-respond', id, answers, cancelled),

  // ---- 应用菜单事件(文件/视图/工具/帮助) ----
  onMenu: (cb) => {
    for (const ch of [
      'menu:new-session', 'menu:new-group', 'menu:import', 'menu:export', 'menu:toggle-panel', 'menu:settings', 'menu:about',
      'menu:split-v', 'menu:split-h', 'menu:sftp', 'menu:tunnel', 'menu:batch', 'menu:quick',
      'menu:cmd', 'menu:record-toggle', 'menu:record-list', 'menu:log-open', 'menu:ai',
      'menu:connect', 'menu:disconnect', 'menu:lock', 'menu:jms',
    ]) {
      ipcRenderer.on(ch, () => cb(ch));
    }
  },

  // ---- SFTP 文件传输 ----
  sftpList: (sessionId, remotePath) => ipcRenderer.invoke('sftp:list', { sessionId, remotePath }),
  sftpMkdir: (sessionId, remotePath) => ipcRenderer.invoke('sftp:mkdir', { sessionId, remotePath }),
  sftpRmdir: (sessionId, remotePath) => ipcRenderer.invoke('sftp:rmdir', { sessionId, remotePath }),
  sftpDelete: (sessionId, remotePath) => ipcRenderer.invoke('sftp:delete', { sessionId, remotePath }),
  sftpRename: (sessionId, from, to) => ipcRenderer.invoke('sftp:rename', { sessionId, from, to }),
  sftpReadFile: (sessionId, remotePath) => ipcRenderer.invoke('sftp:readFile', { sessionId, remotePath }),
  sftpWriteFile: (sessionId, remotePath, content) => ipcRenderer.invoke('sftp:writeFile', { sessionId, remotePath, content }),
  sftpUpload: (sessionId, remoteDir) => ipcRenderer.invoke('sftp:upload', { sessionId, remoteDir }),
  sftpDownload: (sessionId, remotePath) => ipcRenderer.invoke('sftp:download', { sessionId, remotePath }),
  // entries = [{ remotePath, isDir }] —— 支持文件+目录混合下载(目录递归)
  sftpDownloadMany: (sessionId, entries) => ipcRenderer.invoke('sftp:downloadMany', { sessionId, entries }),
  addCmdHistory: (host, command) => ipcRenderer.invoke('cmd:add', host, command),
  listCmdHistory: () => ipcRenderer.invoke('cmd:list'),
  clearCmdHistoryDb: () => ipcRenderer.invoke('cmd:clear'),
  // 智能命令推荐:该主机历史高频 + 常用运维命令库
  recommendCmds: (host) => ipcRenderer.invoke('cmd:recommend', host),
  archiveCmdHistory: (host, sessionName) => ipcRenderer.invoke('cmd:archive', { host, sessionName }),
  openArchives: () => ipcRenderer.invoke('cmd:openArchives'),
  listCmdArchives: (host) => ipcRenderer.invoke('cmd:listArchives', host),
  cmdArchiveDetail: (archiveId) => ipcRenderer.invoke('cmd:archiveDetail', archiveId),
  listArchiveFiles: () => ipcRenderer.invoke('cmd:listArchiveFiles'),
  downloadArchive: (filePath) => ipcRenderer.invoke('cmd:downloadArchive', filePath),
  deleteArchive: (archiveId, filePath) => ipcRenderer.invoke('cmd:deleteArchive', archiveId, filePath),
  sftpBatchUpload: (sessions, remoteDir) => ipcRenderer.invoke('sftp:batchUpload', { sessions, remoteDir }),
  sftpBatchDownload: (sessions, remotePath) => ipcRenderer.invoke('sftp:batchDownload', { sessions, remotePath }),
  // 上传/下载进度事件(主进程推送,驱动进度条)
  onSftpProgress: (cb) => ipcRenderer.on('sftp:progress', (_e, p) => cb(p)),

  // ---- 批量执行结果面板 ----
  batchExec: (data) => ipcRenderer.invoke('batch:exec', data),

  // ---- JumpServer 资产(堡垒机) ----
  jmsLogin: (cfg) => ipcRenderer.invoke('jms:login', cfg),
  jmsMfa: (cfg) => ipcRenderer.invoke('jms:mfa', cfg),
  jmsAssets: (cfg) => ipcRenderer.invoke('jms:assets', cfg),
  jmsPersist: (servers) => ipcRenderer.invoke('jms:persist', servers),
  jmsRestore: () => ipcRenderer.invoke('jms:restore'),
  cryptoEncrypt: (text) => ipcRenderer.invoke('crypto:encrypt', text),
  cryptoDecrypt: (text) => ipcRenderer.invoke('crypto:decrypt', text),
  // H3C 堡垒机:解码 accessclient:// token
  bastionDecode: (url) => ipcRenderer.invoke('bastion:decode', url),
  // 目标连通性探测(TCP + SSH banner),诊断"无法连接"用
  bastionProbe: (p) => ipcRenderer.invoke('bastion:probe', p),
  // 导出堡垒机资产诊断包(排查"资产不完整"用)
  exportBastionDiag: (data) => ipcRenderer.invoke('diag:exportBastion', data),
  // 堡垒机资产持久化(SQLite 整库加密):整批保存 / 读出 / 删除
  bastionSaveAssets: (url, assets) => ipcRenderer.invoke('bastion:saveAssets', { url, assets }),
  bastionLoadAssets: () => ipcRenderer.invoke('bastion:loadAssets'),
  bastionDeleteAssets: (url) => ipcRenderer.invoke('bastion:deleteAssets', url),

  // ---- 快速命令(命令收藏) ----
  quickList: () => ipcRenderer.invoke('quick:list'),
  quickAdd: (name, command) => ipcRenderer.invoke('quick:add', { name, command }),
  quickUpdate: (id, name, command) => ipcRenderer.invoke('quick:update', { id, name, command }),
  quickDel: (id) => ipcRenderer.invoke('quick:del', id),

  // ---- SSH 隧道/端口转发 ----
  tunnelList: () => ipcRenderer.invoke('tunnel:list'),
  tunnelCreate: (spec) => ipcRenderer.invoke('tunnel:create', spec),
  tunnelDelete: (id) => ipcRenderer.invoke('tunnel:delete', id),

  // ---- 会话录制与回放 ----
  recStart: (sessionId, meta) => ipcRenderer.invoke('rec:start', { sessionId, meta }),
  recStop: (sessionId) => ipcRenderer.invoke('rec:stop', sessionId),
  recList: () => ipcRenderer.invoke('rec:list'),
  recDelete: (id) => ipcRenderer.invoke('rec:delete', id),
  recReplay: (id) => ipcRenderer.invoke('rec:replay', id),
  recOpenDir: () => ipcRenderer.invoke('rec:openDir'),

  // ---- 会话日志(可读纯文本落盘) ----
  logOpenDir: () => ipcRenderer.invoke('log:openDir'),

  // ---- 剪贴板(复制粘贴用) ----
  copyText: (text) => clipboard.writeText(text),
  readClipboard: () => clipboard.readText(),

  // ---- 全量日志 ----
  appLogDump: () => ipcRenderer.invoke('app:log-dump'),
  appLogDlog: (lines) => ipcRenderer.send('app:log-dlog', lines),

  // ---- 系统探测(OS 识别) ----
  detectOs: (opts) => ipcRenderer.invoke('sessions:detectOs', opts),

  // ---- App 密码锁 ----
  lockHas: () => ipcRenderer.invoke('lock:has'),
  lockMenu: (visible) => ipcRenderer.invoke('lock:menu', visible), // 锁定后隐藏原生菜单栏(Windows)
  lockMenuState: () => ipcRenderer.invoke('lock:menuState'), // 查询菜单是否已移除(测试用)
  lockSetup: (password) => ipcRenderer.invoke('lock:setup', password),
  lockVerify: (password) => ipcRenderer.invoke('lock:verify', password),
  lockStatus: () => ipcRenderer.invoke('lock:status'),
  lockChange: (current, next) => ipcRenderer.invoke('lock:change', { current, next }),
  lockSuccess: (password) => ipcRenderer.invoke('lock:success', password),

  // ---- AI 助手 ----
  aiChat: (cfg) => ipcRenderer.invoke('ai:chat', cfg),
  aiStop: (requestId) => ipcRenderer.send('ai:stop', requestId),
  onAiStream: (cb) => ipcRenderer.on('ai:stream', (_e, evt) => cb(evt)),
  // AI 命令推荐:基于当前终端上下文推荐下一条命令
  aiSuggestCmd: (cfg) => ipcRenderer.invoke('ai:suggestCmd', cfg),

  // ---- Agent Skill 技能库(参考 Chaterm) ----
  skillsList: () => ipcRenderer.invoke('skills:list'),
  skillsGet: (name) => ipcRenderer.invoke('skills:get', name),
  skillsSave: (skill) => ipcRenderer.invoke('skills:save', skill),
  skillsDelete: (name) => ipcRenderer.invoke('skills:delete', name),
  skillsSetEnabled: (name, enabled) => ipcRenderer.invoke('skills:setEnabled', name, enabled),
  skillsOpenFolder: () => ipcRenderer.invoke('skills:openFolder'),

  // ---- 用户知识库(参考 Chaterm):运维文档导入 + 关键词检索 ----
  kbList: () => ipcRenderer.invoke('kb:list'),
  kbPickImport: () => ipcRenderer.invoke('kb:pickImport'),
  kbImport: (filePath, name) => ipcRenderer.invoke('kb:import', { filePath, name }),
  kbRemove: (name) => ipcRenderer.invoke('kb:remove', name),
  kbSearch: (query, limit) => ipcRenderer.invoke('kb:search', query, limit),
  kbOpenFolder: () => ipcRenderer.invoke('kb:openFolder'),
});
