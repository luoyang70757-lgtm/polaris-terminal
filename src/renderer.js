'use strict';
/**
 * renderer.js — 渲染进程(纯 SSH/SFTP 终端版)
 * 会话列表(SQLite)→ 双击 → 建标签 + xterm 终端 → SSH 直连
 */

/* global XTerm, XTermAddonFit, Terminal, FitAddon, XLSX */

// ---- xterm 全局兼容 ----
// 不同版本/构建的浏览器全局名不一样,这里统一归一成"类":
//   xterm 5.3:   window.Terminal(类)   window.FitAddon(命名空间,类在 .FitAddon 里)
//   其他版本:    window.XTerm(.Terminal)   window.XTermAddonFit(.FitAddon)
const XTermClass =
  (window.XTerm && window.XTerm.Terminal) ||
  (window.Terminal && window.Terminal.Terminal) ||
  window.Terminal;
const FitAddonClass =
  (window.XTermAddonFit && window.XTermAddonFit.FitAddon) ||
  (window.FitAddon && window.FitAddon.FitAddon) ||
  window.FitAddon;
const SearchAddonClass =
  (window.XTermAddonSearch && window.XTermAddonSearch.SearchAddon) ||
  (window.SearchAddon && window.SearchAddon.SearchAddon) ||
  window.SearchAddon;

// 启动计时起点(调试日志 BOOT 埋点用,排查"打开慢"问题)
const __bootT0 = performance.now();

// ---- 主题预设(参考 Netcatty / Chaterm / Termius 的个性化)----
// term = 终端配色;ansi = 该主题的 ANSI 16 色板(官方色板优先,未设置兜底 DEFAULT_ANSI)
// UI 变量统一由 deriveUiTokens 从 term 配色按 appearance 派生(单一事实来源),不再手写 css
const THEMES = {
  dark: {
    name: '深空(默认)', appearance: 'dark',
    term: { background: '#070c18', foreground: '#c7dcff', cursor: '#2dd4fe', selectionBackground: '#3a67c8', selectionForeground: '#ffffff' },
    ansi: ['#333333', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5', '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'],
  },
  light: {
    name: '浅色', appearance: 'light',
    term: { background: '#ffffff', foreground: '#1f2430', cursor: '#1f2430', selectionBackground: '#b8d4f0', selectionForeground: '#1f2430' },
    ansi: ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5', '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'],
  },
  green: {
    name: '经典绿', appearance: 'dark',
    term: { background: '#001b00', foreground: '#33ff33', cursor: '#33ff33', selectionBackground: '#0e6b0e', selectionForeground: '#ffffff' },
    ansi: ['#005500', '#ff4455', '#00cc44', '#cccc00', '#00aa88', '#cc44cc', '#00aaaa', '#00aa00', '#007700', '#ff6677', '#22ff66', '#ffee22', '#22ddbb', '#ff66ff', '#33dddd', '#ffffff'],
  },
  solarizedDark: {
    name: 'Solarized 深', appearance: 'dark',
    term: { background: '#002b36', foreground: '#839496', cursor: '#839496', selectionBackground: '#0a5a6e', selectionForeground: '#ffffff' },
    ansi: ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3'],
  },
  solarizedLight: {
    name: 'Solarized 浅', appearance: 'light',
    term: { background: '#fdf6e3', foreground: '#657b83', cursor: '#657b83', selectionBackground: '#d9d2b5', selectionForeground: '#073642' },
    ansi: ['#eee8d5', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#fdf6e3', '#586e75', '#cb4b16', '#073642', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#002b36'],
  },
  nord: {
    name: 'Nord', appearance: 'dark',
    term: { background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', selectionBackground: '#5e81ac', selectionForeground: '#ffffff' },
    ansi: ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0', '#4c566a', '#d08770', '#8fbcbb', '#eceff4', '#5e81ac', '#d8dee9', '#434c5e', '#eceff4'],
  },
  dracula: {
    name: 'Dracula', appearance: 'dark',
    term: { background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: '#6272a4', selectionForeground: '#ffffff' },
    ansi: ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2', '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff'],
  },
  onedark: {
    name: 'One Dark', appearance: 'dark',
    term: { background: '#282c34', foreground: '#abb2bf', cursor: '#528bff', selectionBackground: '#5c78d6', selectionForeground: '#ffffff' },
    ansi: ['#21252b', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf', '#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff'],
  },
  // ---- 以下预设只写配色 + 各主题 ANSI 色板,UI 变量走 deriveUiTokens 派生 ----
  termiusDark: {
    name: 'Graphite 深', appearance: 'dark',
    term: { background: '#222426', foreground: '#c9c9c9', cursor: '#c9c9c9', selectionBackground: '#3e4142', selectionForeground: '#ffffff' },
    ansi: ['#333333', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5', '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'],
  },
  termiusLight: {
    name: 'Mist 浅', appearance: 'light',
    term: { background: '#f5f5f5', foreground: '#222426', cursor: '#222426', selectionBackground: '#d9dcdE', selectionForeground: '#222426' },
    ansi: ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5', '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'],
  },
  flexokiDark: {
    name: 'Ember 深', appearance: 'dark',
    term: { background: '#100f0f', foreground: '#c6c3b5', cursor: '#c6c3b5', selectionBackground: '#282726', selectionForeground: '#ffffff' },
    ansi: ['#100f0f', '#af3029', '#66800b', '#ad8301', '#205ea6', '#a02f6f', '#24837b', '#cecdc3', '#575653', '#d14d41', '#879a39', '#d0a215', '#4385be', '#ce5d97', '#3aa99f', '#e6e4d9'],
  },
  flexokiLight: {
    name: 'Canvas 浅', appearance: 'light',
    term: { background: '#fffcf0', foreground: '#100f0f', cursor: '#100f0f', selectionBackground: '#e6e4d9', selectionForeground: '#100f0f' },
    ansi: ['#6f6e69', '#af3029', '#66800b', '#ad8301', '#205ea6', '#a02f6f', '#24837b', '#c8c5bf', '#6f6e69', '#d14d41', '#879a39', '#d0a215', '#4385be', '#ce5d97', '#3aa99f', '#1c1b1a'],
  },
  kanagawaWave: {
    name: 'Tide 靛', appearance: 'dark',
    term: { background: '#1f1f28', foreground: '#dcd7ba', cursor: '#dcd7ba', selectionBackground: '#363646', selectionForeground: '#ffffff' },
    ansi: ['#090618', '#c34043', '#76946a', '#c0a36e', '#7e9cd8', '#957fb8', '#6a9589', '#c8c093', '#727169', '#e82424', '#98bb6c', '#e6c384', '#7fb4ca', '#938aa9', '#7aa89f', '#dcd7ba'],
  },
  kanagawaDragon: {
    name: 'Forge 铜', appearance: 'dark',
    term: { background: '#181616', foreground: '#c5c9c5', cursor: '#c5c9c5', selectionBackground: '#2d2a2e', selectionForeground: '#ffffff' },
    ansi: ['#0d0c0c', '#c4746e', '#8a9a7b', '#c4b28a', '#8ba4b0', '#a292a3', '#8ea4a2', '#c8c093', '#a6a69c', '#e46876', '#98bb6c', '#e6c384', '#7fb4ca', '#938aa9', '#7aa89f', '#dcd7ba'],
  },
  kanagawaLotus: {
    name: 'Dawn 花', appearance: 'light',
    term: { background: '#f2ecbc', foreground: '#545464', cursor: '#545464', selectionBackground: '#b9b577', selectionForeground: '#ffffff' },
    ansi: ['#f2ecbc', '#c84053', '#6d894e', '#77713f', '#597b8f', '#8a5a83', '#5b8d8a', '#545464', '#b8b4a0', '#d7474f', '#a9a050', '#8f8947', '#708d9c', '#985f8f', '#6a8d88', '#545464'],
  },
  hackerBlue: {
    name: 'Pulse 蓝', appearance: 'dark',
    term: { background: '#001020', foreground: '#33aaff', cursor: '#33aaff', selectionBackground: '#003a6e', selectionForeground: '#ffffff' },
    ansi: ['#00224a', '#4488ff', '#22ccaa', '#ffcc44', '#5599ff', '#cc66ff', '#44ddff', '#88aacc', '#00336e', '#66aaff', '#44eebb', '#ffdd66', '#77bbff', '#dd88ff', '#66eeff', '#ffffff'],
  },
  hackerGreen: {
    name: 'Pulse 绿', appearance: 'dark',
    term: { background: '#001300', foreground: '#00ff66', cursor: '#00ff66', selectionBackground: '#006e2a', selectionForeground: '#ffffff' },
    ansi: ['#003300', '#33ff66', '#00ff88', '#dddd00', '#44ffcc', '#ff55ff', '#00ddcc', '#88cc88', '#004400', '#66ff88', '#33ffaa', '#ffee55', '#77ffdd', '#ff88ff', '#55ffdd', '#ffffff'],
  },
  catppuccinMocha: {
    name: 'Truffle 摩卡', appearance: 'dark',
    term: { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: '#45475a', selectionForeground: '#ffffff' },
    ansi: ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de', '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8'],
  },
  catppuccinLatte: {
    name: 'Cream 拿铁', appearance: 'light',
    term: { background: '#eff1f5', foreground: '#4c4f69', cursor: '#dc8a78', selectionBackground: '#ccd0da', selectionForeground: '#4c4f69' },
    ansi: ['#5c5f77', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#acb0be', '#6c6f85', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#8c8fa1'],
  },
  gruvboxDark: {
    name: 'Grove 苔', appearance: 'dark',
    term: { background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', selectionBackground: '#3c3836', selectionForeground: '#ffffff' },
    ansi: ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984', '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2'],
  },
  // ---- T4:Termius 热门主题(官方配色 + 各主题色板,只写配色,UI 走派生)----
  rosePine: {
    name: '松雾 Rosé Pine', appearance: 'dark',
    term: { background: '#191724', foreground: '#e0def4', cursor: '#f6c177', selectionBackground: '#2a2837', selectionForeground: '#ffffff' },
    ansi: ['#26233a', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4', '#6e6a86', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4'],
  },
  nightOwl: {
    name: '夜枭 Night Owl', appearance: 'dark',
    term: { background: '#011627', foreground: '#d6deeb', cursor: '#80a4c2', selectionBackground: '#1d3b53', selectionForeground: '#ffffff' },
    ansi: ['#011627', '#ef5350', '#22da6e', '#addb67', '#82aaff', '#c792ea', '#21c7a8', '#ffffff', '#575f73', '#ef5350', '#22da6e', '#addb67', '#82aaff', '#c792ea', '#21c7a8', '#ffffff'],
  },
  everforestDark: {
    name: '森野深 Everforest', appearance: 'dark',
    term: { background: '#2d353b', foreground: '#d3c6aa', cursor: '#d3c6aa', selectionBackground: '#475258', selectionForeground: '#ffffff' },
    ansi: ['#4b565c', '#e67e80', '#a7c080', '#dbbc7f', '#7fbbb3', '#d699b6', '#83c092', '#d3c6aa', '#5c6a72', '#e67e80', '#a7c080', '#dbbc7f', '#7fbbb3', '#d699b6', '#83c092', '#d3c6aa'],
  },
  everforestLight: {
    name: '森野浅 Everforest', appearance: 'light',
    term: { background: '#fdf6e3', foreground: '#5c6a72', cursor: '#5c6a72', selectionBackground: '#d8caac', selectionForeground: '#5c6a72' },
    ansi: ['#5c6a72', '#f85552', '#8da101', '#dfa000', '#3a94c5', '#df69ba', '#35a77c', '#dfdcc9', '#9da9a0', '#f85552', '#8da101', '#dfa000', '#3a94c5', '#df69ba', '#35a77c', '#dfdcc9'],
  },
  aura: {
    name: '霞光 Aura', appearance: 'dark',
    term: { background: '#21202e', foreground: '#edecee', cursor: '#a277ff', selectionBackground: '#363447', selectionForeground: '#ffffff' },
    ansi: ['#15141b', '#ff6767', '#61ffca', '#ffca85', '#a277ff', '#a277ff', '#61ffca', '#edecee', '#4d4d66', '#ff6767', '#61ffca', '#ffca85', '#a277ff', '#ff6767', '#61ffca', '#edecee'],
  },
};

// ---- 颜色工具:hex→rgb→线性插值(Chaterm 参考的 colorUtils) ----
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function mix(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  const c = A.map((v, i) => Math.round(v + (B[i] - v) * t));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}
const darken = (hex, t) => mix(hex, '#000000', t);
const lighten = (hex, t) => mix(hex, '#ffffff', t);

// 从终端配色派生 9 个 UI 变量(对齐现有 CSS 变量名,变量名不变 → styles.css 零改动)
// 方向对齐现有预设:dark 面板/边框比 bg 提亮(--border #1d3a66 > bg #070c18),light 则加深
function deriveUiTokens(term, appearance) {
  const { background: bg, foreground: fg } = term;
  if (appearance === 'light') {
    return {
      '--bg': bg, '--term-bg': bg,
      '--bg-panel': lighten(bg, 0.02), '--bg-panel-2': darken(bg, 0.05),
      '--bg-hover': darken(bg, 0.06), '--border': darken(bg, 0.12),
      '--input-bg': lighten(bg, 0.015),
      '--text': fg, '--text-dim': mix(fg, bg, 0.45),
    };
  }
  return {
    '--bg': bg, '--term-bg': bg,
    '--bg-panel': lighten(bg, 0.05), '--bg-panel-2': lighten(bg, 0.09),
    '--bg-hover': lighten(bg, 0.12), '--border': lighten(bg, 0.16),
    '--input-bg': lighten(bg, 0.03),
    '--text': fg, '--text-dim': mix(fg, bg, 0.55),
  };
}

// 终端 ANSI 16 色默认色板(可用设置自定义覆盖)
const DEFAULT_ANSI = ['#333333', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5', '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];

// ---------- 元素引用 ----------
const $ = (id) => document.getElementById(id);
const els = {
  toolbarStatus: $('toolbar-status'),
  btnNewSession: $('btn-new-session'),
  inputSessionSearch: $('input-session-search'),
  scopeSelect: $('scope-select'),
  sessionTree: $('session-tree'),
  tabBar: $('tab-bar'),
  tabScrollLeft: $('tab-scroll-left'),
  tabScrollRight: $('tab-scroll-right'),
  terminalContainer: $('terminal-container'),
  welcomeHintSession: $('welcome-hint-session'),

  sessionModal: $('session-modal'),
  sessionModalTitle: $('session-modal-title'),
  fProtocol: $('f-protocol'),
  fSshOnly: $('f-ssh-only'),
  fPortLabel: $('f-port-label'),
  fUsernameLabel: $('f-username-label'),
  fPasswordLabel: $('f-password-label'),
  fName: $('f-name'),
  fHost: $('f-host'),
  fPort: $('f-port'),
  fUsername: $('f-username'),
  fPassword: $('f-password'),
  fPasswordToggle: $('f-password-toggle'),
  fPrivateKey: $('f-private-key'),
  fPrivateKeyPick: $('f-private-key-pick'),
  fPassphrase: $('f-passphrase'),
  fPassphraseToggle: $('f-passphrase-toggle'),
  fJumpHost: $('f-jump-host'),
  fJumpPort: $('f-jump-port'),
  fJumpUsername: $('f-jump-username'),
  fJumpPassword: $('f-jump-password'),
  fJumpPasswordToggle: $('f-jump-password-toggle'),
  fEncoding: $('f-encoding'),
  fOnConnect: $('f-on-connect'),
  fTestConn: $('f-test-conn'),
  fTestConnResult: $('f-test-conn-result'),
  fGroup: $('f-group'),
  modalSave: $('modal-save'),
  modalCancel: $('modal-cancel'),

  btnQuickConnect: $('btn-quick-connect'),
  quickConnect: $('quick-connect'),
  qcInput: $('qc-input'),
  qcGo: $('qc-go'),
  qcClose: $('qc-close'),

  btnNewGroup: $('btn-new-group'),
  vsGrid: $('vs-grid'),
  vsList: $('vs-list'),
  vsTree: $('vs-tree'),

  // 导入/导出已移到"文件"菜单,这里不再放按钮
  importModal: $('import-modal'),
  importText: $('import-text'),
  importResult: $('import-result'),
  importSave: $('import-save'),
  importCancel: $('import-cancel'),
  importExcel: $('import-excel'),
  importFile: $('import-file'),
  importBackup: $('import-backup'),
  importBackupFile: $('import-backup-file'),
  importExternal: $('import-external'),
  importExternalFile: $('import-external-file'),
  importTemplate: $('import-template'),
  importOverwrite: $('import-overwrite'),

  // 自定义输入弹窗 + 右键菜单
  promptModal: $('prompt-modal'),
  promptTitle: $('prompt-title'),
  promptLabel: $('prompt-label'),
  promptInput: $('prompt-input'),
  promptOk: $('prompt-ok'),
  promptCancel: $('prompt-cancel'),
  ctxMenu: $('ctx-menu'),

  // 连接/中断二合一 + 锁定
  btnConnect: $('btn-connect'),
  btnLock: $('btn-lock'),
  // 堡垒机浏览器入口(常显,防新用户找不到入口)
  btnBastionBrowser: $('btn-bastion-browser'),
  // 端口探测
  btnPortProbe: $('btn-port-probe'),
  probeModal: $('probe-modal'),
  probeHost: $('probe-host'),
  probePorts: $('probe-ports'),
  probeTimeout: $('probe-timeout'),
  probeRun: $('probe-run'),
  probeResult: $('probe-result'),
  probeClose: $('probe-close'),
  jmsModal: $('jms-modal'),
  jmsServerSelect: $('jms-server-select'),
  jmsServerAdd: $('jms-server-add'),
  jmsServerDel: $('jms-server-del'),
  jmsName: $('jms-name'),
  jmsUrl: $('jms-url'),
  jmsSshHost: $('jms-ssh-host'),
  jmsSshPort: $('jms-ssh-port'),
  jmsUser: $('jms-user'),
  jmsPass: $('jms-pass'),
  jmsOtp: $('jms-otp'),
  jmsOtpWrap: $('jms-otp-wrap'),
  jmsAdvToggle: $('jms-adv-toggle'),
  jmsAdvBody: $('jms-adv-body'),
  jmsMsg: $('jms-msg'),
  jmsSaveBtn: $('jms-save'),
  jmsLoginBtn: $('jms-login'),
  jmsLogoutBtn: $('jms-logout'),
  jmsRefreshBtn: $('jms-refresh'),
  jmsClose: $('jms-close'),
  // H3C 堡垒机内置浏览器
  bastionPanel: $('bastion-panel'),
  bastionMini: $('bastion-mini'),
  bastionServerSelect: $('bastion-server-select'),
  bastionClear: $('bastion-clear'),
  bastionCfg: $('bastion-cfg'),
  bastionEmptyCfg: $('bastion-empty-cfg'),
  bastionCfgModal: $('bastion-cfg-modal'),
  bastionCfgType: $('bastion-cfg-type'),
  bastionCfgName: $('bastion-cfg-name'),
  bastionCfgUrl: $('bastion-cfg-url'),
  bastionCfgAccount: $('bastion-cfg-account'),
  bastionCfgPass: $('bastion-cfg-pass'),
  bastionCfgAdd: $('bastion-cfg-add'),
  bastionCfgClose: $('bastion-cfg-close'),
  bastionCfgMsg: $('bastion-cfg-msg'),
  bastionUrl: $('bastion-url'),
  bastionGo: $('bastion-go'),
  bastionMin: $('bastion-min'),
  bastionBack: $('bastion-back'),
  bastionForward: $('bastion-forward'),
  bastionReload: $('bastion-reload'),
  bastionCurrent: $('bastion-current'),
  bastionEmpty: $('bastion-empty'),
  bastionClose: $('bastion-close'),
  bastionLoading: $('bastion-loading'),
  bastionZoomIn: $('bastion-zoom-in'),
  bastionZoomOut: $('bastion-zoom-out'),
  bastionZoomLabel: $('bastion-zoom-label'),
  bastionWebview: document.getElementById('bastion-webview'),
  bastionTabs: $('bastion-tabs'),
  bastionTabsList: $('bastion-tabs-list'),
  // 锁定覆盖层(临时锁定)
  lockOverlay: $('lock-overlay'),
  loPw: $('lo-pw'),
  loMsg: $('lo-msg'),
  loBtn: $('lo-btn'),
  // 广播模式(批量执行)
  btnBroadcast: $('btn-broadcast'),
  // 视图(分屏)下拉菜单
  btnView: $('btn-view'),
  viewMenu: $('view-menu'),
  // 设置
  btnSettings: $('btn-settings'),
  btnFilter: $('btn-filter'),
  filterModal: $('filter-modal'),
  filterNewKw: $('filter-new-kw'),
  filterAdd: $('filter-add'),
  filterList: $('filter-list'),
  filterStatus: $('filter-status'),
  filterClear: $('filter-clear'),
  filterApply: $('filter-apply'),
  filterCloseX: $('filter-close-x'),
  settingsModal: $('settings-modal'),
  // 终端调试日志
  btnDebug: $('btn-debug'),
  debugPanel: $('debug-panel'),
  debugBody: $('debug-body'),
  debugDownload: $('debug-download'),
  debugCopy: $('debug-copy'),
  debugSave: $('debug-save'),
  debugClear: $('debug-clear'),
  debugClose: $('debug-close'),
  setTheme: $('set-theme'),
  setBootIntro: $('set-bootintro'),
  setHighlight: $('set-highlight'),
  setCloseX: $('set-close-x'),
  setFontSize: $('set-font-size'),
  setUiFontSize: $('set-ui-font-size'),
  setFontFamily: $('set-font-family'),
  setFontFamilyCustom: $('set-font-family-custom'),
  setFontFamilyCustomWrap: $('set-font-family-custom-wrap'),
  setAutoReconnect: $('set-autoreconnect'),
  setVerify: $('set-verify'),
  setAutoTrust: $('set-autotrust'),
  setRestore: $('set-restore'),
  setClose: $('set-close'),
  ansiEditor: $('ansi-editor'),
  ansiReset: $('ansi-reset'),
  setPwd: $('set-pwd'),
  pwdModal: $('pwd-modal'),
  pwdCurrent: $('pwd-current'),
  pwdNew: $('pwd-new'),
  pwdConfirm: $('pwd-confirm'),
  pwdMsg: $('pwd-msg'),
  pwdSave: $('pwd-save'),
  pwdCancel: $('pwd-cancel'),
  confirmPwdModal: $('confirm-pwd-modal'),
  confirmPwdDesc: $('confirm-pwd-desc'),
  confirmPwdInput: $('confirm-pwd-input'),
  confirmPwdMsg: $('confirm-pwd-msg'),
  confirmPwdOk: $('confirm-pwd-ok'),
  confirmPwdCancel: $('confirm-pwd-cancel'),
  kbdModal: $('kbd-modal'),
  kbdDesc: $('kbd-desc'),
  kbdFields: $('kbd-fields'),
  kbdOk: $('kbd-ok'),
  kbdCancel: $('kbd-cancel'),
  filePwdModal: $('file-pwd-modal'),
  filePwdTitle: $('file-pwd-title'),
  filePwdHint: $('file-pwd-hint'),
  filePwdLabel: $('file-pwd-label'),
  filePwdInput: $('file-pwd-input'),
  filePwdInput2: $('file-pwd-input2'),
  filePwdConfirmWrap: $('file-pwd-confirm-wrap'),
  filePwdMsg: $('file-pwd-msg'),
  filePwdOk: $('file-pwd-ok'),
  filePwdCancel: $('file-pwd-cancel'),
  // AI 助手
  btnAi: $('btn-ai'),
  aiPanel: $('ai-panel'),
  aiHostDrop: $('ai-host-drop'),
  aiHostToggle: $('ai-host-toggle'),
  aiHostLabel: $('ai-host-label'),
  aiHostPanel: $('ai-host-panel'),
  aiChat: $('ai-chat'),
  aiInput: $('ai-input'),
  aiSend: $('ai-send'),
  aiStop: $('ai-stop'),
  aiClose: $('ai-close'),
  aiConfigToggle: $('ai-config-toggle'),
  aiConfig: $('ai-config'),
  aiUrl: $('ai-url'),
  aiModel: $('ai-model'),
  aiModelAdd: $('ai-model-add'),
  aiModelDel: $('ai-model-del'),
  aiFormat: $('ai-format'),
  aiKey: $('ai-key'),
  aiVendor: $('ai-vendor'),
  aiVendorSelect: $('ai-vendor-select'),
  aiVendorNew: $('ai-vendor-new'),
  aiVendorDel: $('ai-vendor-del'),
  aiConfigSave: $('ai-config-save'),
  // Agent Skill 技能库
  skillsList: $('skills-list'),
  skillsNew: $('skills-new'),
  skillsOpenFolder: $('skills-open-folder'),
  skillsEditor: $('skills-editor'),
  skillsEditName: $('skills-edit-name'),
  skillsEditDesc: $('skills-edit-desc'),
  skillsEditContent: $('skills-edit-content'),
  skillsEditEnabled: $('skills-edit-enabled'),
  skillsEditSave: $('skills-edit-save'),
  skillsEditCancel: $('skills-edit-cancel'),
  // 用户知识库
  kbList: $('kb-list'),
  kbImport: $('kb-import'),
  kbOpenFolder: $('kb-open-folder'),
  kbAiToggle: $('kb-ai-toggle'),
  kbSearch: $('kb-search'),
  kbResults: $('kb-results'),

  // 终端搜索
  termSearch: $('term-search'),
  termSearchInput: $('term-search-input'),
  termSearchPrev: $('term-search-prev'),
  termSearchNext: $('term-search-next'),
  termSearchCount: $('term-search-count'),
  termSearchClose: $('term-search-close'),

  // SFTP 面板
  btnSftpToggle: $('btn-sftp-toggle'),
  sftpPanel: $('sftp-panel'),
  btnTunnel: $('btn-tunnel'),
  tunnelModal: $('tunnel-modal'),
  tunnelList: $('tunnel-list'),
  tunnelNew: $('tunnel-new'),
  tunnelForm: $('tunnel-form'),
  tunnelSession: $('tunnel-session'),
  tunnelType: $('tunnel-type'),
  tunnelLocalport: $('tunnel-localport'),
  tunnelName: $('tunnel-name'),
  tunnelRemoteRow: $('tunnel-remote-row'),
  tunnelRemotehost: $('tunnel-remotehost'),
  tunnelRemoteport: $('tunnel-remoteport'),
  tunnelCreate: $('tunnel-create'),
  tunnelFormCancel: $('tunnel-form-cancel'),
  tunnelClose: $('tunnel-close'),
  sftpPath: $('sftp-path'),
  sftpConn: $('sftp-conn'),
  sftpConnMenu: $('sftp-conn-menu'),
  sftpList: $('sftp-list'),
  sftpLog: $('sftp-log'),
  btnSftpUp: $('btn-sftp-up'),
  btnSftpRefresh: $('btn-sftp-refresh'),
  btnSftpMkdir: $('btn-sftp-mkdir'),
  btnSftpUpload: $('btn-sftp-upload'),
  btnSftpDownload: $('btn-sftp-download'),
  btnSftpDelete: $('btn-sftp-delete'),
  btnSftpSelectAll: $('btn-sftp-select-all'),
  btnSftpEdit: $('btn-sftp-edit'),
  sftpProgress: $('sftp-progress'),
  sftpProgressLabel: $('sftp-progress-label'),
  btnSftpTransfersClear: $('btn-sftp-transfers-clear'),
  editModal: $('edit-modal'),
  editPath: $('edit-path'),
  editContent: $('edit-content'),
  editSave: $('edit-save'),
  editCancel: $('edit-cancel'),
  sftpFooter: $('sftp-footer'),
  btnCmd: $('btn-cmd'),
  cmdPanel: $('cmd-panel'),
  cmdList: $('cmd-list'),
  cmdCount: $('cmd-count'),
  cmdRecordToggle: $('cmd-record-toggle'),
  cmdArchive: $('cmd-archive'),
  cmdClear: $('cmd-clear'),
  cmdClose: $('cmd-close'),
  setCmdRecord: $('set-cmdrecord'),
  setSessionLog: $('set-sessionlog'),
  setAutoFillPw: $('set-autofillpw'),
  setLockIdle: $('set-lock-idle'),
  lockNote: $('lock-note'),
  // 智能命令推荐
  btnRecommend: $('btn-recommend'),
  recommendMenu: $('recommend-menu'),
  recommendList: $('recommend-list'),
  recommendHost: $('recommend-host'),

  // 快速命令
  btnQuick: $('btn-quick'),
  quickModal: $('quick-modal'),
  quickList: $('quick-list'),
  quickName: $('quick-name'),
  quickCommand: $('quick-command'),
  quickAddBtn: $('quick-add-btn'),
  quickCancelBtn: $('quick-cancel-btn'),
  quickClose: $('quick-close'),

  // 批量执行面板
  btnBatch: $('btn-batch'),
  batchPanel: $('batch-panel'),
  batchHosts: $('batch-hosts'),
  batchCmd: $('batch-cmd'),
  batchPanelCount: $('batch-panel-count'),
  batchRun: $('batch-run'),
  batchPanelClear: $('batch-panel-clear'),
  batchResults: $('batch-results'),
  batchPanelClose: $('batch-panel-close'),

  // 会话录制与回放(一个按钮 + 下拉菜单)
  btnRec: $('btn-rec'),
  recMenu: $('rec-menu'),
  recordingsModal: $('recordings-modal'),
  recordingsList: $('recordings-list'),
  recordingsEmpty: $('recordings-empty'),
  recordingsOpenDir: $('recordings-open-dir'),
  recordingsClose: $('recordings-close'),
  replayModal: $('replay-modal'),
  replayTitle: $('replay-title'),
  replayTerm: $('replay-term'),
  replayInputSide: $('replay-input-side'),
  replaySideToggle: $('replay-side-toggle'),
  replayInputList: $('replay-input-list'),
  replayPlay: $('replay-play'),
  replaySpeed: $('replay-speed'),
  replayProgress: $('replay-progress'),
  replayTime: $('replay-time'),
  replayAllsync: $('replay-allsync'),
  replayClose: $('replay-close'),

  // 可拖动分隔条
  sessionPanel: $('session-panel'),
  dividerV: $('divider-v'),
  dividerH: $('divider-h'),
  dividerBastion: $('divider-bastion'),
  bastionSlot: $('bastion-slot'),
  btnTogglePanel: $('btn-toggle-panel'),

  // 批量操作条
  batchBar: $('batch-bar'),
  batchCount: $('batch-count'),
  batchConnect: $('batch-connect'),
  batchClose: $('batch-close'),
  batchUpload: $('batch-upload'),
  batchDownload: $('batch-download'),
  batchDelete: $('batch-delete'),
  batchClear: $('batch-clear'),
  btnSelectAllFiltered: $('btn-select-all-filtered'),
  palette: $('palette'),
  paletteInput: $('palette-input'),
  paletteResults: $('palette-results'),
  btnHelp: $('btn-help'),
  helpModal: $('help-modal'),
  helpCloseX: $('help-close-x'),
  helpClose: $('help-close'),
};

// ---------- 应用状态 ----------
const state = {
  sessions: [],          // SQLite 里的全部会话
  tabs: new Map(),       // 终端标签:sessionId -> { ... }
  activeSessionId: null, // 当前激活的标签
  editingId: null,       // 弹窗正在编辑的会话 id(null = 新建)
  broadcast: false,      // 广播模式(参考 Xshell):输入同步到所有已连接会话
  splitMode: null,       // 分屏模式:null=单面板,'v'=垂直均分(等宽列),'h'=横向均分(等高行)
  splitSizes: {},        // 分屏面板拖动后的大小:sessionId -> { v: px, h: px }(重新渲染不丢)
  splitZoom: null,       // 分屏"放大"的面板 sessionId,null=正常网格(点 Cmd+Enter 或面板 ⤢ 切换)
  groups: [],            // 分组列表 [{ id, name }]
  collapsedGroups: new Set(), // 被折叠的分组 id 集合
  collapsedTopHost: true,    // 顶级"🖥 主机"分组是否折叠(默认收起)
  collapsedTopBastion: true, // 顶级"🛡 堡垒机"分组是否折叠(默认收起)
  searchScope: 'all',        // 搜索/显示范围:all=全部 | host=仅主机 | bastion=仅堡垒机
  recentCollapsed: false, // "最近连接"分组是否折叠(点三角切换)
  activeGroupId: null,   // 当前"选中"的分组(点了某个分组后,全选只针对该组;null=全选所有)
  selectedForBatch: new Set(), // 多选用于批量操作的会话 id 集合
  settings: {            // 应用设置(存 localStorage)
    theme: 'dark',       // 主题名(对应 THEMES 的键)
    highlight: true,     // 终端关键字高亮开关
    highlightKeywords: ['error', 'warning', 'fail', 'failed', 'fatal'],
    outputFilters: [],           // 终端输出过滤条件列表: [{ id, kw, on }],可多选启用
    aiKey: '',           // (兼容旧数据)AI API Key —— 新结构见 aiVendors
    aiVendor: '',        // (兼容旧数据)模型厂商名 —— 新结构见 aiVendors
    aiUrl: 'https://api.deepseek.com/anthropic', // (兼容旧数据)新默认:DeepSeek Anthropic 兼容端点
    aiModel: 'deepseek-v4-flash', // (兼容旧数据)
    aiModels: ['deepseek-v4-flash', 'deepseek-v4-pro'], // (兼容旧数据)
    aiFormat: 'anthropic',      // (兼容旧数据)
    aiVendors: {},       // 多厂商配置: 厂商名 -> { url, key, format, model, models[] },每家独立互不影响
    aiActiveVendor: '',  // 当前激活的厂商名(AI 对话用这家)
    fontSize: 13,               // 终端字体大小
    uiFontSize: 13,             // 界面字体大小(工具栏/会话列表等,与终端字号独立)
    fontFamily: '"SF Mono", Menlo, Consolas, "Courier New", monospace', // 终端字体
    autoReconnect: true,        // 断线自动重连开关
    verifyHostKey: true,        // 服务器指纹校验(known_hosts)
    restoreOnStartup: false,    // 启动时恢复上次打开的会话(默认关,不自动连)
    restoreSessions: [],        // 上次打开的会话 id 列表
    sessionLog: true,           // 会话日志落盘开关(默认开)
    settingsVersion: 3,         // 设置结构版本(用于一次性的默认值迁移)
    cmdRecord: true,            // 命令记录开关(默认开)
    autoFillPassword: true,     // 自动填充密码:终端出现 Password: 提示时自动发会话保存的密码(默认开)
    lockIdleMin: 5,             // 闲置自动锁定分钟(0=关闭)
    customAnsi: null,           // 终端 ANSI 16 色自定义(null=用默认色板)
    panelCollapsed: false,      // 左侧会话列表是否折叠
    sessionView: 'tree',        // 会话列表视图: 'tree'树形 | 'list'列表 | 'grid'网格
    debugPanelPos: null,        // 调试日志面板位置 {x, y}(null=默认右下角)
    bootIntro: 'short',         // 启动过场动画: 'full'完整2.4s | 'short'缩短0.8s | 'skip'跳过
  },
  jmsServers: [],   // JumpServer 服务器列表: [{ id, name, baseUrl, sshHost, sshPort, account, password, token, user, assets, seq }]
  jmsActiveId: null, // 当前正在管理/登录的服务器 id
  jmsSeq: 0,         // 合成会话 id 全局计数器
  jmsRestoreDone: false, // 是否已做过持久登录恢复(避免重复登录)
  bastionAssets: [], // H3C 堡垒机资产(从 webview 拦截的资产 API 捕获)
  bastionTree: [],   // H3C 堡垒机目录树(getAccessViewTree 捕获: [{name,id,path,empty,...}])
  bastionFavSet: new Set(), // 收藏设备 devId 集合(getFavoriteDevices / userFav 捕获)
  bastionFavTree: null,     // 收藏夹树(userFav/getTree: {name, children:[{name}]})
  bastionDirCollapsed: new Set(), // 折叠的业务目录名(分组视图)
  bastionDirsInit: false,   // 分组视图是否已完成"首次默认折叠"初始化
  bastionGrouping: false,   // 是否正在后台逐目录补充分组
  bastionUrl: '',           // 当前资产对应的堡垒机地址 origin(持久化分组键,poll 持续同步)
  bastionAllFetched: false, // 是否已成功主动拉过全量(SPA 登录后自动重试的依据)
  bastionLastAutoFetch: 0,  // 上次自动重试拉全量的时间戳(节流)
  bastionFavFetchAt: 0,     // 上次兜底拉收藏夹树(userFav/getTree)的时间戳(节流)
  bastionCollapsed: true, // H3C 堡垒机区默认折叠(打开堡垒机后左侧分组收起,需展开才看资产)
  collapsedBastionSaved: true, // 左侧"堡垒机连接"分组是否折叠(默认收起,登录后不自动展开)
  bastionZoom: 1, // 堡垒机画面缩放(0.5~2.5,webview setZoomFactor)
  collapsedJms: new Set(), // 折叠的 JumpServer 服务器 id 集合
  sftp: {
    visible: false,  // 面板是否展开
    sessionId: null, // 正在浏览哪个连接(跟随活动标签)
    path: '.',       // 当前远程目录
    selected: null,  // 最近一次点击的条目 { name, isDir, remotePath }(兼容旧逻辑)
    selectedSet: new Set(), // 多选集合:存的是 remotePath 字符串,点一下加/取消
    entries: [],     // 当前列表数据
    log: [],         // 传输记录: [{ time, text, isError }]
  },
  sftpUploadFlash: new Set(), // 刚上传成功的条目名:列表刷新后高亮定位(让用户看到传到了哪)
  cmdHistory: {},    // 命令记录: sessionId -> { host, commands: [{ time, command }] }
  cmdArchivesView: null,   // 命令面板视图: null=当前记录, 'files'=归档文件列表
  cmdArchiveFiles: [],     // 归档批次列表
  cmdArchiveHost: '',      // 当前查看归档的主机
  selectedArchiveFile: null, // 选中的归档批次(用于下载/删除)
  aiSelectedHosts: new Set(), // AI 选中的主机(sessionId 集合,可多选)
  batchHosts: new Set(),      // 批量执行面板选中的主机(sessionId 集合)
  recent: [],                 // 最近连接: [{ id, time }] 最近的在前(会话列表顶部展示)
  recording: new Map(),       // 录制中: sessionId -> true(工具栏录制按钮按当前标签查它)
};

let sessionSeq = 0;

// 回车键是否应触发"提交":中文输入法组合中(isComposing / keyCode 229)按回车是选字,
// 不算提交,否则输入法选字会误触发送/保存。
function isEnterSubmit(e) {
  return e.key === 'Enter' && !e.isComposing && e.keyCode !== 229;
}

function setStatus(text, color) {
  els.toolbarStatus.textContent = text;
  els.toolbarStatus.style.color = color || 'var(--green)';
}

// =====================================================================
// 设置:主题 + 终端关键字高亮(参考 Netcatty 的个性化)
// =====================================================================
function loadSettings() {
  try {
    const raw = localStorage.getItem('jms-settings');
    if (raw) Object.assign(state.settings, JSON.parse(raw));
  } catch { /* ignore */ }
  // v2 迁移:默认"不自动恢复上次连接的会话"(旧默认是 true,老用户一次改成 false)
  if (!state.settings.settingsVersion || state.settings.settingsVersion < 2) {
    state.settings.restoreOnStartup = false;
    state.settings.settingsVersion = 2;
    saveSettings();
  }
  migrateAiVendors(); // 旧版单厂商配置 → 新版多厂商结构
  // v3 迁移:把"没配过 / 还是旧默认 Anthropic 地址"的厂商 url 修正为 DeepSeek Anthropic 兼容端点
  if (!state.settings.settingsVersion || state.settings.settingsVersion < 3) {
    migrateDeepSeekUrl();
    state.settings.settingsVersion = 3;
    saveSettings();
  }
}
function saveSettings() {
  try { localStorage.setItem('jms-settings', JSON.stringify(state.settings)); } catch { /* ignore */ }
}

// 解析最终生效主题:auto 跟随系统明暗
function resolveEffectiveThemeId() {
  const t = state.settings.theme;
  if (t !== 'auto') return THEMES[t] ? t : 'dark';
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// 应用主题:改终端配色 + 应用外壳的 CSS 变量(派生 + 预设 css 覆盖)
function applyTheme() {
  const th = THEMES[resolveEffectiveThemeId()] || THEMES.dark;
  const root = document.documentElement.style;
  const css = { ...deriveUiTokens(th.term, th.appearance), ...(th.css || {}) };
  for (const [k, v] of Object.entries(css)) root.setProperty(k, v);
  root.setProperty('--ui-font', (state.settings.uiFontSize || 13) + 'px'); // 界面字体大小(工具栏/列表等)
  const ansi = state.settings.customAnsi || th.ansi || DEFAULT_ANSI; // ANSI 16 色:用户自定义优先,否则用主题自带色板,兜底默认
  for (const t of state.tabs.values()) {
    try {
      t.term.options.theme = { ...th.term, ansi };
      t.term.options.background = th.term.background;
      t.term.refresh(0, t.term.rows - 1);
    } catch { /* ignore */ }
  }
}

function openSettingsModal() {
  // 主题下拉:auto(跟随系统) + 按明暗分组,20 项平铺难扫
  els.setTheme.innerHTML = '';
  const addThemeOpt = (value, text) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    els.setTheme.appendChild(opt);
  };
  addThemeOpt('auto', '跟随系统 (自动明暗)');
  for (const [appearance, label] of [['dark', '深色'], ['light', '浅色']]) {
    const g = document.createElement('optgroup');
    g.label = label;
    for (const [key, th] of Object.entries(THEMES)) {
      if (th.appearance !== appearance) continue;
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = th.name;
      g.appendChild(opt);
    }
    if (g.children.length) els.setTheme.appendChild(g);
  }
  const cur = state.settings.theme;
  els.setTheme.value = cur === 'auto' ? 'auto' : (THEMES[cur] ? cur : 'dark');
  els.setBootIntro.value = ['full', 'short', 'skip'].includes(state.settings.bootIntro) ? state.settings.bootIntro : 'short';
  els.setHighlight.checked = !!state.settings.highlight;
  els.setFontSize.value = state.settings.fontSize || 13;
  els.setUiFontSize.value = state.settings.uiFontSize || 13;
  syncFontFamilyControls();
  els.setAutoReconnect.checked = state.settings.autoReconnect !== false;
  els.setVerify.checked = state.settings.verifyHostKey !== false;
  els.setAutoTrust.checked = state.settings.autoTrustHostKey === true;
  els.setRestore.checked = state.settings.restoreOnStartup !== false;
  els.setCmdRecord.checked = state.settings.cmdRecord !== false;
  els.setSessionLog.checked = state.settings.sessionLog !== false;
  els.setAutoFillPw.checked = state.settings.autoFillPassword !== false;
  els.setLockIdle.value = Number(state.settings.lockIdleMin) > 0 ? state.settings.lockIdleMin : 0;
  renderAnsiEditor();
  refreshLockNote();
  els.settingsModal.classList.remove('hidden');
}

// 闲置锁定依赖 App 密码:未设置密码时禁用输入并说明(否则会静默不生效)
function refreshLockNote() {
  window.api.lockHas().then((r) => {
    const has = !!(r && r.ok && r.has);
    els.setLockIdle.disabled = !has;
    els.lockNote.textContent = has ? '' : '⚠ 未设置 App 密码,闲置锁定不会生效,请先在下方设置密码';
  });
}

// 渲染 ANSI 16 色编辑器(颜色选择器,改色即时生效)
const ANSI_NAMES = ['黑', '红', '绿', '黄', '蓝', '紫', '青', '白', '亮黑', '亮红', '亮绿', '亮黄', '亮蓝', '亮紫', '亮青', '亮白'];
function renderAnsiEditor() {
  const box = els.ansiEditor;
  box.innerHTML = '';
  // 显示当前生效色板(用户自定义优先,否则当前主题自带色板,兜底默认);改动即写入 customAnsi 覆盖主题色
  const th = THEMES[resolveEffectiveThemeId()] || THEMES.dark;
  const colors = state.settings.customAnsi || th.ansi || DEFAULT_ANSI;
  colors.forEach((hex, i) => {
    const row = document.createElement('label');
    row.className = 'ansi-row';
    row.title = `${ANSI_NAMES[i]} (${i + 1})`;
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.value = hex;
    picker.addEventListener('input', () => {
      if (!state.settings.customAnsi) state.settings.customAnsi = [...DEFAULT_ANSI];
      state.settings.customAnsi[i] = picker.value;
      saveSettings();
      applyTheme(); // 即时预览
    });
    const name = document.createElement('span');
    name.textContent = ANSI_NAMES[i];
    row.appendChild(picker);
    row.appendChild(name);
    box.appendChild(row);
  });
}
// 重置 ANSI 色板为默认
function resetAnsi() {
  state.settings.customAnsi = null;
  saveSettings();
  renderAnsiEditor();
  applyTheme();
}

// ---- 修改密码(App 密码锁 + 数据库整库重新加密) ----
function openPwdModal() {
  els.pwdCurrent.value = els.pwdNew.value = els.pwdConfirm.value = '';
  els.pwdMsg.classList.add('hidden');
  els.pwdModal.classList.remove('hidden');
  els.pwdCurrent.focus();
}
function closePwdModal() { els.pwdModal.classList.add('hidden'); }
async function changePassword() {
  const cur = els.pwdCurrent.value;
  const n1 = els.pwdNew.value;
  const n2 = els.pwdConfirm.value;
  const showErr = (msg) => { els.pwdMsg.textContent = msg; els.pwdMsg.classList.remove('hidden'); };
  if (!cur || !n1) { showErr('请填写当前密码和新密码'); return; }
  if (n1 !== n2) { showErr('两次新密码不一致'); return; }
  const res = await window.api.lockChange(cur, n1);
  if (res && res.ok) {
    closePwdModal();
    refreshLockNote(); // 密码已设置 → 闲置锁定重新可用
    alert('✅ 密码已修改,数据库已用新密码重新加密');
  } else {
    showErr((res && res.error) || '修改失败');
  }
}

// ---- 备份文件密码弹窗(导出设密码 set / 导入输密码 enter) ----
let filePwdAction = null; // { type:'export', data } | { type:'import', buf }
function promptFilePwd(mode, action) {
  filePwdAction = action;
  const isSet = mode === 'set';
  els.filePwdTitle.textContent = isSet ? '设置导出密码' : '输入备份密码';
  els.filePwdHint.textContent = isSet ? '备份文件会用这个密码加密,导入时需输入它。' : '请输入该备份文件当初设置的密码。';
  els.filePwdConfirmWrap.classList.toggle('hidden', !isSet);
  els.filePwdInput.value = '';
  els.filePwdInput2.value = '';
  els.filePwdMsg.classList.add('hidden');
  els.filePwdModal.classList.remove('hidden');
  els.filePwdInput.focus();
}
function closeFilePwd() { filePwdAction = null; els.filePwdModal.classList.add('hidden'); }
async function confirmFilePwd() {
  const action = filePwdAction;
  const isSet = !els.filePwdConfirmWrap.classList.contains('hidden');
  const p1 = els.filePwdInput.value;
  const showErr = (m) => { els.filePwdMsg.textContent = m; els.filePwdMsg.classList.remove('hidden'); };
  if (!p1) { showErr('请输入密码'); return; }
  if (isSet) {
    if (p1.length < 8) { showErr('密码至少 8 位'); return; }
    if (p1 !== els.filePwdInput2.value) { showErr('两次密码不一致'); return; }
  }
  closeFilePwd();
  if (!action) return;
  if (action.type === 'export') {
    const res = await window.api.exportSessions(action.data, p1);
    if (res && res.ok) setStatus(`已导出 ${res.count} 个会话(加密) → ${res.path}`, 'var(--green)');
    else if (res && !res.canceled) alert(res && res.error ? res.error : '导出失败');
  } else if (action.type === 'import') {
    const res = await window.api.importBackup(action.buf, p1);
    if (res && res.ok) {
      els.importResult.innerHTML = '';
      setImportPreview(rowsToSessions(res.rows)); // 先预览,点"导入"才提交
    } else {
      els.importResult.innerHTML = `<span class="bad">${(res && res.error) || '导入失败'}</span>`;
    }
  }
}

// 从 Xshell/iTerm2 导入:选文件 → 主进程解析 → 预览(密码需重新填,Xshell 加密无法还原)
async function importExternalSelected() {
  const files = els.importExternalFile.files;
  if (!files || !files.length) return;
  els.importExternalFile.value = '';
  const paths = [];
  for (const f of files) {
    const p = window.api.getPathForFile ? window.api.getPathForFile(f) : f.path;
    if (p) paths.push(p);
  }
  if (!paths.length) { alert('无法获取文件路径'); return; }
  const res = await window.api.importExternal(paths);
  if (res && res.ok) {
    els.importResult.innerHTML = '';
    setImportPreview(res.rows);
  } else {
    els.importResult.innerHTML = `<span class="bad">${(res && res.error) || '解析失败'}</span>`;
  }
}

// 从加密备份(.polaris)导入:选文件 → 输密码 → 解密解析 → 统一导入
async function importBackupSelected() {
  const file = els.importBackupFile.files[0];
  if (!file) return;
  els.importBackupFile.value = ''; // 允许下次再选同一文件
  const buf = await file.arrayBuffer();
  promptFilePwd('enter', { type: 'import', buf });
}

// 把字体大小/字体应用到所有已打开的终端
function applyFontSettings() {
  for (const t of state.tabs.values()) {
    try {
      t.term.options.fontSize = state.settings.fontSize || 13;
      t.term.options.fontFamily = state.settings.fontFamily || '"SF Mono", Menlo, Consolas, "Courier New", monospace';
      t.term.refresh(0, t.term.rows - 1);
    } catch { /* ignore */ }
  }
}

// 同步字体下拉与自定义输入:当前 fontFamily 不在预设选项里 → 切到「自定义…」并回填输入框
function syncFontFamilyControls() {
  const cur = state.settings.fontFamily || '';
  const opts = [...els.setFontFamily.options].map((o) => o.value);
  if (opts.includes(cur) && cur !== '__custom__') {
    els.setFontFamily.value = cur;
    els.setFontFamilyCustomWrap.style.display = 'none';
  } else {
    els.setFontFamily.value = '__custom__';
    els.setFontFamilyCustom.value = cur;
    els.setFontFamilyCustomWrap.style.display = '';
  }
}

// 旧版只有单套 AI 配置 → 迁移成多厂商字典 aiVendors(老用户不丢配置)
function migrateAiVendors() {
  const s = state.settings;
  const vendors = s.aiVendors && typeof s.aiVendors === 'object' ? s.aiVendors : {};
  if (Object.keys(vendors).length === 0) {
    const name = (s.aiVendor || '').trim() || '默认厂商';
    const models = (Array.isArray(s.aiModels) && s.aiModels.length) ? s.aiModels : ['deepseek-v4-flash', 'deepseek-v4-pro'];
    vendors[name] = {
      url: s.aiUrl || '', key: s.aiKey || '', format: s.aiFormat || 'anthropic',
      model: s.aiModel || models[0], models,
    };
    s.aiVendors = vendors;
  }
  if (!s.aiActiveVendor || !vendors[s.aiActiveVendor]) {
    s.aiActiveVendor = Object.keys(vendors)[0] || '';
  }
}

// v3 迁移:默认厂商接入 DeepSeek。旧默认 url 指到 Anthropic 官网,模型却是 deepseek-*(对不上),
// 这里只修正"没配过 / 还是旧默认地址"的厂商 url,不碰用户自己填的其他厂商。
function migrateDeepSeekUrl() {
  const vendors = state.settings.aiVendors && typeof state.settings.aiVendors === 'object' ? state.settings.aiVendors : {};
  const OLD_ANTHROPIC = 'https://api.anthropic.com/v1/messages';
  for (const v of Object.values(vendors)) {
    const url = String(v.url || '').trim();
    if (!url || url === OLD_ANTHROPIC) v.url = 'https://api.deepseek.com/anthropic';
  }
}

// 取当前激活厂商的配置对象
function activeAiVendor() {
  return (state.settings.aiVendors || {})[state.settings.aiActiveVendor] || null;
}

// 填充厂商下拉框(头部那个)
function fillVendorSelect() {
  const vendors = state.settings.aiVendors || {};
  els.aiVendorSelect.innerHTML = '';
  for (const name of Object.keys(vendors)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    els.aiVendorSelect.appendChild(opt);
  }
  els.aiVendorSelect.value = state.settings.aiActiveVendor || '';
}

// 切换到某厂商:激活它并把它的配置填进 ⚙ 面板
function selectAiVendor(name) {
  if (!name || !(state.settings.aiVendors || {})[name]) return;
  state.settings.aiActiveVendor = name;
  saveSettings();
  fillVendorSelect();
  fillAiConfig();
}

// 把当前厂商的配置填进面板(展开 ⚙ 或打开面板/切换厂商时用)
function fillAiConfig() {
  const v = activeAiVendor() || {};
  els.aiVendor.value = state.settings.aiActiveVendor || '';
  els.aiUrl.value = v.url || '';
  els.aiFormat.value = v.format || 'anthropic';
  // 密文解密后显示明文供编辑;老明文(无 enc:v1: 前缀)原样显示
  els.aiKey.value = '';
  if (v.key) {
    decryptSecret(v.key).then((plain) => {
      if (els.aiKey.value === '' && activeAiVendor() === v) els.aiKey.value = plain || '';
    });
  }
  fillModelSelect();
}

// 填充模型下拉框:列出当前厂商的模型列表,当前选中的高亮
function fillModelSelect() {
  const v = activeAiVendor() || {};
  if (!Array.isArray(v.models)) v.models = [];
  // 注意:不再自动补默认模型 —— 否则删空后又会冒出来,看起来"删不掉"。
  // 默认模型只在新建厂商/迁移老配置时填一次。
  els.aiModel.innerHTML = '';
  for (const m of v.models) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    els.aiModel.appendChild(opt);
  }
  els.aiModel.value = v.model || v.models[0];
  v.model = els.aiModel.value;
}

// 添加一个模型(加到当前厂商的列表)
function addAiModel() {
  showPrompt({
    title: '添加模型', label: '模型名', value: '',
    onOk: (name) => {
      if (!name) return;
      const v = activeAiVendor() || {};
      if (!Array.isArray(v.models)) v.models = [];
      if (!v.models.includes(name)) v.models.push(name);
      v.model = name;
      saveSettings();
      fillModelSelect();
    },
  });
}

// 删除当前选中的模型(只删当前厂商的)
function delAiModel() {
  const cur = els.aiModel.value;
  if (!cur) return;
  const v = activeAiVendor() || {};
  if (!Array.isArray(v.models)) v.models = [];
  v.models = v.models.filter((m) => m !== cur);
  v.model = v.models[0] || '';
  saveSettings();
  fillModelSelect();
}
function closeSettingsModal() {
  els.settingsModal.classList.add('hidden');
}

// =====================================================================
// AI 运维助手(参考 Netcatty 的 Catty Agent)
// =====================================================================

// ---- 凭据安全存储(与 JMS 密码一致,safeStorage 加密;enc:v1: 前缀标识密文)----
// 之前 H3C 堡垒机密码与 AI Key 明文存 localStorage(设置文件是明文 LevelDB,
// 任何能读 userData 的进程都能拿到)。这里统一:落盘前加密,读取时解密,老明文兼容。
async function encryptSecret(plain) {
  if (!plain) return '';
  if (plain.startsWith('enc:v1:')) return plain; // 已是密文,不重复加密
  try { const r = await window.api.cryptoEncrypt(plain); return (r && r.value) || plain; } catch { return plain; }
}
async function decryptSecret(secret) {
  if (secret && secret.startsWith('enc:v1:')) {
    try { const r = await window.api.cryptoDecrypt(secret); return (r && r.value) || secret; } catch { return secret; }
  }
  return secret || ''; // 老明文/空串原样返回
}

const aiHistory = []; // 对话历史 [{ role, content }]
// 历史上限:只留最近 100 条,防止长时间对话内存无限增长(性能优化)
function pushAiHistory(msg) {
  aiHistory.push(msg);
  if (aiHistory.length > 100) {
    const removed = aiHistory.length - 100;
    aiHistory.splice(0, removed);
    // 上下文截断提示(借鉴 Chaterm ContextManager):粗暴裁剪会让 AI 不知道历史被删,
    // 对早前内容产生幻觉。插入一条显式提示,并让 AI 在必要时请用户补充背景。
    // 用 role:'user' 而非 'system':Anthropic 的 system 走独立参数,混在 messages 里会报错。
    aiHistory.unshift({
      role: 'user',
      content: `[系统提示:为节省上下文,较早的 ${removed} 条对话已被截断。不要臆测截断前的内容;如果执行任务需要那些背景,请主动询问用户补充。]`,
    });
  }
}
let aiBusy = false;
let aiSentHistory = [];   // AI 输入框历史(用户发过的提问),↑↓ 调出
let aiHistoryIndex = -1;  // 当前浏览到的历史位置:-1=未在浏览

function toggleAiPanel() {
  hideWebviewDuringAiToggle();
  els.aiPanel.classList.toggle('hidden');
  if (!els.aiPanel.classList.contains('hidden')) {
    updateAiHostList();
    fillVendorSelect();
    fillAiConfig();
    els.aiInput.focus();
  }
  refitAll(); // 终端区域宽度变了,重新适配
  syncPanelButtons();
}

// AI 面板开关会让右侧 dock(堡垒机 webview 等)重新布局,Windows 软件渲染下
// webview 原生表面被平移可能拖垮合成器(整窗冻结/工具栏空白、JS 仍在跑)。
// 开关瞬间把 webview 隐藏一帧、布局稳定后再恢复,避开表面重定位的崩溃路径。
// 堡垒机面板没开(webview 本就 display:none)则无操作。
function hideWebviewDuringAiToggle() {
  const wv = els.bastionWebview;
  if (!wv || !wv.style || !els.bastionSlot) return;
  if (els.bastionSlot.classList.contains('hidden')) return; // 堡垒机面板收起,webview 不可见
  if (wv.style.display === 'none') return;                  // 已隐藏,无需处理
  const prev = wv.style.display;
  wv.style.display = 'none';
  // 等 2 帧布局稳定后再恢复;若合成器卡住 rAF 不触发,webview 保持隐藏(比冻结安全)
  let restored = false;
  const restore = () => { if (!restored) { restored = true; wv.style.display = prev; } };
  requestAnimationFrame(() => requestAnimationFrame(restore));
  setTimeout(restore, 100); // 兜底:rAF 因合成器卡住不触发时,100ms 后强制恢复
}

// 刷新 AI 面板的主机多选下拉:列出所有已连接主机(带复选框),可勾选多个
function updateAiHostList() {
  const panel = els.aiHostPanel;
  panel.innerHTML = '';
  const connected = [...state.tabs.values()].filter((t) => t.status === 'connected');
  if (connected.length === 0) {
    panel.innerHTML = '<div class="ai-host-empty">未连接主机</div>';
    state.aiSelectedHosts.clear();
    updateAiHostLabel();
    return;
  }
  // 首次(或没选)默认全选已连接主机
  if (state.aiSelectedHosts.size === 0) {
    for (const t of connected) state.aiSelectedHosts.add(t.sessionId);
  }
  for (const t of connected) {
    const label = document.createElement('label');
    label.className = 'ai-host-opt';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.aiSelectedHosts.has(t.sessionId);
    cb.addEventListener('change', () => {
      if (cb.checked) state.aiSelectedHosts.add(t.sessionId);
      else state.aiSelectedHosts.delete(t.sessionId);
      updateAiHostLabel();
    });
    const span = document.createElement('span');
    span.textContent = `${t.session.name} (${t.session.host})`;
    label.appendChild(cb);
    label.appendChild(span);
    panel.appendChild(label);
  }
  updateAiHostLabel();
}

// 更新主机下拉按钮的显示(已选数量 + 名称)
function updateAiHostLabel() {
  const names = [...state.aiSelectedHosts]
    .map((id) => { const t = state.tabs.get(id); return t && t.session ? t.session.name : null; })
    .filter(Boolean);
  const n = names.length;
  els.aiHostLabel.textContent = n ? `已选 ${n} 台: ${names.join(', ')}` : '未选择主机';
  els.aiHostLabel.title = names.join(', ') || '';
}

// 当前正在进行的流式 AI 会话(渲染层实时更新消息气泡用)
let activeAiStream = null;

// 是不是"清屏"类请求(本地拦截用,保证不依赖模型也能清屏)
function isClearRequest(text) {
  const t = String(text).trim();
  return /^(清屏|清除屏幕|清理屏幕|清一下屏|清下屏|clear|cls)\s*$/i.test(t) ||
    /^(请|帮我|麻烦|请帮我)(清屏|清除屏幕|清理屏幕)/.test(t);
}

// 清除 AI 相关终端的显示:优先清"AI 选中的主机"的终端,没选就清当前激活标签
function clearAiTerminals() {
  const tabs = [...state.aiSelectedHosts].map((id) => state.tabs.get(id)).filter((t) => t && t.term);
  const targets = tabs.length
    ? tabs
    : (state.tabs.get(state.activeSessionId) ? [state.tabs.get(state.activeSessionId)] : []);
  for (const t of targets) {
    try { t.term.clear(); } catch { /* ignore */ }
  }
  return targets.length;
}

async function aiSend() {
  const text = els.aiInput.value.trim();
  if (!text || aiBusy) return;
  // 本地兜底:用户直接说"清屏/clear"→ 不清模型,直接本地清屏。
  // 原因:小模型有时只在文字里说"已清屏"而不调用 clear_screen 工具,屏幕根本不会真的被清除。
  if (isClearRequest(text)) {
    const cleared = clearAiTerminals();
    els.aiInput.value = '';
    pushAiHistory({ role: 'user', content: text });
    appendAiMsg('user', text);
    const wrap = appendAiMsg('assistant', '');
    const bodyEl = wrap.querySelector('.ai-msg-body');
    const span = document.createElement('span');
    bodyEl.appendChild(span);
    span.textContent = cleared ? '已清除本地终端屏幕 ✅' : '没有可清屏的终端(请先连接主机)';
    pushAiHistory({ role: 'assistant', content: span.textContent });
    return;
  }
  const av = activeAiVendor(); // 用当前激活厂商的配置发请求
  if (!av || !av.key) {
    alert('请先在 AI ⚙ 里配置当前厂商的 API Key');
    return;
  }
  // 记录发送的提问,供 ↑↓ 调出历史(连续重复只记一条,上限 100)
  if (aiSentHistory[aiSentHistory.length - 1] !== text) {
    aiSentHistory.push(text);
    if (aiSentHistory.length > 100) aiSentHistory.shift();
  }
  aiHistoryIndex = -1;
  els.aiInput.value = '';
  // 带上选中主机的上下文,让 AI 知道在操作哪些机器(可多选)
  const selTabs = [...state.aiSelectedHosts]
    .map((id) => state.tabs.get(id))
    .filter((t) => t && t.status === 'connected');
  const ctx = selTabs.length
    ? `(目标主机: ${selTabs.map((t) => `${t.session.name}(${t.session.username}@${t.session.host})`).join(', ')})`
    : '(未连接主机)';
  const hosts = selTabs.map((t) => ({
    host: t.session.host, port: t.session.port, username: t.session.username, password: t.session.password,
    privateKey: t.session.private_key || '', passphrase: t.session.passphrase || '',
    sessionId: t.sessionId,
  }));
  pushAiHistory({ role: 'user', content: `${ctx}\n${text}` });
  appendAiMsg('user', text);

  // 流式消息容器:正文里放一个 span 实时追加文本;工具执行行作为独立 tool 消息
  const wrap = appendAiMsg('assistant', '');
  const bodyEl = wrap.querySelector('.ai-msg-body');
  const streamSpan = document.createElement('span');
  bodyEl.appendChild(streamSpan);
  const requestId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  activeAiStream = { requestId, bodyEl, streamSpan, text: '' };

  aiBusy = true;
  els.aiSend.disabled = true;
  els.aiStop.classList.remove('hidden'); // 显示"停止"按钮

  let res = null;
  try {
    res = await window.api.aiChat({
      apiKey: await decryptSecret(av.key), // 存的是 safeStorage 密文,发送前解密成明文
      url: av.url,
      model: av.model,
      format: av.format,
      messages: aiHistory,
      hosts, // 多主机:每项含连接信息 + sessionId(命令同步到这些终端)
      requestId, // 流事件用它对应到本条消息
      kbEnabled: state.settings.kbEnabled !== false, // 知识库:AI 对话时注入相关文档片段
    });
  } catch (e) {
    // 主进程抛异常(invoke reject):必须复位 busy 与按钮,否则 AI 面板永久禁用
    aiBusy = false;
    els.aiSend.disabled = false;
    els.aiStop.classList.add('hidden');
    if (activeAiStream && activeAiStream.bodyEl) activeAiStream.bodyEl.textContent = `⚠️ 请求异常: ${(e && e.message) || '未知错误'}`;
    activeAiStream = null;
    return;
  }
  aiBusy = false;
  els.aiSend.disabled = false;
  els.aiStop.classList.add('hidden');

  const s = activeAiStream;
  activeAiStream = null;
  if (res && res.ok) {
    pushAiHistory({ role: 'assistant', content: res.text });
    if (s && s.text) fillAiBody(s.bodyEl, s.text); // 流结束用完整文本重渲染(带代码块"执行"按钮)
  } else if (s && !s.text) {
    s.bodyEl.textContent = `⚠️ ${res && res.error ? res.error : '请求失败'}`;
  }
}

// 主进程流式事件 → 实时更新消息气泡(文本逐字出现,工具执行实时显示)
window.api.onAiStream((evt) => {
  const s = activeAiStream;
  if (!s || evt.requestId !== s.requestId) return;
  if (evt.type === 'text') {
    s.text += evt.delta;
    s.streamSpan.textContent = s.text;
    els.aiChat.scrollTop = els.aiChat.scrollHeight;
  } else if (evt.type === 'tool') {
    appendAiMsg('tool', `▶ AI 执行: ${evt.command}`);
  } else if (evt.type === 'tool_result') {
    appendAiMsg('tool', `✓ ${evt.command}\n${String(evt.output).slice(0, 300)}`);
  } else if (evt.type === 'tool_rejected') {
    appendAiMsg('tool', `🚫 已拒绝危险命令: ${evt.command}`);
  } else if (evt.type === 'clear_screen') {
    // AI 要求清屏:清除"AI 选中的主机"的终端(没选就清当前激活标签)
    clearAiTerminals();
  } else if (evt.type === 'error') {
    // 中途出错:流式文本末尾打上错误标记(否则气泡无提示地停在半截)
    s.streamSpan.textContent = s.text + (s.text ? '\n' : '') + '⚠️ ' + (evt.message || '请求出错');
    s.text = s.streamSpan.textContent;
  }
});

// 停止按钮:告诉主进程中断当前 AI 执行
els.aiStop.addEventListener('click', () => {
  if (activeAiStream) window.api.aiStop(activeAiStream.requestId);
});

// 把文本填进消息体,解析 ```bash 代码块(带"执行"按钮)
function fillAiBody(body, text) {
  body.innerHTML = '';
  const parts = String(text).split(/```(\w*)\n?([\s\S]*?)```/g);
  for (let i = 0; i < parts.length; i++) {
    if (i % 3 === 0) {
      if (parts[i]) body.appendChild(document.createTextNode(parts[i]));
    } else if (i % 3 === 2) {
      const code = parts[i].trim();
      const pre = document.createElement('pre');
      pre.className = 'ai-code';
      pre.textContent = code;
      body.appendChild(pre);
      const btn = document.createElement('button');
      btn.className = 'btn-mini ai-run';
      btn.textContent = '▶ 在当前终端执行';
      btn.addEventListener('click', () => runInActiveTerminal(code));
      body.appendChild(btn);
    }
  }
}

// 渲染一条消息;assistant 消息里的 ```bash 代码块会带"执行"按钮
function appendAiMsg(role, text) {
  const wrap = document.createElement('div');
  wrap.className = `ai-msg ${role}`;
  const label = document.createElement('div');
  label.className = 'ai-msg-label';
  label.textContent = role === 'user' ? '你' : 'AI';
  wrap.appendChild(label);
  const body = document.createElement('div');
  body.className = 'ai-msg-body';
  fillAiBody(body, text);
  wrap.appendChild(body);
  els.aiChat.appendChild(wrap);
  els.aiChat.scrollTop = els.aiChat.scrollHeight;
  return wrap;
}

// 把命令打到当前活动连接的终端里执行
function runInActiveTerminal(command) {
  const t = state.tabs.get(state.activeSessionId);
  if (!t || t.status !== 'connected') { alert('当前没有已连接的终端'); return; }
  window.api.sshWrite(t.sessionId, command + '\r');
  setStatus(`已在终端执行: ${command.split('\n')[0]}`, 'var(--green)');
}

// 关键字高亮:把输出文本里的关键字用红色 ANSI 包起来
// 高亮正则缓存:关键词没变就不重新编译(原来每次收到数据都 new RegExp,很浪费)
let highlightPattern = null;
let highlightPatternKey = '';
function getHighlightPattern() {
  const kws = state.settings.highlightKeywords.filter(Boolean);
  const key = kws.join('\u0000'); // 关键词数组变成缓存 key
  if (highlightPatternKey !== key) {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 含中文的关键词用子串匹配(JS 的 \b 不认 CJK 边界,"失败"在"命令失败"里会被 \b 漏掉);
    // 纯 ASCII 关键词保留 \b 词边界(避免 "error" 匹配到 "outerror")。
    const parts = kws.map((k) => (/[一-鿿]/.test(k) ? esc(k) : `\\b${esc(k)}\\b`));
    // 百分比恒高亮(如 80%、100%、>80%、80.5%),无需用户配置;覆盖在关键词之后
    parts.push('\\d+(?:\\.\\d+)?%');
    highlightPattern = new RegExp(`(${parts.join('|')})`, 'gi'); // 整组捕获,替换 $1 = 命中的关键词
    highlightPatternKey = key;
  }
  return highlightPattern;
}

// 对已解码的字符串做关键字高亮(GBK 转码后走这里)
function highlightString(text) {
  const kws = state.settings.highlightKeywords.filter((k) => k);
  if (!state.settings.highlight || !kws.length) return text;
  return text.replace(getHighlightPattern(), '\x1b[31m$1\x1b[0m');
}

// UTF-8 字节流高亮:先流式解码成字符串再着色
function highlightText(tab, bytes) {
  return highlightString(tab.decoder.decode(bytes, { stream: true }));
}

// =====================================================================
// 会话列表(从 SQLite 读取并渲染)
// =====================================================================
let groupsCollapsedOnBoot = false; // 启动时全部分组折叠过一次后置位(只在首次 loadSessions 生效)
async function loadSessions() {
  const [res, gres] = await Promise.all([
    window.api.listSessions(),
    window.api.listGroups(),
  ]);
  if (res.ok) {
    state.sessions = res.sessions;
    state.groups = gres.ok ? gres.groups : [];
    // 默认不打开分组:启动时全部分组折叠(只显示分组头,展开后主机才出现);本次会话内展开/折叠状态会记住
    if (!groupsCollapsedOnBoot) {
      for (const g of state.groups) state.collapsedGroups.add(g.id);
      groupsCollapsedOnBoot = true;
    }
    renderSessionList(els.inputSessionSearch.value);
    restoreSessions(); // 数据就绪后恢复上次打开的会话(默认关闭,restoreOnStartup=false 时直接跳过)
    restoreBastionAssets(); // 恢复上次捕获的堡垒机资产(重启不丢;webview 连上后会刷新)
  } else {
    setStatus(`读取会话失败: ${res.error}`, 'var(--red)');
  }
}

// 从 SQLite 恢复上次捕获的堡垒机资产(重启不丢)。资产只含名称/IP/账号/目录/收藏,不含密码。
async function restoreBastionAssets() {
  try {
    const r = await window.api.bastionLoadAssets();
    if (!r || !r.ok || !r.byUrl) {
      console.log('[堡垒机] restore: 读取失败或空', r && r.error);
      return;
    }
    const urls = Object.keys(r.byUrl);
    if (!urls.length) {
      console.log('[堡垒机] restore: SQLite 里没有堡垒机资产(键:', JSON.stringify(state.bastionUrl), ')');
      return;
    }
    // 多个堡垒机合并展示;键用 origin 归一(旧数据可能是深链接 URL 存的,读回来统一成 origin,
    // 这样 persist 时会写回归一后的键,不再分裂)
    const all = [];
    const seen = new Set(); // 跨 URL 按 devId 去重(S2:同一设备在多个键下重复显示)
    for (const u of urls) {
      const favs = new Set(r.byUrl[u].filter((a) => a.favorite).map((a) => a.devId));
      for (const a of r.byUrl[u]) {
        const key = a.devId || (a.name + a.ip);
        if (seen.has(key)) continue;
        seen.add(key);
        // 恢复时清洗历史脏 favGroup("undefinedxxx" 是早期映射 bug 产物,SQLite 里可能还有),
        // 否则重启后首次渲染收藏区会带垃圾分组名;干净的分组正常保留
        const fg = (a.favGroup && a.favGroup.indexOf('undefined') !== 0) ? a.favGroup : undefined;
        all.push({ ...a, favorite: favs.has(a.devId) || !!a.favorite, favGroup: fg });
      }
      if (!state.bastionUrl) state.bastionUrl = bastionOrigin(u) || u;
    }
    if (all.length && stableJson(all) !== stableJson(state.bastionAssets)) {
      // 恢复资产 → H3C 区块默认折叠(左侧分组收起,展开才看)
      state.bastionCollapsed = true;
      state.bastionDirsInit = false; // 目录分组待首次渲染时默认折叠
      state.bastionAssets = all;
      for (const a of all) if (a.favorite) state.bastionFavSet.add(a.devId);
      renderSessionList(els.inputSessionSearch.value);
      console.log('[堡垒机] 已从本地恢复资产:', all.length);
    }
  } catch (e) { console.log('[堡垒机] 恢复资产失败:', e && e.message); }
}

// ---------- 最近连接(一键重连) ----------
function loadRecent() {
  try { state.recent = JSON.parse(localStorage.getItem('polaris.recent')) || []; } catch { state.recent = []; }
}
function saveRecent() {
  try { localStorage.setItem('polaris.recent', JSON.stringify(state.recent)); } catch { /* ignore */ }
}
// 每次连上一个会话,把它记到"最近连接"最前面(去重,最多 8 条)
function recordRecent(sessionId) {
  const t = state.tabs.get(sessionId);
  if (!t || !t.session || !t.session.id) return;
  state.recent = state.recent.filter((r) => r.id !== t.session.id);
  state.recent.unshift({ id: t.session.id, time: Date.now() });
  if (state.recent.length > 8) state.recent.length = 8;
  saveRecent();
}

// 导出会话:选中分组→导该分组(含子分组);否则 勾选 > 搜索 > 全部(与选择逻辑同步)
async function exportSessions() {
  const checked = selectedSessions(); // 复选框勾选的会话
  const filter = (els.inputSessionSearch.value || '').trim();
  let rows, label;
  if (state.activeGroupId != null) {
    const ids = new Set(collectGroupAndDescendants(Number(state.activeGroupId)));
    rows = state.sessions.filter((s) => ids.has(Number(s.group_id)));
    const g = state.groups.find((x) => Number(x.id) === Number(state.activeGroupId));
    label = `分组「${g ? g.name : ''}」(含子分组)共 ${rows.length} 台`;
  } else if (checked.length) {
    rows = checked;
    label = `勾选的 ${rows.length} 台主机`;
  } else if (filter) {
    rows = filterSessions(filter);
    label = `搜索「${filter}」的结果 ${rows.length} 台`;
  } else {
    rows = state.sessions;
    label = `全部会话 ${rows.length} 台`;
  }
  if (!rows.length) { alert('没有可导出的会话'); return; }
  if (!confirm(`将导出 ${label} 到加密备份文件(.polaris)。\n\n🔒 文件会用你设置的密码 AES 加密,密码不再明文落盘。\n\n继续?`)) return;
  const data = rows.map((s) => ({
    name: s.name, host: s.host, port: s.port, username: s.username,
    password: s.password || '', group: s.group_name || '默认分组',
  }));
  promptFilePwd('set', { type: 'export', data }); // 设导出密码 → 加密导出
}

// 导出指定分组的全部会话(分组右键菜单"导出此分组")
async function exportGroup(gid, groupName) {
  const ids = new Set(collectGroupAndDescendants(Number(gid)));
  const rows = state.sessions.filter((s) => ids.has(Number(s.group_id)));
  if (!rows.length) { alert(`分组「${groupName}」没有会话可导出`); return; }
  if (!confirm(`将导出分组「${groupName}」的 ${rows.length} 个会话到加密备份。\n\n🔒 文件会用你设置的密码 AES 加密。\n\n继续?`)) return;
  const data = rows.map((s) => ({
    name: s.name, host: s.host, port: s.port, username: s.username,
    password: s.password || '', group: groupName || '默认分组',
  }));
  promptFilePwd('set', { type: 'export', data });
}

// 搜索词是完整 IP 地址(4 段点分十进制)→ 对主机 IP 精确匹配,避免子串误伤(搜 1.10 命中 1.100)
function termIsFullIp(t) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(t);
}

// 堡垒机资产搜索:空格分隔多关键词(如多个 IP/名称),命中任意一个就显示
// 与 filterSessions 语义一致 —— 之前 JMS/H3C 用整体 includes(),空格分隔的多 IP 搜不出来
function bastionAssetMatch(a, filter) {
  const terms = (filter || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  // 资产 IP:JMS 资产用 address 字段(无 ip),H3C 资产用 ip 字段——两者都要搜,否则 JMS 按 IP 搜不到
  const ip = (a.ip || a.address || '').toLowerCase();
  // 账号:JMS 是 [{username}],H3C 是字符串数组,统一提取 username 再匹配
  const accts = (a.accounts || []).map((x) => (typeof x === 'string' ? x : (x && x.username) || '')).filter(Boolean).join(' ');
  const hay = (a.name + ' ' + ip + ' ' + accts).toLowerCase();
  return terms.some((t) => termIsFullIp(t) ? ip === t : hay.includes(t));
}

// 按关键词过滤会话(搜索框):空格分隔多关键词,命中任意一个就显示
function filterSessions(filter) {
  const terms = (filter || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return state.sessions;
  return state.sessions.filter((s) => {
    const hay = `${s.name} ${s.host} ${s.username}`.toLowerCase();
    return terms.some((t) => termIsFullIp(t) ? s.host.toLowerCase() === t : hay.includes(t));
  });
}

// 按视图渲染会话列表:树形(tree)/列表(list)/网格(grid)
// 顶层分成两个分组:「🖥 主机」(所有普通会话分组)+「🛡 堡垒机」(JMS/H3C 资产)
function renderSessionList(filter) {
  els.sessionTree.innerHTML = '';
  const f = (filter || '').toLowerCase();
  const sessions = filterSessions(filter);

  // ---- 虚拟顶级分组头:主机 / 堡垒机 ----
  // 注意:这是 UI 分类容器,不写入 groups 数据库(避免污染真实分组/全选逻辑)
  const topCollapsed = { host: state.collapsedTopHost, bastion: state.collapsedTopBastion };
  const mkTopHead = (label, which) => {
    const head = document.createElement('div');
    head.className = 'asset-group-head top-group';
    const caret = document.createElement('span');
    caret.className = 'asset-group-caret';
    caret.textContent = topCollapsed[which] ? '▶' : '▼';
    const name = document.createElement('span');
    name.className = 'asset-group-name';
    name.textContent = label;
    head.appendChild(caret);
    head.appendChild(name);
    head.addEventListener('click', () => {
      if (which === 'host') state.collapsedTopHost = !state.collapsedTopHost;
      else state.collapsedTopBastion = !state.collapsedTopBastion;
      renderSessionList(els.inputSessionSearch.value);
    });
    // 顶级分组右键:主机分组 → 创建主机会话;堡垒机分组 → 创建堡垒机连接
    head.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const items = which === 'host'
        ? [
            { label: '➕ 创建主机会话', action: () => openSessionModal(null) },
            { label: '📁 新建分组', action: () => newGroup(null) },
          ]
        : [
            { label: '➕ 创建堡垒机连接', action: () => { openBastionCfg(); els.bastionCfgUrl.focus(); } },
            { label: '🛡 JumpServer(API 对接)', action: openJmsModal },
            { label: '🌐 JumpServer Web 界面', action: openJmsWeb },
            { separator: true },
            { label: '🌐 H3C(浏览器登录)', action: openBastionPanel },
            { separator: true },
            { label: '🧹 清除堡垒机历史', action: () => els.bastionClear.click() },
          ];
      showCtxMenu(e.clientX, e.clientY, items);
    });
    return head;
  };

  // ---- 🖥 主机分组 ----
  if (state.searchScope !== 'bastion') {
    const hostContainer = document.createElement('div');
    hostContainer.className = 'top-group-container';
    els.sessionTree.appendChild(mkTopHead('🖥 主机', 'host'));
    if (!topCollapsed.host) {
      if (sessions.length === 0) {
        // 无普通会话:主机分组下提示
        const empty = document.createElement('div');
        empty.className = 'asset-group';
        empty.textContent = f ? '没有匹配的会话' : '还没有会话,点右上角"＋ 新建"';
        hostContainer.appendChild(empty);
      } else {
        const view = state.settings.sessionView || 'tree';
        if (view === 'grid') renderSessionsGrid(sessions, hostContainer);
        else if (view === 'list') renderSessionsList(sessions, hostContainer);
        else renderSessionsTree(sessions, hostContainer);
      }
      els.sessionTree.appendChild(hostContainer);
    }
  }

  // ---- 🛡 堡垒机分组 ----
  if (state.searchScope !== 'host') {
    els.sessionTree.appendChild(mkTopHead('🛡 堡垒机', 'bastion'));
    if (!topCollapsed.bastion) {
      const bastionContainer = document.createElement('div');
      bastionContainer.className = 'top-group-container';
      // 已保存的堡垒机连接(配置弹窗创建)最前;JMS/H3C 资产随后。各渲染块 try/catch 隔离。
      try { renderBastionSavedSessions(bastionContainer, f); } catch (e) { console.warn('[堡垒机] 已保存连接渲染异常:', e); }
      try { renderJmsInSessionList(bastionContainer, f); } catch (e) { console.warn('[堡垒机] JMS 区块渲染异常:', e); }
      try { renderBastionInSessionList(bastionContainer, f); } catch (e) { console.warn('[堡垒机] H3C 区块渲染异常:', e); }
      els.sessionTree.appendChild(bastionContainer);
    }
  }
  refreshSelectAllBtn(); // 搜索词/勾选变化都同步"全选/取消全选"按钮文案
}

// 按分组归类:Map<分组名, 会话数组>
function groupSessions(sessions) {
  const groups = new Map();
  for (const s of sessions) {
    const key = s.group_name || '默认分组';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  return groups;
}

// 建一个会话行(名称 + 悬停地址;拖拽/双击/右键)
function makeSessionRow(s) {
  const item = document.createElement('div');
  const prod = isSessionProd(s); // 生产分组会话:红色警示
  const isTelnet = (s.protocol || 'ssh') === 'telnet';
  item.className = 'asset-item' + (prod ? ' prod' : '');
  item.title = `${s.name}\n${s.username}@${s.host}:${s.port}${prod ? '\n🔴 生产环境!' : ''}`;
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'asset-check';
  check.checked = state.selectedForBatch.has(s.id);
  if (isTelnet) { check.disabled = true; check.title = 'Telnet 会话不支持批量执行/SFTP(仅 SSH)'; }
  check.addEventListener('change', () => {
    if (check.checked) state.selectedForBatch.add(s.id);
    else state.selectedForBatch.delete(s.id);
    updateBatchBar();
  });
  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.textContent = isTelnet ? '🔧' : '🖥';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = s.name;
  item.appendChild(check);
  item.appendChild(icon);
  item.appendChild(name);
  if (isTelnet) {
    const badge = document.createElement('span');
    badge.className = 'proto-badge';
    badge.textContent = 'TEL';
    item.appendChild(badge);
  }

  // 点会话行 = 用户改在操作会话:已打开的切到对应标签(SFTP 跟着走);
  // 没打开的 → 下方收起 SFTP(没有连接,不显示文件面板)。勾选框点击只做批量勾选,不切换。
  item.addEventListener('click', (e) => {
    if (e.target === check) return;
    if (state.activeGroupId != null) {
      state.activeGroupId = null;
      renderSessionList(els.inputSessionSearch.value);
    }
    const openTab = findTabBySessionId(s.id);
    if (openTab) {
      activateTab(openTab.sessionId); // 会应用该标签自己的 SFTP 状态
    }
    // 点未打开的会话:不关闭当前标签的 SFTP(各标签 SFTP 独立,互不影响)
  });

  item.draggable = true;
  item.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', String(s.id));
    e.dataTransfer.effectAllowed = 'move';
    item.classList.add('dragging');
  });
  item.addEventListener('dragend', () => item.classList.remove('dragging'));
  item.addEventListener('dblclick', () => connectToServer(s));
  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showCtxMenu(e.clientX, e.clientY, [
      { label: '✏️ 编辑', action: () => openSessionModal(s) },
      { label: '📋 克隆', action: () => cloneSession(s) },
      { label: '🗑 删除', danger: true, action: () => removeSession(s.id) },
    ]);
  });
  return item;
}

// 树形视图:分组 = 可折叠文件夹(所有连接都挂在某个分组下,无"未分组"概念)
// 找某分组的"顶级祖先"分组 id(沿 parent_id 一直往上;孤儿返回 null)
function topLevelGroupId(gid) {
  let g = state.groups.find((x) => Number(x.id) === Number(gid));
  if (!g) return null;
  while (g.parent_id != null) {
    const parent = state.groups.find((p) => Number(p.id) === Number(g.parent_id));
    if (!parent) break;
    g = parent;
  }
  return Number(g.id);
}
// 收集某分组及其全部后代分组的 id(全选/导出/删除联动用)
function collectGroupAndDescendants(gid) {
  const out = [Number(gid)];
  for (const g of state.groups) {
    if (Number(g.parent_id) === Number(gid)) out.push(...collectGroupAndDescendants(g.id));
  }
  return out;
}

// 渲染一个分组头(支持缩进);depth 越深缩进越多
function makeGroupHead(g, depth, collapsed) {
  const gid = g.id;
  const isProd = !!g.is_prod;
  const directCount = state.sessions.filter((s) => Number(s.group_id) === Number(gid)).length;
  const head = document.createElement('div');
  head.className = 'asset-group-head' + (isProd ? ' prod' : '');
  head.style.paddingLeft = `${8 + depth * 18}px`;
  const caret = document.createElement('span');
  caret.className = 'asset-group-caret';
  caret.textContent = collapsed ? '▶' : '▼';
  const gname = document.createElement('span');
  gname.className = 'asset-group-name';
  gname.textContent = g.name + (isProd ? ' 🔴' : '');
  const gcount = document.createElement('span');
  gcount.className = 'asset-group-count';
  gcount.textContent = `(${directCount})`;
  head.appendChild(caret);
  head.appendChild(gname);
  head.appendChild(gcount);
  // 小三角:折叠/展开,同时把该组设为"全选"目标(用户点开分组=想操作这组)
  caret.addEventListener('click', (e) => {
    e.stopPropagation();
    if (collapsed) state.collapsedGroups.delete(gid);
    else state.collapsedGroups.add(gid);
    state.activeGroupId = gid;
    renderSessionList(els.inputSessionSearch.value);
  });
  // 点分组头(除小三角):选中该组作为"全选"目标(并展开它),再点一次取消选中
  head.addEventListener('click', () => {
    state.activeGroupId = (state.activeGroupId === gid) ? null : gid;
    state.collapsedGroups.delete(gid);
    scopeSelectionToTarget(); // 选中分组后:清除其他分组的勾选
    renderSessionList(els.inputSessionSearch.value);
  });
  head.classList.toggle('active-group', Number(state.activeGroupId) === Number(gid));
  head.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showCtxMenu(e.clientX, e.clientY, [
      { label: '➕ 创建主机会话', action: () => openSessionModal(null, gid) },
      { label: '✏️ 重命名分组', action: () => renameGroup(gid, g.name) },
      { label: '📁 新建子分组', action: () => newGroup(gid) },
      { label: isProd ? '🔴 取消生产标记' : '🚨 标记为生产环境', action: () => toggleGroupProd(gid, g.name) },
      { label: '📤 导出此分组', action: () => exportGroup(gid, g.name) },
      { label: '🗑 删除分组', danger: true, action: () => deleteGroup(gid, g.name) },
    ]);
  });
  head.dataset.groupId = gid;
  head.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; head.classList.add('drag-over'); });
  head.addEventListener('dragleave', () => head.classList.remove('drag-over'));
  head.addEventListener('drop', (e) => {
    e.preventDefault();
    head.classList.remove('drag-over');
    const sid = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (sid && gid) moveSessionToGroup(sid, gid);
  });
  return head;
}

// 树形视图:支持分组嵌套(子分组缩进显示),父折叠时整棵子树隐藏
function renderSessionsTree(sessions, container) {
  // 最近连接:只在未搜索时显示在列表最顶部,点击/双击可一键重连
  if (!(els.inputSessionSearch.value || '').trim()) {
    const recentSessions = state.recent
      .map((r) => state.sessions.find((s) => s.id === r.id))
      .filter(Boolean);
    if (recentSessions.length) {
      const head = document.createElement('div');
      head.className = 'asset-group-head';
      const caret = document.createElement('span');
      caret.className = 'asset-group-caret';
      caret.textContent = state.recentCollapsed ? '▶' : '▼';
      const label = document.createElement('span');
      label.className = 'asset-group-name';
      label.textContent = '🕘 最近连接';
      head.appendChild(caret);
      head.appendChild(label);
      // 点三角或整行:折叠/展开"最近连接"(和普通分组的三角行为一致)
      const toggleRecent = (e) => {
        e.stopPropagation();
        state.recentCollapsed = !state.recentCollapsed;
        renderSessionList(els.inputSessionSearch.value);
      };
      caret.addEventListener('click', toggleRecent);
      head.addEventListener('click', toggleRecent);
      container.appendChild(head);
      if (!state.recentCollapsed) {
        for (const s of recentSessions) {
          const r = makeSessionRow(s);
          r.classList.add('host-item'); // 紧凑小条:左侧竖线分隔+右侧留白+宽度贴合主机名
          container.appendChild(r);
        }
      }
    }
  }
  // 构建分组层级(按 parent_id)
  const childrenOf = new Map(); // parent_id → [group]
  const ids = new Set(state.groups.map((g) => g.id));
  for (const g of state.groups) {
    const pid = g.parent_id && ids.has(g.parent_id) ? g.parent_id : null;
    if (!childrenOf.has(pid)) childrenOf.set(pid, []);
    childrenOf.get(pid).push(g);
  }
  // 按分组收纳会话
  const sessByGroup = new Map();
  for (const s of sessions) {
    if (!sessByGroup.has(s.group_id)) sessByGroup.set(s.group_id, []);
    sessByGroup.get(s.group_id).push(s);
  }
  // 递归渲染:父折叠 → 跳过整棵子树
  const renderNode = (g, depth) => {
    const collapsed = state.collapsedGroups.has(g.id);
    container.appendChild(makeGroupHead(g, depth, collapsed));
    if (collapsed) return;
    for (const child of childrenOf.get(g.id) || []) renderNode(child, depth + 1);
    for (const s of sessByGroup.get(g.id) || []) {
      const row = makeSessionRow(s);
      row.classList.add('host-item'); // 紧凑小条:左侧竖线分隔+右侧留白+宽度贴合主机名
      row.style.paddingLeft = `${24 + depth * 18}px`;
      container.appendChild(row);
    }
  };
  for (const g of childrenOf.get(null) || []) renderNode(g, 0);
}

// 列表视图:分组作为节标题(不折叠),会话平铺
function renderSessionsList(sessions, container) {
  const groups = groupSessions(sessions);
  // 没在搜索时,把空分组也显示出来
  if (!(els.inputSessionSearch.value || '').trim()) {
    for (const g of state.groups) {
      if (!groups.has(g.name)) groups.set(g.name, []);
    }
  }
  for (const [groupName, list] of groups) {
    const g = state.groups.find((x) => x.name === groupName);
    const isProd = !!(g && g.is_prod);
    const head = document.createElement('div');
    head.className = 'asset-group-head list-head' + (isProd ? ' prod' : '');
    head.textContent = `${groupName}${isProd ? ' 🔴' : ''} (${list.length})`;
    // 仍是拖拽投放目标
    head.dataset.groupId = (state.groups.find((g) => g.name === groupName) || {}).id || groupName;
    head.addEventListener('dragover', (e) => { e.preventDefault(); head.classList.add('drag-over'); });
    head.addEventListener('dragleave', () => head.classList.remove('drag-over'));
    head.addEventListener('drop', (e) => {
      e.preventDefault();
      head.classList.remove('drag-over');
      const sid = parseInt(e.dataTransfer.getData('text/plain'), 10);
      const gid = head.dataset.groupId;
      if (sid && gid) moveSessionToGroup(sid, gid);
    });
    // 列表视图分组头:点击选中该分组作为"全选"目标(再点取消)
    head.addEventListener('click', () => {
      const gid = Number(head.dataset.groupId) || head.dataset.groupId; // dataset 是字符串,转回数字
      if (gid) {
        state.activeGroupId = (state.activeGroupId === gid) ? null : gid;
        renderSessionList(els.inputSessionSearch.value);
      }
    });
    head.classList.toggle('active-group', state.activeGroupId === Number(head.dataset.groupId) || state.activeGroupId === head.dataset.groupId);
    container.appendChild(head);
    for (const s of list) {
      const r = makeSessionRow(s);
      r.classList.add('host-item'); // 列表视图同样用紧凑小条(左侧竖线分隔+右侧留白)
      container.appendChild(r);
    }
  }
}

// 网格视图:会话卡片
function renderSessionsGrid(sessions, container) {
  const wrap = document.createElement('div');
  wrap.className = 'session-grid';
  for (const s of sessions) {
    const card = document.createElement('div');
    card.className = 'session-card';
    card.dataset.sessionId = s.id; // 标签右键"定位到会话列表"靠它找到卡片
    const isTelnet = (s.protocol || 'ssh') === 'telnet';
    card.title = `${s.name}\n${s.username}@${s.host}:${s.port}${isTelnet ? '\n(Telnet)' : ''}`;
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'card-check';
    check.checked = state.selectedForBatch.has(s.id);
    if (isTelnet) { check.disabled = true; check.title = 'Telnet 会话不支持批量执行/SFTP(仅 SSH)'; }
    check.addEventListener('change', () => {
      if (check.checked) state.selectedForBatch.add(s.id);
      else state.selectedForBatch.delete(s.id);
      updateBatchBar();
    });
    const icon = document.createElement('div');
    icon.className = 'card-icon';
    icon.textContent = isTelnet ? '🔧' : '🖥';
    const name = document.createElement('div');
    name.className = 'card-name';
    name.textContent = s.name;
    const addr = document.createElement('div');
    addr.className = 'card-addr dim';
    addr.textContent = `${isTelnet ? 'telnet' : s.username}@${s.host}`;
    card.appendChild(check);
    card.appendChild(icon);
    card.appendChild(name);
    card.appendChild(addr);
    card.addEventListener('dblclick', () => connectToServer(s));
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, [
        { label: '✏️ 编辑', action: () => openSessionModal(s) },
        { label: '📋 克隆', action: () => cloneSession(s) },
        { label: '🗑 删除', danger: true, action: () => removeSession(s.id) },
      ]);
    });
    wrap.appendChild(card);
  }
  container.appendChild(wrap);
}

// 切换会话列表视图(网格/列表/树形)
function setSessionView(view) {
  state.settings.sessionView = view;
  saveSettings();
  syncViewButtons();
  renderSessionList(els.inputSessionSearch.value);
}
function syncViewButtons() {
  const v = state.settings.sessionView || 'tree';
  els.vsGrid.classList.toggle('active', v === 'grid');
  els.vsList.classList.toggle('active', v === 'list');
  els.vsTree.classList.toggle('active', v === 'tree');
}

// =====================================================================
// 会话多选 + 批量操作(连接/关闭/SFTP上传下载)
// =====================================================================
function updateBatchBar() {
  const n = state.selectedForBatch.size;
  els.batchBar.classList.toggle('hidden', n === 0);
  els.batchCount.textContent = `已选 ${n} 台`;
  refreshSelectAllBtn(); // 勾选变化时同步"全选/取消全选"按钮文案
}

// 刷新搜索行"全选"按钮:当前搜索结果全被勾选 → 显示"取消全选",否则显示"全选"
// 计算"全选"的目标会话:有搜索词按搜索结果;没搜索且选中了某个分组 → 只针对该组;否则全部
function selectAllTarget() {
  const f = (els.inputSessionSearch.value || '').trim();
  if (f) return filterSessions(f);
  if (state.activeGroupId != null) {
    // 选中分组 → 含它及全部子分组的会话(Number() 兜底防类型错乱)
    const ids = new Set(collectGroupAndDescendants(Number(state.activeGroupId)));
    return state.sessions.filter((s) => ids.has(Number(s.group_id)));
  }
  return state.sessions;
}

function refreshSelectAllBtn() {
  const target = selectAllTarget();
  if (target.length === 0) {
    els.btnSelectAllFiltered.textContent = '全选';
    els.btnSelectAllFiltered.classList.remove('active');
    return;
  }
  const all = target.every((s) => state.selectedForBatch.has(s.id));
  // 选中了分组 → 按钮文案提示作用范围
  const isGroup = state.activeGroupId != null;
  els.btnSelectAllFiltered.textContent = isGroup ? (all ? '取消本组全选' : '全选本组') : (all ? '取消全选' : '全选');
  els.btnSelectAllFiltered.classList.toggle('active', all);
}

// 选中某分组/未分组后:清除"其他分组"里已勾选的主机(选择只针对当前目标)
function scopeSelectionToTarget() {
  if (state.activeGroupId == null) return;
  const targetIds = new Set(selectAllTarget().map((s) => s.id));
  for (const id of [...state.selectedForBatch]) {
    if (!targetIds.has(id)) state.selectedForBatch.delete(id);
  }
  updateBatchBar();
}

// 点"全选":把目标会话全部勾选;再点一次取消
function toggleSelectAllFiltered() {
  const target = selectAllTarget();
  if (target.length === 0) return;
  const allSelected = target.every((s) => state.selectedForBatch.has(s.id));
  if (allSelected) {
    for (const s of target) state.selectedForBatch.delete(s.id);
  } else {
    for (const s of target) state.selectedForBatch.add(s.id);
  }
  updateBatchBar();
  renderSessionList(els.inputSessionSearch.value); // 重绘刷新勾选框和按钮
}
function selectedSessions() {
  return [...state.selectedForBatch]
    .map((id) => state.sessions.find((s) => s.id === id))
    .filter(Boolean);
}
// 按数据库会话 id 找已打开的标签
function findTabBySessionId(dbId) {
  for (const t of state.tabs.values()) {
    if (t.session && t.session.id === dbId) return t;
  }
  return null;
}

// 保存当前打开的会话 id(用于下次启动恢复)
function saveRestoreList() {
  state.settings.restoreSessions = [...state.tabs.values()]
    .map((t) => t.session && t.session.id)
    .filter(Boolean);
  saveSettings();
}

// 启动时恢复上次打开的会话(自动重连)
function restoreSessions() {
  if (state.settings.restoreOnStartup === false) return;
  for (const id of state.settings.restoreSessions || []) {
    const s = state.sessions.find((x) => x.id === id);
    if (s && !findTabBySessionId(id)) connectToServer(s);
  }
}
function batchClear() {
  state.selectedForBatch.clear();
  updateBatchBar();
  renderSessionList(els.inputSessionSearch.value);
}

// 批量连接:打开所有选中的、尚未打开的会话
function batchConnect() {
  for (const s of selectedSessions()) {
    if (!findTabBySessionId(s.id)) connectToServer(s);
  }
  batchClear();
}

// 批量关闭:关闭选中会话里已打开的终端
function batchClose() {
  for (const id of [...state.selectedForBatch]) {
    const t = findTabBySessionId(id);
    if (t) closeTab(t.sessionId);
  }
  batchClear();
}

// 菜单「连接选中会话」:连接勾选的会话;若没勾选但当前标签已断开,则重新连接它
function menuConnect() {
  const list = selectedSessions();
  if (list.length) { for (const s of list) if (!findTabBySessionId(s.id)) connectToServer(s); batchClear(); return; }
  const active = state.tabs.get(state.activeSessionId);
  if (active && active.session && active.status !== 'connected' && active.status !== 'connecting') {
    reconnectTab(state.activeSessionId);
    return;
  }
  alert('请先勾选要连接的会话(可点搜索框旁「全选」)');
}

// 菜单「断开当前终端」:断开当前激活标签的连接但保留标签(可重新连接);无激活则断开勾选里已连接的
function menuDisconnect() {
  const activeId = state.activeSessionId;
  if (activeId && state.tabs.get(activeId)) { disconnectTab(activeId); return; }
  const checked = [...state.selectedForBatch];
  let done = 0;
  for (const id of checked) {
    const t = findTabBySessionId(id);
    if (t) { disconnectTab(t.sessionId); done++; }
  }
  if (!done) alert('当前没有可断开的连接');
}

// 锁定覆盖层(临时锁定):铺满主窗口,保留窗口按钮;会话在底层保持,解锁后原样恢复
function showLockOverlay() {
  els.lockOverlay.classList.remove('hidden');
  // 锁定后窗口收成小卡片(美观),解锁再恢复原尺寸
  if (window.api.lockResize) window.api.lockResize(true).catch(() => {});
  // Windows 上原生菜单栏(文件/编辑/…)在 DOM 之外,覆盖层盖不住,锁定必须显式隐藏
  if (window.api.lockMenu) window.api.lockMenu(false);
  // webview 是原生层,会盖在锁定覆盖层之上(参见 bastion-resize-fix),必须显式隐藏;用 display:none(Windows 上 visibility 不可靠)
  if (els.bastionWebview && els.bastionWebview.style.display !== 'none') els.bastionWebview.style.display = 'none';
  els.loMsg.textContent = '';
  els.loPw.value = '';
  els.loBtn.disabled = false;
  els.loPw.disabled = false;
  els.loPw.focus();
  // 若正处暴力破解锁定,直接进入倒计时
  window.api.lockStatus().then((st) => {
    if (st && st.ok && st.locked) lockOverlayCountdown(st.remainingSec);
  });
}
function hideLockOverlay() {
  els.lockOverlay.classList.add('hidden');
  if (window.api.lockMenu) window.api.lockMenu(true);
  // 解锁后恢复窗口原尺寸/最大化/全屏
  if (window.api.lockResize) window.api.lockResize(false).catch(() => {});
  if (els.bastionWebview && els.bastionWebview.style.display === 'none') {
    els.bastionWebview.style.display = '';
    setTimeout(bastionFitToWidth, 200); // display:none→显示 后重新适配画面宽度
  }
  els.loPw.value = '';
  resetIdleLock(); // 解锁后重新武装闲置自动锁定
}
// 暴力破解锁定倒计时:禁用输入框/按钮,每秒刷新,到 0 恢复
let loCountdownTimer = null;
function lockOverlayCountdown(sec) {
  clearInterval(loCountdownTimer);
  els.loBtn.disabled = true;
  els.loPw.disabled = true;
  let left = Math.max(1, sec);
  els.loMsg.textContent = `尝试次数过多,请 ${left} 秒后再试`;
  loCountdownTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(loCountdownTimer);
      els.loBtn.disabled = false;
      els.loPw.disabled = false;
      els.loMsg.textContent = '';
      els.loPw.focus();
    } else {
      els.loMsg.textContent = `尝试次数过多,请 ${left} 秒后再试`;
    }
  }, 1000);
}
// 提交解锁密码(带防暴力:失败显示剩余次数,锁定显示倒计时)
async function submitLock() {
  const p = els.loPw.value;
  if (!p) { els.loMsg.textContent = '请输入密码'; return; }
  const v = await window.api.lockVerify(p);
  if (!v.ok) {
    if (v.locked) lockOverlayCountdown(v.remainingSec);
    else els.loMsg.textContent = `密码错误,还剩 ${v.attemptsLeft} 次机会`;
    els.loPw.value = '';
    els.loPw.focus();
    return;
  }
  hideLockOverlay();
}

// 菜单/工具栏「锁定」:临时锁定(需已设置 App 密码)
function requestLock() {
  window.api.lockHas().then((r) => {
    if (!r || !r.ok || !r.has) { alert('请先在设置 → 安全 里设置 App 密码'); return; }
    showLockOverlay();
  });
}

// 连接/断开二合一按钮:跟随"当前激活标签"的状态
//   激活标签已连接 → 断开它(保留标签);激活标签已断开 → 重新连接它;无激活标签 → 连接勾选会话
function toggleConnectDisconnect() {
  const t = state.tabs.get(state.activeSessionId);
  if (t) {
    if (t.status === 'connecting') return; // 连接中:不可操作,避免"断开无效"的竞态
    if (t.status === 'connected') { disconnectTab(t.sessionId); return; }
    if (t.session) { reconnectTab(t.sessionId); return; } // 已断开 → 重新连接
  }
  menuConnect(); // 无激活标签 → 连接勾选会话
}
// 刷新二合一按钮的状态:按"当前激活标签"判断
// 高亮规则:有激活标签 → 按钮常亮;文字随状态:已连接→"断开"、连接中→"连接中…"、已断开→"连接"。
//           无激活标签 → 不亮,显示"连接"(连接勾选会话)
function updateConnectBtn() {
  const t = state.tabs.get(state.activeSessionId);
  const st = t ? t.status : null;
  els.btnConnect.classList.toggle('active', !!t);
  if (st === 'connecting') {
    els.btnConnect.textContent = '连接中…';
    els.btnConnect.title = '正在连接…';
  } else if (st === 'connected') {
    els.btnConnect.textContent = '断开';
    els.btnConnect.title = '断开当前终端(标签保留,可重新连接) (⌘Enter)';
  } else {
    els.btnConnect.textContent = '连接';
    els.btnConnect.title = (t && t.session ? '重新连接当前终端' : '连接选中会话') + ' (⌘Enter)';
  }
}

// ---- 闲置自动锁定:一段时间无操作(鼠标/键盘/滚轮)自动锁定;设置分钟数=0 则关闭 ----
let idleLockTimer = null;
function resetIdleLock() {
  clearTimeout(idleLockTimer);
  if (!els.lockOverlay.classList.contains('hidden')) return; // 已锁定,不重复计时
  const min = Number(state.settings.lockIdleMin) || 0;
  if (min <= 0) return;
  idleLockTimer = setTimeout(maybeAutoLock, min * 60 * 1000);
}
// 闲置到点:有密码则弹锁定覆盖层,没设密码就继续计时(不打扰)
async function maybeAutoLock() {
  const r = await window.api.lockHas();
  if (!r || !r.ok || !r.has) { resetIdleLock(); return; }
  showLockOverlay();
}
// capture=true 确保 xterm 内部按键/点击也能重置计时
['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach((ev) =>
  document.addEventListener(ev, resetIdleLock, { capture: true, passive: true })
);
// 窗口重新获得焦点(如解锁恢复后)重新计时,保证坐下不动也会再锁定
window.addEventListener('focus', resetIdleLock);

// 批量删除选中会话:一次密码验证后全部删除
async function batchDelete() {
  const list = selectedSessions();
  if (!list.length) return;
  // 安全门槛(与"删分组一次只能删一个顶级分组"一致):
  // 选中的主机若横跨多个顶级分组 → 拒绝,防止"全选所有分组→一次删光"
  const topLevels = new Set();
  for (const s of list) topLevels.add(topLevelGroupId(Number(s.group_id)));
  if (topLevels.size > 1) {
    alert('⚠️ 选中的主机横跨多个顶级分组,为安全起见,请逐个分组删除。');
    return;
  }
  requirePassword(
    `确定删除选中的 ${list.length} 个主机吗?此操作不可恢复,需要验证 App 密码。`,
    async () => {
      for (const s of list) {
        const res = await window.api.removeSession(s.id);
        if (!res.ok) alert(`删除「${s.name}」失败: ${res.error}`);
      }
      batchClear();
      loadSessions();
    }
  );
}

// 批量上传:选一个本地文件,传到每个选中主机的远程目录
function batchUpload() {
  const list = selectedSessions();
  if (!list.length) return;
  showPrompt({
    title: '批量上传', label: '远程目录(每台主机同一目录,如 /tmp)', value: '/tmp',
    onOk: async (remoteDir) => {
      if (!remoteDir) return;
      const res = await window.api.sftpBatchUpload(list, remoteDir);
      showBatchResult(res, '上传');
    },
  });
}

// 批量下载:从每个选中主机下载同一远程文件到本地文件夹(按主机名命名)
function batchDownload() {
  const list = selectedSessions();
  if (!list.length) return;
  showPrompt({
    title: '批量下载', label: '远程文件路径(每台主机同一路径,如 /var/log/syslog)', value: '',
    onOk: async (remotePath) => {
      if (!remotePath) return;
      const res = await window.api.sftpBatchDownload(list, remotePath);
      showBatchResult(res, '下载');
    },
  });
}

function showBatchResult(res, label) {
  if (!res || res.canceled) return;
  if (!res.ok) { alert(`${label}失败: ${res.error}`); return; }
  const ok = res.results.filter((r) => r.ok).length;
  const fail = res.results.filter((r) => !r.ok);
  let msg = `${label}完成:成功 ${ok} 台,失败 ${fail.length} 台`;
  if (fail.length) msg += `\n\n${fail.map((r) => `❌ ${r.name}: ${r.error}`).join('\n')}`;
  if (label === '下载') msg += '\n\n文件保存在所选文件夹,按 主机名_文件名 命名';
  alert(msg);
  batchClear();
}

// 右键菜单:动态填充菜单项(会话的 编辑/删除,分组的 重命名/删除,标签的 关闭/复制/重命名…)
// items 每项: { label, action, danger? } 或 { separator: true } 分隔线
let ctxMenuOpenedAt = 0; // 菜单最近打开时间:用于忽略"右键后紧跟的残留 click"
function showCtxMenu(x, y, items) {
  ctxMenuOpenedAt = Date.now(); // 记录打开时刻
  els.ctxMenu.innerHTML = '';
  for (const it of items) {
    if (it.separator) {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      els.ctxMenu.appendChild(sep);
      continue;
    }
    if (it.separatorLabel) {
      // 分组小标题(如"🎨 标记颜色"):纯展示,不响应点击、不收起菜单
      const lbl = document.createElement('div');
      lbl.className = 'ctx-sep-label';
      lbl.textContent = it.label;
      els.ctxMenu.appendChild(lbl);
      continue;
    }
    const div = document.createElement('div');
    div.className = `ctx-item${it.danger ? ' danger' : ''}`;
    div.textContent = it.label;
    // 点菜单项:执行动作并收起菜单。右键(contextmenu)后系统常紧跟一个残留 click,
    // 若菜单第一项正好覆盖右键位置,残留 click 会"点中"菜单项 → 误触发动作 + 菜单一闪而过。
    // 打开后 250ms 内的 click 一律视为残留,忽略(与 window click 防抖一致)。
    div.addEventListener('click', () => {
      if (Date.now() - ctxMenuOpenedAt < 250) return;
      try { it.action(); } catch (e) { console.warn('菜单动作异常:', e); }
      closeCtxMenu('item');
    });
    els.ctxMenu.appendChild(div);
  }
  els.ctxMenu.style.left = `${x}px`;
  els.ctxMenu.style.top = `${y}px`;
  els.ctxMenu.classList.remove('hidden');
  dlog('MENU', `open: ${items.map((i) => (i.separator ? '---' : i.label)).join(' | ')}`);
  // 诊断:排查"菜单一闪而过"(close:blur)时,记录打开瞬间的焦点/面板状态
  const wv = els.bastionWebview;
  dlog('FOCUS', `menu open: hasFocus=${document.hasFocus()} active=${(document.activeElement && (document.activeElement.tagName + (document.activeElement.id ? '#' + document.activeElement.id : ''))) || 'null'} ${wv && wv.executeJavaScript ? ('wv:' + (wv.src ? '有src' : '无src') + (els.bastionSlot.classList.contains('hidden') ? '/隐藏' : '/显示')) : 'wv:无'} menuOpen=true`);
}
function closeCtxMenu(from) {
  // 只在菜单确实开着时记日志:window click/blur 会频繁触发本函数,
  // 若无条件 dlog 会让调试日志被一堆"空关"刷屏(看不到真正的 open/close 配对)
  // from: 记录关闭来源(item=菜单项点击 / click=窗口点击 / blur=窗口失焦),便于排查"一闪而过"
  if (!els.ctxMenu.classList.contains('hidden')) dlog('MENU', `close${from ? ':' + from : ''}`);
  els.ctxMenu.classList.add('hidden');
}

// ---------- 终端调试日志 ----------
// 排查"终端/vim 按键不生效、粘贴后打不出空格"这类问题:常驻记录 按键(含当时焦点)、
// 焦点迁移、收/发数据、连接状态。工具栏「🧾 调试」打开面板;内容可能含敏感输入,排查完请清空。
const termDebug = { lines: [], max: 2000 };
// dlog 批量落盘:攒 500ms 的行一次 IPC 发给主进程写文件(高频 dlog 不逐条 IPC,降低开销)
let dlogFlushTimer = null;
let dlogFlushBuf = [];
function dlogFlushToDisk() {
  if (!dlogFlushBuf.length) return;
  const batch = dlogFlushBuf;
  dlogFlushBuf = [];
  try { if (window.api && window.api.appLogDlog) window.api.appLogDlog(batch); } catch { /* ignore */ }
}
function dlog(kind, msg) {
  const d = new Date();
  const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  const line = `[${ts}] ${kind} ${msg}`;
  termDebug.lines.push(line);
  if (termDebug.lines.length > termDebug.max) termDebug.lines.splice(0, termDebug.lines.length - termDebug.max);
  // 落盘(默认开启):攒批发送,避免高频 dlog 的 IPC 风暴
  try {
    dlogFlushBuf.push(line);
    if (!dlogFlushTimer) dlogFlushTimer = setTimeout(() => { dlogFlushTimer = null; dlogFlushToDisk(); }, 500);
  } catch { /* ignore */ }
  if (els.debugPanel && !els.debugPanel.classList.contains('hidden')) renderDebugBody();
}
function renderDebugBody() {
  if (els.debugBody) { els.debugBody.textContent = termDebug.lines.join('\n'); els.debugBody.scrollTop = els.debugBody.scrollHeight; }
}
// 未捕获异常 / Promise 拒绝 → 也进调试日志(排查 bug 的关键来源;任何时刻都记录,不受面板开关影响)
window.addEventListener('error', (e) => {
  dlog('ERROR', `未捕获异常: ${e.message || e}${e.filename ? ' @ ' + e.filename + ':' + e.lineno : ''}`);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  dlog('ERROR', `未处理Promise拒绝: ${(r && r.message) || String(r)}`);
});
function toggleDebugPanel() {
  const hidden = els.debugPanel.classList.contains('hidden');
  els.debugPanel.classList.toggle('hidden', !hidden);
  els.btnDebug.classList.toggle('active', hidden);
  if (!hidden) {
    positionDebugPanel(); // 打开时放到记忆位置(默认右下角)
    renderDebugBody();
  }
}
// 把调试面板放到记忆位置 / 默认右下角,并钳回可见区域内
function positionDebugPanel() {
  const panel = els.debugPanel;
  if (!panel || panel.classList.contains('hidden')) return;
  const saved = state.settings.debugPanelPos;
  const w = panel.offsetWidth, h = panel.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let x, y;
  if (saved) {
    x = Math.min(Math.max(0, saved.x), Math.max(0, vw - w));
    y = Math.min(Math.max(0, saved.y), Math.max(0, vh - h));
  } else {
    x = Math.max(0, vw - w - 12);
    y = Math.max(0, vh - h - 12);
  }
  panel.style.left = x + 'px';
  panel.style.top = y + 'px';
}
// 调试面板:按住头部可拖动(点按钮不触发),位置记忆到设置;窗口尺寸变化时钳回可见区
function initDebugPanelDrag() {
  const panel = els.debugPanel;
  const head = panel && panel.querySelector('.debug-head');
  if (!head) return;
  head.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return; // 头部按钮不触发拖拽
    const startX = e.clientX, startY = e.clientY;
    const startLeft = panel.offsetLeft, startTop = panel.offsetTop;
    const move = (ev) => {
      const x = Math.min(Math.max(0, startLeft + ev.clientX - startX), Math.max(0, window.innerWidth - panel.offsetWidth));
      const y = Math.min(Math.max(0, startTop + ev.clientY - startY), Math.max(0, window.innerHeight - panel.offsetHeight));
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      state.settings.debugPanelPos = { x: panel.offsetLeft, y: panel.offsetTop };
      saveSettings();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    e.preventDefault();
  });
  window.addEventListener('resize', positionDebugPanel);
}
function termElInfo(el) {
  if (!el) return 'null';
  const tag = el.tagName || '';
  const id = el.id ? `#${el.id}` : '';
  const cls = typeof el.className === 'string' ? el.className.trim() : '';
  return tag + id + (cls ? '.' + cls.split(/\s+/).join('.') : '');
}

// ---------- 全局快捷键:⌘K 命令面板 + 高频面板开关 ----------
// 必须注册在下方 window keydown(2459)之前:该 handler 在 BODY 焦点会把按键转发给终端,
// 新快捷键命中组合时要 stopImmediatePropagation 阻断它,否则 ⌘K 等会被当普通键转发。
// mac 用 Cmd,其他平台用 Ctrl(与 xterm 的 isMac 判断一致)。
const PLATFORM_IS_MAC = navigator.platform.toUpperCase().includes('MAC');
window.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  const mod = PLATFORM_IS_MAC ? e.metaKey : e.ctrlKey;
  if (!mod) return;
  const k = e.key ? e.key.toLowerCase() : '';
  if (k === 'k' && !e.shiftKey && !e.altKey) {
    e.preventDefault(); e.stopImmediatePropagation();
    if (els.palette.classList.contains('hidden')) openPalette(); else closePalette(); // ⌘K 开/关命令面板
    return;
  }
  if (!e.shiftKey || e.altKey) return; // 以下均为 Cmd/Ctrl+Shift+字母
  const runShortcut = (fn) => { closePalette(); fn(); }; // 命令面板开着时按快捷键 = 关面板并执行
  switch (k) {
    case 's': e.preventDefault(); e.stopImmediatePropagation(); runShortcut(toggleSftpPanel); break;
    case 'b': e.preventDefault(); e.stopImmediatePropagation(); runShortcut(toggleBatchPanel); break;
    case 'm': e.preventDefault(); e.stopImmediatePropagation(); runShortcut(toggleCmdPanel); break;
    case 'a': e.preventDefault(); e.stopImmediatePropagation(); runShortcut(toggleAiPanel); break;
    case 't': e.preventDefault(); e.stopImmediatePropagation(); runShortcut(openTunnelModal); break;
    case 'd': e.preventDefault(); e.stopImmediatePropagation(); runShortcut(toggleDebugPanel); break;
    case 'f': e.preventDefault(); e.stopImmediatePropagation(); runShortcut(openFilterModal); break;
  }
}, true);

// 按键捕获:记录"按键 + 此刻焦点",区分按键正常送达终端(xterm textarea)还是被吞(焦点在 BODY/菜单)。
// 同时兜底:BODY 焦点(点面板空白/滚动/切面板后焦点被顶掉)时,把按键转发给当前活跃终端,
// 而不是吞掉 —— 否则"点一下 SFTP 面板空白 → 回终端敲 Cmd+A/普通键"会全部失效。
window.addEventListener('keydown', (e) => {
  if (!state.tabs || !state.tabs.size) return;
  const k = e.key;
  if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta' || k === 'CapsLock' || k === 'Escape') return;
  const ae = document.activeElement;
  const cls = ae && typeof ae.className === 'string' ? ae.className : '';
  const inTerm = !!cls && cls.indexOf('xterm-helper-textarea') >= 0;
  const isBody = ae === document.body;
  const onMenu = !!cls && cls.indexOf('ctx-menu') >= 0;
  if (!inTerm && !isBody && !onMenu) return; // 焦点在普通输入框/按钮等 UI 上,与终端无关,不记
  const mod = (e.ctrlKey ? '^' : '') + (e.altKey ? '⌥' : '') + (e.metaKey ? '⌘' : '') + (e.shiftKey ? '⇧' : '');
  const key = k.length === 1 ? (k === ' ' ? '␣' : k) : k;
  if (isBody) {
    // BODY 焦点兜底:把键盘焦点还给当前活跃终端,并阻止默认行为,让按键真正进终端。
    // Cmd+A(全选)在 BODY 上会被浏览器当"全选页面"吞掉,这里显式交给 xterm。
    const t = state.activeSessionId ? state.tabs.get(state.activeSessionId) : null;
    if (t && t.term && !onMenu) {
      e.preventDefault();
      try {
        t.term.focus();
        // 焦点刚还回 textarea,当前这次 keydown 不会再派发第二次(它已到 window 捕获层),
        // 需要把按键喂给 xterm:合成 KeyboardEvent dispatch 到 textarea(xterm 5 接受合成事件,
        // 且原始事件已 preventDefault,不会双重输入)。Cmd+A 特判为终端全选。
        const ta = t.term.textarea;
        if (e.metaKey && k.toLowerCase() === 'a' && t.term.selectAll) {
          try { t.term.selectAll(); } catch { /* 部分 xterm 版本无 selectAll */ }
        } else if (ta) {
          const ne = new KeyboardEvent('keydown', {
            key: k, code: e.code || '', bubbles: true, cancelable: true,
            ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey,
          });
          ta.dispatchEvent(ne);
        }
      } catch { /* ignore */ }
      dlog('KEY', `'${key}' ${mod || '-'} active=BODY →已兜底转发终端`);
      return;
    }
    dlog('KEY', `'${key}' ${mod || '-'} active=${termElInfo(ae)} ⚠️BODY 按键被吞`);
    return;
  }
  dlog('KEY', `'${key}' ${mod || '-'} active=${termElInfo(ae)} ${inTerm ? '→终端' : (onMenu ? '⚠️菜单' : '⚠️BODY 按键被吞')}`);
}, true);

// 焦点迁移:终端 textarea / BODY / 菜单 之间的变化(右键菜单点一下把焦点顶掉就是元凶)
document.addEventListener('focusin', (e) => {
  const ae = e.target;
  const cls = ae && typeof ae.className === 'string' ? ae.className : '';
  const isTerm = !!cls && cls.indexOf('xterm-helper-textarea') >= 0;
  const isBody = ae === document.body;
  const onMenu = ae && (ae.id === 'ctx-menu' || (!!cls && cls.indexOf('ctx-item') >= 0));
  if (isTerm || isBody || onMenu) dlog('FOCUS', `→ ${termElInfo(ae)}${isTerm ? ' (终端)' : isBody ? ' (BODY!)' : ' (菜单)'}`);
}, true);

// ---- 中文输入法不定时失效修复 ----
// 症状:拼音候选窗偶尔弹不出来,按键直接以纯字母形式上屏/发到服务器。
// 根因:fcitx5/ibus 等输入法在「切标签 / 终端失焦 / 窗口失焦」时不会触发 xterm 隐藏
//       textarea 的 compositionend,导致 xterm 内部一直认为"组合中"(_isComposing=true),
//       之后的按键不再走组合流程 → 打不出中文。
// 修法:setupImeGuard 跟踪每个终端的组合状态;在「失焦 / 重新聚焦 / 窗口失焦 / 页面隐藏」
//       时若组合未正常结束,先清掉残留 preedit 再派发一次 compositionend,强制 xterm 复位。
//       下次聚焦终端时 Chromium 会向输入法申请全新会话,输入法恢复。
function setupImeGuard(term) {
  const ta = term.textarea;
  if (!ta || typeof ta.addEventListener !== 'function') return null;
  let composing = false;
  let timer = null;
  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const resetStuck = () => {
    clearTimer();
    if (!composing) return;
    composing = false;
    try {
      // 必须先清空残留 preedit:否则合成 compositionend 时 xterm 会把
      // substring(_compositionPosition.start, end) 那段拼音误提交到终端。
      ta.value = '';
      ta.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true }));
    } catch { /* ignore */ }
  };
  ta.addEventListener('compositionstart', () => {
    composing = true;
    clearTimer();
    // 兜底:组合若卡死(长时间无任何输入),10s 后强制复位,避免候选窗永久弹不出。
    // 正常打字时每次 compositionupdate 都会重置计时;10s 足够慢速拼音(边想边打)不被误杀
    // (旧版 3s 会打断候选窗停留 >3s 的输入)。
    timer = setTimeout(resetStuck, 10000);
  });
  ta.addEventListener('compositionupdate', () => {
    if (composing) { clearTimer(); timer = setTimeout(resetStuck, 10000); }
  });
  ta.addEventListener('compositionend', () => { composing = false; clearTimer(); });
  ta.addEventListener('blur', resetStuck); // 切标签 / 焦点被 UI 顶掉 时组合未结束 → 复位
  // 回到终端时上轮组合未正常结束 → 复位。注意:xterm 的 term.onFocus/onBlur 是事件对象
  // getter(返回 IEvent,不是可调用函数),直接 term.onFocus(fn) 会 TypeError 崩掉,必须用
  // textarea 的 DOM focus 事件(与上面 blur 一致)。
  ta.addEventListener('focus', resetStuck);
  // macOS/Windows 输入法"假组合"守卫:key='Process'/keyCode 229 连发,但本终端并没有真正在组合
  // (composing=false,即 compositionstart 从未触发)→ 是输入法残留的死键状态拦截了字符键
  // (日志:KEY 'Process' 刷屏,命令打不进去,只剩 Enter 能发)。分两档:
  //   1) 每次死键都派发空 compositionend,让 xterm 的 _isComposing 复位;
  //   2) 连续 ≥3 个死键仍没恢复(真卡死)→ 强制 blur+focus 重建输入法会话
  //      (Chromium 向系统申请全新 IME session,OS 层的拦截才真正解除)。
  // 有真实组合(compositionstart 已触发)时一律不干预,打拼音不受影响。
  let processBurst = 0;
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Process' || e.keyCode === 229) {
      if (composing) { processBurst = 0; return; } // 真实组合中,让 IME 正常走
      try { ta.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true })); } catch { /* ignore */ }
      if (++processBurst >= 3) {
        processBurst = 0;
        try { ta.blur(); ta.focus(); } catch { /* ignore */ } // 重建输入法会话
      }
    } else {
      processBurst = 0; // 有真实按键/正常键进来,复位计数
    }
  });
  return resetStuck;
}

// 全局兜底:窗口失焦 / 页面隐藏 时,把所有终端未结束的组合强制复位
window.addEventListener('blur', () => {
  if (!state.tabs) return;
  for (const t of state.tabs.values()) { try { t.__imeReset && t.__imeReset(); } catch { /* ignore */ } }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden || !state.tabs) return;
  for (const t of state.tabs.values()) { try { t.__imeReset && t.__imeReset(); } catch { /* ignore */ } }
});

// ---------- 标签右键菜单(关闭/复制/重命名/定位) ----------
function showTabMenu(e, sessionId) {
  const t = state.tabs.get(sessionId);
  if (!t) return;
  e.preventDefault();
  const items = [
    { label: `⤴ 激活「${t.title}」`, action: () => activateTab(sessionId) },
  ];
  // 已断开的标签:提供"重新连接"
  if (t.status !== 'connected' && t.status !== 'connecting') {
    items.push({ label: '🔃 重新连接', action: () => reconnectTab(sessionId) });
  }
  items.push(
    { separator: true },
    { label: '✂️ 关闭此标签', action: () => closeTab(sessionId) },
    { label: '🗕 关闭其他标签', action: () => closeOtherTabs(sessionId) },
    { label: '🗑 关闭全部标签', action: () => closeAllTabs(), danger: true },
    { separator: true },
    { label: '⧉ 复制会话', action: () => duplicateTab(sessionId) },
    { label: '✏️ 重命名标签', action: () => renameTab(sessionId) },
    { label: '🔍 定位到会话列表', action: () => locateInSessionList(sessionId) },
    { separator: true },
    { label: '🎨 标记颜色', separatorLabel: true },
    { label: '🟥 红色', action: () => setTabColor(sessionId, 'red') },
    { label: '🟩 绿色', action: () => setTabColor(sessionId, 'green') },
    { label: '🟨 黄色', action: () => setTabColor(sessionId, 'yellow') },
    { label: '🟦 蓝色', action: () => setTabColor(sessionId, 'blue') },
    { label: '⬜ 清除标记', action: () => setTabColor(sessionId, '') },
  );
  showCtxMenu(e.clientX, e.clientY, items);
}

// 关闭除指定标签外的所有标签
function closeOtherTabs(sessionId) {
  for (const sid of [...state.tabs.keys()]) {
    if (sid !== sessionId) closeTab(sid);
  }
}
function closeAllTabs() {
  for (const sid of [...state.tabs.keys()]) closeTab(sid);
}

// 复制会话:用同一个会话配置再开一个标签
function duplicateTab(sessionId) {
  const t = state.tabs.get(sessionId);
  if (!t || !t.session) return;
  connectToServer(t.session);
  setStatus(`已复制会话: ${t.session.name}`, 'var(--green)');
}

// 重命名标签:只改当前标签的显示名(不改会话配置)
function renameTab(sessionId) {
  const t = state.tabs.get(sessionId);
  if (!t) return;
  showPrompt({
    title: '重命名标签', label: '标签显示名(仅当前标签)',
    value: t.customTitle || t.title,
    onOk: (name) => {
      t.customTitle = (name || '').trim();
      const span = t.titleSpan;
      if (span) span.textContent = t.customTitle || t.session.name;
      setStatus(t.customTitle ? `标签已重命名: ${t.customTitle}` : '已恢复会话名', 'var(--green)');
    },
  });
}

// 设置/清除标签颜色:存进会话(DB),同时更新标签左边框样式
async function setTabColor(sessionId, color) {
  const t = state.tabs.get(sessionId);
  if (!t || !t.session) return;
  const s = t.session;
  const res = await window.api.updateSession(s.id, {
    name: s.name, host: s.host, port: s.port, username: s.username, password: s.password,
    privateKey: s.private_key || '', passphrase: s.passphrase || '',
    encoding: s.encoding || 'utf8', groupId: s.group_id, tagColor: color,
  });
  if (res && res.ok) {
    s.tag_color = color; // 本地记住,重连后标签还有颜色
    for (const c of ['red', 'green', 'yellow', 'blue']) t.el.classList.remove(`tab-color-${c}`);
    if (color) t.el.classList.add(`tab-color-${color}`);
    setStatus(color ? `已标记 ${color} 色标签` : '已清除标签颜色', 'var(--green)');
  } else {
    alert(res && res.error ? res.error : '标记失败');
  }
}

// 定位到会话列表:左侧列表滚动到该会话并闪烁提示
function locateInSessionList(sessionId) {
  const t = state.tabs.get(sessionId);
  if (!t || !t.session) return;
  activateTab(sessionId);
  const el = document.querySelector(`[data-session-id="${t.session.id}"]`);
  if (el) {
    el.scrollIntoView({ block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1400);
  }
}

// =====================================================================
// 分组管理(参考 Xshell)
// =====================================================================
// 新建分组(重名时友好提示,而不是报数据库 UNIQUE 错误)
// 新建分组;传了 parentId 就建为它的子分组(右键"新建子分组"),否则用当前选中的分组作父级
function newGroup(parentId) {
  const pid = parentId != null ? parentId : (state.activeGroupId != null ? state.activeGroupId : null);
  const parent = pid != null ? state.groups.find((g) => Number(g.id) === Number(pid)) : null;
  showPrompt({
    title: '新建分组',
    label: parent ? `在分组「${parent.name}」下新建子分组名` : '分组名',
    value: '',
    onOk: async (name) => {
      name = (name || '').trim();
      if (!name) return;
      const exists = state.groups.some((g) => g.name === name);
      if (exists) { alert(`分组「${name}」已存在,无需重复创建`); return; }
      const res = await window.api.createGroup(name, parent ? parent.id : null);
      if (!res.ok) { alert(`新建分组失败: ${res.error}`); return; }
      loadSessions();
    },
  });
}

// 重命名分组
function renameGroup(id, oldName) {
  showPrompt({
    title: '重命名分组', label: '分组名', value: oldName,
    onOk: async (name) => {
      if (!name || name === oldName) return;
      const res = await window.api.renameGroup(id, name);
      if (!res.ok) { alert(`重命名失败: ${res.error}`); return; }
      loadSessions();
    },
  });
}

// 删除分组(其下会话移到"默认分组")
// 危险操作需要密码确认:验证 App 密码通过后才执行 onOk;未设置密码则直接执行
function requirePassword(description, onOk) {
  window.api.lockHas().then((r) => {
    if (!r || !r.has) { onOk(); return; } // 没设密码锁 → 无需验证
    confirmPwdAction = onOk;
    els.confirmPwdDesc.textContent = description;
    els.confirmPwdInput.value = '';
    els.confirmPwdMsg.classList.add('hidden');
    els.confirmPwdModal.classList.remove('hidden');
    els.confirmPwdInput.focus();
  });
}
let confirmPwdAction = null;
async function confirmPwdOk() {
  const action = confirmPwdAction;
  const res = await window.api.lockVerify(els.confirmPwdInput.value);
  if (res && res.ok) {
    confirmPwdAction = null;
    els.confirmPwdModal.classList.add('hidden');
    if (action) action();
  } else {
    els.confirmPwdMsg.textContent = '密码不正确';
    els.confirmPwdMsg.classList.remove('hidden');
    els.confirmPwdInput.select();
  }
}
function confirmPwdCancel() { confirmPwdAction = null; els.confirmPwdModal.classList.add('hidden'); }

// 删除分组:分组下有主机 → 需验证密码,并连同主机一起删除;空分组 → 普通确认
async function deleteGroup(id, name) {
  // 安全校验:必须是对应真实分组(防止误传会话 id 等导致误删)
  const g = state.groups.find((x) => Number(x.id) === Number(id));
  if (!g) { alert('分组不存在,已取消删除'); return; }
  // 默认分组是系统保留(所有无组连接都归它),不可删除
  if (g.name === '默认分组') { alert('「默认分组」是系统保留分组,不能删除'); return; }
  const affected = collectGroupAndDescendants(Number(id));
  // 安全门槛:一次删除最多只能涉及 1 个顶级分组(防父链错乱/异常时误删多个顶级树)
  const topLevelInvolved = affected.filter((gid) => {
    const gg = state.groups.find((x) => Number(x.id) === Number(gid));
    if (!gg) return false; // 组已不存在的会话归属不算
    const hasParent = gg.parent_id != null && state.groups.some((p) => Number(p.id) === Number(gg.parent_id));
    return !hasParent;
  });
  if (topLevelInvolved.length > 1) {
    alert('⚠️ 本次删除会涉及多个顶级分组,已取消。\n请逐个顶级分组删除。');
    return;
  }
  const ids = new Set(affected);
  const groupSessions = state.sessions.filter((s) => ids.has(Number(s.group_id)));
  const doDelete = async () => {
    // 先关闭该分组下已打开的终端标签(否则连接还挂着)
    for (const s of groupSessions) {
      const tab = findTabBySessionId(s.id);
      if (tab) closeTab(tab.sessionId);
    }
    const res = await window.api.deleteGroup(id);
    if (!res.ok) { alert(`删除分组失败: ${res.error}`); return; }
    loadSessions();
  };
  if (groupSessions.length > 0) {
    requirePassword(
      `删除分组「${name}」吗?其下 ${groupSessions.length} 台主机将一并删除(不可恢复)。\n此操作需要验证 App 密码。`,
      doDelete
    );
  } else {
    if (!confirm(`删除空分组「${name}」吗?`)) return;
    await doDelete();
  }
}

// 把会话拖拽移动到另一个分组(拖到分组文件夹头触发)
async function moveSessionToGroup(sessionId, groupId) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s) return;
  if (s.group_id === groupId) return; // 已在同组
  const res = await window.api.updateSession(sessionId, {
    name: s.name,
    host: s.host,
    port: s.port || 22,
    username: s.username,
    password: s.password || '',
    groupId,
  });
  if (!res.ok) { alert(`移动失败: ${res.error}`); return; }
  setStatus(`已将「${s.name}」移动到分组`, 'var(--green)');
  loadSessions();
}

// 切换分组的"生产环境"标记(生产分组红色警示 + 危险命令确认)
async function toggleGroupProd(gid, groupName) {
  const g = state.groups.find((x) => x.id === gid);
  const next = !(g && g.is_prod);
  const res = await window.api.setGroupProd(gid, next);
  if (!res.ok) { alert(`设置失败: ${res.error}`); return; }
  setStatus(
    next ? `🚨 「${groupName}」已标记为生产环境(该分组所有会话红色警示 + 危险命令确认)` : `「${groupName}」已取消生产标记`,
    next ? 'var(--red)' : 'var(--green)'
  );
  await loadSessions(); // 重新拉分组/会话并重渲染
}

// 填充会话弹窗的分组下拉框(所有分组 + "新建分组..."入口)
function fillGroupSelect() {
  els.fGroup.innerHTML = '';
  for (const g of state.groups) {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = g.name;
    els.fGroup.appendChild(opt);
  }
  const opt = document.createElement('option');
  opt.value = '__new__';
  opt.textContent = '＋ 新建分组...';
  els.fGroup.appendChild(opt);
}

// =====================================================================
// 新建 / 编辑会话弹窗
// =====================================================================
function openSessionModal(session, presetGroupId) {
  state.editingId = session ? session.id : null;
  els.sessionModalTitle.textContent = session ? `编辑会话: ${session.name}` : '新建会话';
  const proto = (session && session.protocol) || 'ssh';
  els.fProtocol.value = proto;
  els.fName.value = session ? session.name : '';
  els.fHost.value = session ? session.host : '';
  els.fPort.value = session ? session.port : (proto === 'telnet' ? 23 : 22);
  els.fUsername.value = session ? session.username : '';
  els.fPassword.value = session ? (session.password || '') : '';
  els.fPrivateKey.value = session ? (session.private_key || '') : '';
  els.fPassphrase.value = session ? (session.passphrase || '') : '';
  const jump = session && session.jump ? session.jump : null;
  els.fJumpHost.value = jump ? (jump.host || '') : '';
  els.fJumpPort.value = jump ? (jump.port || 22) : 22;
  els.fJumpUsername.value = jump ? (jump.username || '') : '';
  els.fJumpPassword.value = jump ? (jump.password || '') : '';
  els.fEncoding.value = session ? (session.encoding || 'utf8') : 'utf8';
  els.fOnConnect.value = session ? (session.on_connect || '') : '';
  applySessionProtocol(proto); // 按协议切换字段可见性/标签
  fillGroupSelect();
  els.fGroup.value = session && session.group_id != null
    ? String(session.group_id)
    : (presetGroupId != null ? String(presetGroupId)
      : (state.groups[0] ? String(state.groups[0].id) : ''));
  els.sessionModal.classList.remove('hidden');
  els.fName.focus();
}

// 会话弹窗按协议切换:Telnet 隐藏私钥/跳板等 SSH 专属字段,端口/账号密码标签改说明
function applySessionProtocol(proto) {
  const isTelnet = proto === 'telnet';
  els.fSshOnly.classList.toggle('hidden', isTelnet);
  els.fPortLabel.textContent = isTelnet ? '端口(默认 23)' : '端口(默认 22)';
  els.fUsernameLabel.textContent = isTelnet ? '账号(可选,登录提示时自动发送)' : '用户名';
  els.fPasswordLabel.textContent = isTelnet ? '密码(可选,登录提示时自动发送)' : '密码';
  els.fPort.placeholder = isTelnet ? '23' : '22';
  els.fUsername.placeholder = isTelnet ? '如 admin' : 'root';
  if (isTelnet && !els.fPort.value) els.fPort.value = 23;
}

function closeSessionModal() {
  state.editingId = null;
  els.sessionModal.classList.add('hidden');
}

// =====================================================================
// 端口探测:批量 TCP 连通性检查(会话面板 🔎 按钮)
// =====================================================================
// 展开端口输入:"22,80,1000-1010" → [22, 80, 1000..1010];去重、去非法、上限 200 个
function parsePorts(str) {
  const out = [];
  const seen = new Set();
  for (const part of String(str || '').split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] != null ? Number(m[2]) : a;
    for (let p = Math.min(a, b); p <= Math.max(a, b) && out.length < 200; p++) {
      if (p > 0 && p < 65536 && !seen.has(p)) { seen.add(p); out.push(p); }
    }
  }
  return out;
}

// HTML 转义(探测结果里的 banner 是远端文本,不能直接 innerHTML 拼接)
function escHtml(x) {
  return String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function openProbeModal() {
  els.probeHost.value = ''; // 每次打开留空,避免误探旧主机
  els.probePorts.value = '';
  els.probeTimeout.value = 3000;
  els.probeResult.innerHTML = '<div class="probe-empty">填主机和端口后点「开始探测」</div>';
  els.probeModal.classList.remove('hidden');
  els.probeHost.focus();
}

function closeProbeModal() {
  els.probeModal.classList.add('hidden');
}

async function runPortProbe() {
  const host = els.probeHost.value.trim();
  const ports = parsePorts(els.probePorts.value);
  const timeout = Math.min(10000, Math.max(500, parseInt(els.probeTimeout.value || '3000', 10)));
  if (!host) { alert('请填写主机'); return; }
  if (!ports.length) { alert('请填写端口(如 22,80,1000-1010)'); return; }
  els.probeRun.disabled = true;
  els.probeRun.textContent = `探测中...`;
  els.probeResult.innerHTML = `<div class="probe-empty">正在探测 ${host} 的 ${ports.length} 个端口...</div>`;
  try {
    const res = await window.api.probePorts({ host, ports, timeoutMs: timeout });
    const rows = (res && res.length ? res : []).map((r) => {
      const statusText = { open: '开放', closed: '关闭', timeout: '超时', error: '错误' }[r.status] || r.status;
      const cls = `p-${r.status}`;
      return `<div class="probe-row"><span class="p-port">${r.port}</span>` +
        `<span class="p-status ${cls}">${statusText}</span>` +
        `<span class="p-banner">${escHtml(r.banner || (r.error || ''))}</span></div>`;
    }).join('');
    els.probeResult.innerHTML = rows || '<div class="probe-empty">无结果</div>';
  } catch (err) {
    els.probeResult.innerHTML = `<div class="probe-empty">探测失败: ${escHtml(err.message || String(err))}</div>`;
  } finally {
    els.probeRun.disabled = false;
    els.probeRun.textContent = '开始探测';
  }
}

// 真正保存会话(传分组 id)
async function doSaveSession(groupId) {
  const proto = els.fProtocol.value === 'telnet' ? 'telnet' : 'ssh';
  const data = {
    name: els.fName.value.trim(),
    host: els.fHost.value.trim(),
    port: parseInt(els.fPort.value || (proto === 'telnet' ? '23' : '22'), 10),
    username: els.fUsername.value.trim(),
    password: els.fPassword.value,
    privateKey: els.fPrivateKey.value.trim(),
    passphrase: els.fPassphrase.value,
    jump: els.fJumpHost.value.trim()
      ? {
          host: els.fJumpHost.value.trim(),
          port: parseInt(els.fJumpPort.value || '22', 10),
          username: els.fJumpUsername.value.trim(),
          password: els.fJumpPassword.value,
        }
      : null,
    encoding: els.fEncoding.value,
    onConnect: els.fOnConnect.value,
    protocol: proto,
    groupId,
  };

  // 简单校验:必填项(telnet 的账号是可选自动登录,不强制)
  if (!data.name || !data.host || (proto !== 'telnet' && !data.username)) {
    alert(proto === 'telnet' ? '名称、主机不能为空' : '名称、主机、用户名不能为空');
    return;
  }

  // 会话名称唯一:已存在同名会话(排除正在编辑的这条)则拒绝
  const nameDup = state.sessions.some((s) => s.name === data.name && s.id !== state.editingId);
  if (nameDup) { alert(`已存在同名会话「${data.name}」,请换个名称`); return; }

  if (state.editingId) {
    const res = await window.api.updateSession(state.editingId, data);
    if (!res.ok) alert(`保存失败: ${res.error}`);
  } else {
    const res = await window.api.createSession(data);
    if (!res.ok) alert(`保存失败: ${res.error}`);
  }
  closeSessionModal();
  loadSessions(); // 刷新列表
}

// 保存会话:分组下拉框选了"＋ 新建分组..."时,先建组再保存
function saveSession() {
  const groupVal = els.fGroup.value;
  if (groupVal === '__new__') {
    showPrompt({
      title: '新建分组', label: '分组名', value: '',
      onOk: async (gname) => {
        gname = (gname || '').trim();
        if (!gname) return;
        // 分组已存在 → 直接用现有的,不再报 UNIQUE 错
        const exist = state.groups.find((g) => g.name === gname);
        if (exist) { await doSaveSession(exist.id); return; }
        const gres = await window.api.createGroup(gname);
        if (!gres.ok) { alert(`新建分组失败: ${gres.error}`); return; }
        await doSaveSession(gres.id);
      },
    });
    return;
  }
  doSaveSession(groupVal ? Number(groupVal) : null);
}

// 删除单个主机:需要密码验证(和删分组一致的安全级别,防误删)
async function removeSession(id) {
  const s = state.sessions.find((x) => x.id === id);
  requirePassword(
    `确定删除主机「${s ? s.name : id}」吗?此操作不可恢复,需要验证 App 密码。`,
    async () => {
      const res = await window.api.removeSession(id);
      if (!res.ok) alert(`删除失败: ${res.error}`);
      // 单删会话后清掉批量勾选残留,否则批量条计数虚高、与勾选框不符
      state.selectedForBatch.delete(id);
      updateBatchBar();
      loadSessions();
    }
  );
}

// 克隆会话:复制全部配置(含私钥/口令/编码/分组),名字加"副本"
async function cloneSession(s) {
  const newName = `${s.name} 副本`;
  const res = await window.api.createSession({
    name: newName,
    host: s.host,
    port: s.port || 22,
    username: s.username,
    password: s.password || '',       // 已是解密后的明文,主进程会再加密入库
    privateKey: s.private_key || '',
    passphrase: s.passphrase || '',
    encoding: s.encoding || 'utf8',
    protocol: s.protocol || 'ssh',
    groupId: s.group_id != null ? s.group_id : undefined,
  });
  if (!res.ok) { alert(`克隆失败: ${res.error}`); return; }
  setStatus(`已克隆 → ${newName}`, 'var(--green)');
  loadSessions();
}

// =====================================================================
// 批量导入主机(第 5 课)
// =====================================================================
// 把"二维数组行"(每行 = [名称,主机,端口,用户名,密码,分组])转成会话对象并校验。
// 粘贴文本 和 Excel 文件解析完都变成这种行,再走这里统一处理。
function rowsToSessions(rows) {
  const out = [];
  for (const [idx, row] of rows.entries()) {
    const parts = row.map((c) => String(c == null ? '' : c).trim());
    if (parts.every((p) => !p)) continue; // 整行空白(如 ,,,,, 或末尾空行)→ 跳过,不算格式错误
    // 跳过表头行(名称,主机,端口,...)——防止被当成"主机叫 主机"的假会话导进来
    if (/^(名称|name)$/i.test(parts[0])) continue;
    const [name, host, port, username, password, group] = parts;
    if (!host || !username) {
      out.push({ error: `第 ${idx + 1} 行缺少主机或用户名(当前: ${parts.join('|')})` });
      continue;
    }
    out.push({
      name: name || host, // 没填名称就用主机地址当名称
      host,
      port: parseInt(port || '22', 10) || 22,
      username,
      password: password || '',
      group: group || '默认分组',
    });
  }
  return out;
}

// 解析粘贴的文本:每行一台,逗号分隔 名称,主机,端口,用户名,密码,分组。
function parseHostLines(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  // 首行若是表头(如 名称,主机,...)就跳过
  const data = lines.filter((l, i) => {
    if (i !== 0) return true;
    const parts = l.split(',');
    return !(/名称|主机|host/i.test(parts[0] || '') && parts.length <= 2);
  });
  return rowsToSessions(data.map((l) => l.split(',')));
}

function openImportModal() {
  els.importText.value = '';
  els.importResult.innerHTML = '';
  els.importFile.value = ''; // 清空上次选的文件
  els.importBackupFile.value = '';
  pendingImport = null;      // 重新打开导入弹窗,待导入列表清空
  pendingUpdate = [];
  importDone = false;        // 重置完成状态
  els.importSave.textContent = '导入';
  els.importModal.classList.remove('hidden');
  els.importText.focus();
}

function closeImportModal() {
  els.importModal.classList.add('hidden');
}

// 重名清单预览:去重后最多列 20 个,超出的用"…等 N 条"收尾(防止几百条刷屏)
function dupNamesPreview(names) {
  const uniq = [...new Set(names)];
  const shown = uniq.slice(0, 20).join('、');
  return uniq.length > 20 ? `${shown} 等共 ${uniq.length} 条` : shown;
}

// ---- 导入:先解析预览,点"导入"才真正落库 ----
let pendingImport = null; // 待新增的会话列表
let pendingUpdate = [];   // 待覆盖更新的会话 [{ id, data }]
let importDone = false;   // 是否已导入完成(完成按钮=关闭弹窗)

// 解析 + 名称去重(勾了"覆盖更新"则同名改为更新而不是跳过) → { errors, toImport, toUpdate, skippedDup }
function buildImportList(sessions) {
  const errors = sessions.filter((r) => r.error);
  const valid = sessions.filter((r) => !r.error);
  const overwrite = !!els.importOverwrite.checked;
  const existing = new Map(state.sessions.map((s) => [s.name, s])); // name → 已存在的会话
  const toImport = [];
  const toUpdate = [];
  const skippedDup = [];
  for (const s of valid) {
    const ex = existing.get(s.name);
    if (ex) {
      if (overwrite) {
        toUpdate.push({
          id: ex.id,
          data: {
            name: s.name, host: s.host, port: s.port, username: s.username, password: s.password,
            privateKey: ex.private_key || '', passphrase: ex.passphrase || '',
            encoding: ex.encoding || 'utf8', groupId: ex.group_id, // 保留原有分组/私钥设置
          },
        });
      } else skippedDup.push(s.name);
    } else toImport.push(s);
  }
  return { errors, toImport, toUpdate, skippedDup };
}

// 预览:解析结果展示出来,但不导入,等用户点"导入"
function setImportPreview(sessions) {
  const { errors, toImport, toUpdate, skippedDup } = buildImportList(sessions);
  pendingImport = toImport;
  pendingUpdate = toUpdate;
  importDone = false;                    // 预览后按钮回到"导入"
  els.importSave.textContent = '导入';
  let html = '';
  if (toImport.length || toUpdate.length) {
    const names = toImport.map((s) => s.name).slice(0, 15).join('、');
    html = `<div class="ok">已解析 <b>${toImport.length}</b> 台新增` + (toUpdate.length ? `, <b>${toUpdate.length}</b> 台将覆盖更新` : '') + `:</div>`;
    if (toImport.length) html += `<div class="ok">新增:${toImport.length > 15 ? `${names} 等` : names}</div>`;
    if (toUpdate.length) html += `<div class="ok">覆盖更新:${toUpdate.map((u) => u.data.name).slice(0, 10).join('、')}${toUpdate.length > 10 ? ' 等' : ''}</div>`;
    html += `<div class="ok">确认无误后,点下方「导入」按钮提交。</div>`;
  } else {
    const reason = [];
    if (skippedDup.length) reason.push(`${skippedDup.length} 条已存在(重名)`);
    if (errors.length) reason.push(`${errors.length} 条格式错误`);
    html = `<div class="bad">没有可导入的新条目${reason.length ? `: ${reason.join(', ')}` : ''}。</div>`;
    if (skippedDup.length) html += `<div class="bad">重名跳过: ${dupNamesPreview(skippedDup)}</div>`;
    if (errors.length) html += `<div class="bad">格式错误行:<br/>${errors.map((e) => e.error).join('<br/>')}</div>`;
    els.importResult.innerHTML = html;
    return;
  }
  if (errors.length) html += `<div class="bad">${errors.map((e) => e.error).join('<br/>')}</div>`;
  if (skippedDup.length) html += `<div class="bad">重名跳过: ${dupNamesPreview(skippedDup)}</div>`;
  els.importResult.innerHTML = html;
}

// 点"导入":导入完成后再点=关闭弹窗;否则优先提交文件待导入列表,或解析粘贴文本
async function doImport() {
  if (importDone) { closeImportModal(); return; } // 已完成 → 按钮变"完成",点了关弹窗
  if (pendingImport != null) {
    // 文件解析好的待导入列表(新增 + 覆盖更新)
    await commitImport(pendingImport, pendingUpdate);
    pendingImport = null;
    pendingUpdate = [];
  } else {
    // 粘贴文本:同样按"覆盖更新"勾选处理
    const sessions = parseHostLines(els.importText.value);
    const { toImport, toUpdate } = buildImportList(sessions);
    await commitImport(toImport, toUpdate);
  }
}

// 真正落库(新增 importMany + 覆盖 updateSession)+ 显示结果
async function commitImport(toImport, toUpdate) {
  const toImportList = (toImport || []).filter(Boolean);
  const toUpdateList = (toUpdate || []).filter(Boolean);
  let imported = 0, updated = 0, failCount = 0;
  let html = '';
  if (!toImportList.length && !toUpdateList.length) {
    els.importResult.innerHTML = '<span class="bad">没有可导入/更新的条目(都重名且未勾选覆盖?)</span>';
    return;
  }
  if (toImportList.length) {
    const res = await window.api.importSessions(toImportList);
    if (!res.ok) { els.importResult.innerHTML = `<span class="bad">导入失败: ${res.error}</span>`; return; }
    const fail = (res.results || []).filter((r) => !r.ok);
    imported = res.imported || 0;
    failCount += fail.length;
    if (fail.length) html += `<div class="bad">${fail.map((f) => `${f.name || '?'}: ${f.error}`).join('<br/>')}</div>`;
  }
  if (toUpdateList.length) {
    for (const u of toUpdateList) {
      const res = await window.api.updateSession(u.id, u.data);
      if (res && res.ok) updated++;
      else failCount++;
    }
  }
  html = `<div class="ok">导入完成:新增 ${imported} 条,更新 ${updated} 条,失败 ${failCount} 条</div>` + html;
  els.importResult.innerHTML = html;
  // 全部成功 → 主按钮变"完成"关闭弹窗;有失败 → 保持"导入"可重试
  if (failCount === 0 && (imported + updated) > 0) {
    importDone = true;
    els.importSave.textContent = '完成';
  } else {
    importDone = false;
    els.importSave.textContent = '导入';
  }
  loadSessions(); // 刷新会话列表
}

// 下载导入模板:主进程生成带表头和示例行的 Excel,弹保存对话框写盘
async function saveTemplate() {
  const res = await window.api.saveTemplate();
  if (!res.ok) {
    if (res.error !== '已取消') alert(`保存模板失败: ${res.error}`);
    return;
  }
  els.importResult.innerHTML = `<div class="ok">模板已保存: ${res.path}</div>`;
}

// 方式二:Excel 文件导入
async function importFromExcel() {
  const file = els.importFile.files[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer(); // 把文件读成二进制
    const wb = XLSX.read(buf);             // SheetJS 解析成工作簿
    const sheet = wb.Sheets[wb.SheetNames[0]]; // 只读第一个 sheet
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }); // 转二维数组
    // 首行若是表头就跳过
    const first = rows[0] || [];
    const hasHeader = /名称|主机|host/i.test(String(first[0] || '')) && first.length <= 6;
    setImportPreview(rowsToSessions(hasHeader ? rows.slice(1) : rows)); // 先预览,点"导入"才提交
  } catch (err) {
    els.importResult.innerHTML = `<span class="bad">读取 Excel 失败: ${err.message}</span>`;
  }
}

// =====================================================================
// 标签页 + 终端
// =====================================================================
// ---- 生产环境保护:危险命令确认(参考 Xshell/SecureCRT 的保命功能) ----
// 注意:此副本必须与 lib/dangerous.js 保持同步(回车确认是同步交互,不能走 IPC)。
// v2:命令解析(引号/转义/复合命令拆分)+ 分级(critical 直接拦 / high 必问)。
function splitCommands(line) {
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '\\') { cur += ch; i++; if (i < line.length) cur += line[i]; continue; }
    if (ch === '"' || ch === "'") { cur += ch; quote = ch; continue; }
    if (ch === ';' || ch === '\n') { if (cur.trim()) parts.push(cur.trim()); cur = ''; continue; }
    if (ch === '&' || ch === '|') {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
      if (i + 1 < line.length && line[i + 1] === ch) i++;
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}
function stripQuotes(s) {
  return s.replace(/\\(.)/g, '$1').replace(/"([^"]*)"/g, '$1').replace(/'([^']*)'/g, '$1');
}
const DANGEROUS_CMDS = [
  // critical:根目录破坏 / 整盘写 / 分区格式化 / fork 炸弹
  // 根目录判定要严格:rm 的目标必须是"独立参数 /"(行尾/空白后)、/* 或 --no-preserve-root,
  // 否则 `rm -rf /tmp/x`、`rm /tmp/x.txt` 这种普通路径会被误判为删根
  { level: 'critical', name: '删除根目录', re: /\brm\b[\s\S]*?(\s\/\s*$|\s\/\*\s*|\s--no-preserve-root\b)/i },
  { level: 'critical', name: '整盘写入(dd)', re: /\bdd\s+.*\bof=\/dev\/(sd|nvme|vd|hd)[a-z]+\d*/i },
  { level: 'critical', name: '格式化分区', re: /\bmkfs(\.\w+)?(\s|\b)/i },
  { level: 'critical', name: '分区操作(fdisk/parted)', re: /\b(fdisk|parted|gdisk|sfdisk)\b/i },
  { level: 'critical', name: '写入块设备', re: />\s*\/dev\/(sd|nvme|vd|hd)[a-z]+\d*/i },
  { level: 'critical', name: 'fork 炸弹', re: /:\s*\(\s*\)\s*\{|:\s*\|\s*:/i },
  // high:必须询问
  { level: 'high', name: '递归强制删除(rm -rf)', re: /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\b/i },
  { level: 'high', name: '关机/重启', re: /\b(shutdown|reboot|halt|poweroff)\b/i },
  { level: 'high', name: '切换运行级别(init)', re: /\binit\s+[06]\b/i },
  { level: 'high', name: '格式化命令', re: /\bformat\b/i },
];
function analyzeCommand(line) {
  const segments = splitCommands(String(line || ''));
  const findings = [];
  let worst = 'safe';
  for (const seg of segments) {
    const norm = stripQuotes(seg);
    for (const rule of DANGEROUS_CMDS) {
      if (rule.re.test(norm)) {
        findings.push({ command: seg, level: rule.level, name: rule.name });
        if (rule.level === 'critical') worst = 'critical';
        else if (rule.level === 'high' && worst !== 'critical') worst = 'high';
      }
    }
  }
  return { level: worst, segments, findings };
}
function isDangerousCommand(line) {
  return analyzeCommand(line).level !== 'safe';
}
// 危险级别 → 提示文案
function dangerousLabel(level) {
  return level === 'critical' ? '🔴 严重危险' : (level === 'high' ? '🟠 危险' : (level === 'medium' ? '🟡 注意' : ''));
}
// 会话所在分组是否标记为生产
function isSessionProd(s) {
  if (!s) return false;
  const g = state.groups.find((x) => x.id === s.group_id);
  return !!(g && g.is_prod);
}
// 是否开着至少一个生产环境会话(广播模式用)
function hasProdSession() {
  for (const t of state.tabs.values()) {
    if (t.status === 'connected' && isSessionProd(t.session)) return true;
  }
  return false;
}
// 把输入发给服务器(单会话 / 广播模式统一走这里)
function sendInput(sessionId, data) {
  // ---- 多行粘贴保护:一次贴入多行(如整段脚本)时先确认,防止误贴进生产 ----
  const lineCount = (String(data).match(/\r|\n/g) || []).length;
  if (lineCount > 1) {
    const targets = state.broadcast
      ? [...state.tabs.values()].filter((t) => t.status === 'connected')
      : [state.tabs.get(sessionId)].filter(Boolean);
    const isProd = state.broadcast ? hasProdSession() : targets.some((t) => t.session && isSessionProd(t.session));
    const lines = String(data).split(/\r|\n/).filter(Boolean);
    const preview = lines.slice(0, 5).join('\n') + (lines.length > 5 ? '\n…' : '');
    const targetName = state.broadcast ? `广播到 ${targets.length} 台` : (targets[0] && targets[0].session.name);
    const ok = confirm(
      `⚠️ 检测到多行粘贴(${lineCount} 行)!\n\n` +
      `目标:${isProd ? ' ⚠️ 生产环境' : ' ' + (targetName || '')}\n\n` +
      `内容预览:\n${preview}\n\n` +
      `确认要发送吗?`
    );
    if (!ok) return; // 拒绝则整段不发送
  }

  if (state.broadcast) {
    for (const t of state.tabs.values()) {
      if (t.status === 'connected') window.api.sshWrite(t.sessionId, data);
    }
  } else {
    window.api.sshWrite(sessionId, data);
  }
}

// =====================================================================
// 命令记录(记录每台终端执行过的命令,可查看/重发/清空/导出)
// =====================================================================
// 显示完整日期+时间(如 2026-08-05 09:31:02),跨年跨天都分得清
function fmtTime() {
  const now = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
}

// 从终端缓冲区还原被"历史回显"的命令:当前行内容 − 已学习的提示符
// 只在学习到提示符且匹配时才返回,否则返回空(宁可不记,也不记错)
function recoverRecalledCommand(tab, term) {
  try {
    const buf = term.buffer.active;
    const prompt = tab.promptText || '';
    if (!prompt) return '';
    // 长命令会在终端里换行成多行:从光标行往回找"以提示符开头"的那一行(命令起始行),
    // 再把起始行到光标行拼接起来还原完整命令。
    let start = buf.cursorY;
    for (let y = buf.cursorY; y >= 0; y--) {
      const line = buf.getLine(y);
      if (!line) break;
      if (line.translateToString(true).trim().startsWith(prompt)) { start = y; break; }
    }
    let joined = '';
    for (let y = start; y <= buf.cursorY; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      joined += line.translateToString(true).trim();
    }
    if (joined.startsWith(prompt)) return joined.slice(prompt.length).trim();
    return '';
  } catch { return ''; }
}

// 记录一条命令(回车时调用);每次执行都记录(连续相同命令也逐条记);按主机聚合
// 同时持久化到 SQLite(cmd_history 表),重启不丢。
function recordCommand(host, line) {
  line = (line || '').trim();
  if (!line) return;
  const key = host || '未知主机';
  if (!state.cmdHistory[key]) state.cmdHistory[key] = { host: key, commands: [] };
  const rec = state.cmdHistory[key];
  rec.commands.push({ time: fmtTime(), command: line });
  if (rec.commands.length > 1000) rec.commands.shift();
  window.api.addCmdHistory(key, line); // 持久化(失败不影响使用)
  if (!els.cmdPanel.classList.contains('hidden')) renderCmdPanel();
}

// 启动时从 SQLite 加载已持久化的命令记录
async function loadCmdHistory() {
  try {
    const res = await window.api.listCmdHistory();
    if (!res || !res.ok || !Array.isArray(res.cmds)) return;
    state.cmdHistory = {}; // 先清空再加载,避免重复调用导致重复
    for (const row of res.cmds) {
      const h = row.host || '未知主机';
      if (!state.cmdHistory[h]) state.cmdHistory[h] = { host: h, commands: [] };
      state.cmdHistory[h].commands.push({
        time: (row.created_at || '').slice(0, 19), // "YYYY-MM-DD HH:MM:SS" → 完整含年份
        command: row.command,
      });
    }
    if (!els.cmdPanel.classList.contains('hidden')) renderCmdPanel();
  } catch { /* 忽略 */ }
}

// 渲染命令记录面板:归档文件视图 / 当前记录
function renderCmdPanel() {
  const list = els.cmdList;
  list.innerHTML = '';
  // 归档文件视图
  if (state.cmdArchivesView === 'files') {
    renderArchiveFiles(list);
    els.cmdCount.textContent = '归档文件';
    list.scrollTop = list.scrollHeight;
    return;
  }
  let total = 0;
  for (const key of Object.keys(state.cmdHistory)) {
    const rec = state.cmdHistory[key];
    const cmds = rec.commands || [];
    if (!cmds.length) continue;
    total += cmds.length;
    const group = document.createElement('div');
    group.className = 'cmd-group';
    const title = document.createElement('div');
    title.className = 'cmd-group-title';
    title.textContent = `🖥 ${rec.host || key}`;
    group.appendChild(title);
    for (const c of cmds) {
      const item = document.createElement('div');
      item.className = 'cmd-item';
      item.title = `点击重发到 ${rec.host}`;
      const time = document.createElement('span');
      time.className = 'cmd-time';
      time.textContent = c.time;
      const text = document.createElement('span');
      text.className = 'cmd-text';
      text.textContent = c.command;
      item.appendChild(time);
      item.appendChild(text);
      item.addEventListener('click', () => resendCommand(key, c.command));
      group.appendChild(item);
    }
    list.appendChild(group);
  }
  els.cmdCount.textContent = total ? `共 ${total} 条` : '';
  if (!total) list.innerHTML = '<div class="dim" style="padding:12px">还没有命令记录,在终端里敲命令试试</div>';
  // 自动滚到底部,让最新命令始终可见
  list.scrollTop = list.scrollHeight;
}

// 点击命令 → 重发到对应主机(找到该主机任一已连接终端)
function resendCommand(host, command) {
  let target = null;
  for (const t of state.tabs.values()) {
    if (t.status === 'connected' && t.session && t.session.host === host) { target = t; break; }
  }
  if (!target) { alert('该主机未连接,无法重发'); return; }
  // 切到目标标签并聚焦,让命令立刻可见、生效
  if (state.activeSessionId !== target.sessionId) activateTab(target.sessionId);
  window.api.sshWrite(target.sessionId, command + '\r');
  target.term.focus();
  // 重发的命令也算执行了一次 → 同样记录(开关开启时)
  if (state.settings.cmdRecord !== false) recordCommand(host, command);
  setStatus(`已重发到 ${target.session.name}: ${command.split('\n')[0]}`, 'var(--green)');
}

// 清空:内存 + SQLite 一起清
function clearCmdHistory() {
  if (!confirm('确定清空所有命令记录吗?')) return;
  state.cmdHistory = {};
  window.api.clearCmdHistoryDb(); // 同步清掉数据库里的持久化记录
  renderCmdPanel();
}

// 显示归档文件视图:列出 archives 文件夹里的归档文件,选中可下载/删除
// 当前活动主机(用于归档/查看归档)
function activeCmdHost() {
  const t = state.tabs.get(state.activeSessionId);
  return t && t.session ? t.session.host : '';
}
function basename(p) { return String(p || '').split(/[\\/]/).pop(); }

// 显示归档视图:列出"当前主机"的归档批次,选中可下载/删除
async function showCmdArchiveFiles(host) {
  const h = host || activeCmdHost();
  const res = await window.api.listCmdArchives(h);
  if (!res || !res.ok) { alert(`读取归档失败: ${res && res.error}`); return; }
  state.cmdArchiveFiles = res.archives || [];
  state.selectedArchiveFile = null;
  state.cmdArchivesView = 'files';
  state.cmdArchiveHost = h;
  renderCmdPanel();
}
// 返回当前记录视图
function showCmdCurrent() {
  state.cmdArchivesView = null;
  state.selectedArchiveFile = null;
  renderCmdPanel();
}
// 渲染"当前主机"的归档批次列表(文件名用标签页名_时间戳,点击选中可下载/删除)
function renderArchiveFiles(list) {
  const back = document.createElement('div');
  back.className = 'cmd-arch-back';
  back.textContent = '← 返回当前记录';
  back.addEventListener('click', showCmdCurrent);
  list.appendChild(back);
  const title = document.createElement('div');
  title.className = 'cmd-group-title';
  title.textContent = `🖥 归档 · ${state.cmdArchiveHost || '当前主机'}`;
  list.appendChild(title);
  const files = state.cmdArchiveFiles || [];
  if (!files.length) {
    list.appendChild(Object.assign(document.createElement('div'), { className: 'dim', textContent: '该主机还没有归档文件,点「归档」创建', style: 'padding:12px' }));
    return;
  }
  for (const f of files) {
    const row = document.createElement('div');
    row.className = 'cmd-item' + (state.selectedArchiveFile && state.selectedArchiveFile.archiveId === f.archive_id ? ' sel' : '');
    row.title = '点击选中,可下载/删除';
    const name = document.createElement('span');
    name.className = 'cmd-text';
    name.textContent = basename(f.file) || f.archive_id;
    const meta = document.createElement('span');
    meta.className = 'cmd-time';
    meta.textContent = `${f.count} 条 · ${(f.created_at || '').slice(5, 16)}`;
    row.appendChild(name);
    row.appendChild(meta);
    row.addEventListener('click', () => {
      state.selectedArchiveFile = { archiveId: f.archive_id, file: f.file, name: basename(f.file) || f.archive_id };
      renderCmdPanel();
    });
    list.appendChild(row);
  }
  // 底部操作条
  const bar = document.createElement('div');
  bar.className = 'cmd-arch-actions';
  if (state.selectedArchiveFile) {
    const sel = document.createElement('span');
    sel.className = 'cmd-text';
    sel.textContent = `已选: ${state.selectedArchiveFile.name}`;
    bar.appendChild(sel);
    const dl = document.createElement('button');
    dl.className = 'btn-mini'; dl.textContent = '⬇ 下载';
    dl.addEventListener('click', () => downloadArchiveFile(state.selectedArchiveFile));
    const del = document.createElement('button');
    del.className = 'btn-mini danger'; del.textContent = '🗑 删除';
    del.addEventListener('click', () => deleteArchiveFile(state.selectedArchiveFile));
    bar.appendChild(dl);
    bar.appendChild(del);
  } else {
    bar.appendChild(Object.assign(document.createElement('span'), { className: 'dim', textContent: '点击上面的归档文件可选中,然后下载或删除' }));
  }
  list.appendChild(bar);
}

// 下载选中的归档文件(主进程弹保存对话框复制一份)
async function downloadArchiveFile(sel) {
  const res = await window.api.downloadArchive(sel.file);
  if (!res || !res.ok) { if (res && res.error !== '已取消') alert(`下载失败: ${res.error}`); return; }
  setStatus(`归档已下载 → ${res.path}`, 'var(--green)');
}

// 删除选中的归档(文件 + 数据库批次一起删)
async function deleteArchiveFile(sel) {
  if (!confirm(`确定删除归档「${sel.name}」吗?`)) return;
  const res = await window.api.deleteArchive(sel.archiveId, sel.file);
  if (!res || !res.ok) { alert(`删除失败: ${res && res.error}`); return; }
  setStatus(`已删除归档: ${sel.name}`, 'var(--orange)');
  await showCmdArchiveFiles(); // 刷新列表(保持当前主机)
}

// 「归档」按钮:归档当前主机的命令记录(存数据库+文件,不自动打开),然后进入该主机的归档视图
async function archiveAndView() {
  const host = activeCmdHost();
  const t = state.tabs.get(state.activeSessionId);
  const sessionName = t && t.session ? t.session.name : '归档';
  const recs = host && state.cmdHistory[host] ? state.cmdHistory[host].commands : [];
  if (recs.length > 0) {
    if (!confirm('归档后当前主机的命令记录会存入归档文件并从面板清空,继续?')) return;
    const res = await window.api.archiveCmdHistory(host, sessionName);
    if (!res || !res.ok) { alert(`归档失败: ${res && res.error ? res.error : '未知错误'}`); return; }
    if (res.archived) {
      delete state.cmdHistory[host]; // 只清该主机的内存记录
      setStatus(`已归档 ${res.archived} 条命令 → ${res.path}`, 'var(--green)');
    }
  }
  await showCmdArchiveFiles(host); // 进入该主机的归档视图
}

// 开关命令记录面板
function toggleCmdPanel() {
  els.cmdPanel.classList.toggle('hidden');
  if (!els.cmdPanel.classList.contains('hidden')) {
    els.batchPanel.classList.add('hidden'); // 命令记录与批量执行互斥:共用右侧面板位,开一个收另一个,防终端被挤没
    renderCmdPanel();
  }
  syncPanelButtons();
  refitAll(); // 面板打开/收起后终端区宽度变了,重新适配 xterm,避免输出越过竖直分割线
}

// =====================================================================
// 批量执行结果面板:一条命令发多台主机,结果统一看
// =====================================================================
function toggleBatchPanel() {
  els.batchPanel.classList.toggle('hidden');
  if (!els.batchPanel.classList.contains('hidden')) {
    els.cmdPanel.classList.add('hidden'); // 与命令记录互斥:共用右侧面板位,开一个收另一个,防终端被挤没
    renderBatchHosts(); // 打开时刷新主机勾选列表
    els.batchCmd.focus();
  }
  syncPanelButtons();
  refitAll();
}

// 渲染主机勾选列表(来自当前已打开的所有标签)
function renderBatchHosts() {
  const box = els.batchHosts;
  box.innerHTML = '';
  for (const t of state.tabs.values()) {
    const connected = t.status === 'connected';
    const label = document.createElement('label');
    label.className = 'batch-host';
    label.title = connected ? `${t.session.username}@${t.session.host}` : '未连接,不会执行';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.batchHosts.has(t.sessionId);
    cb.addEventListener('change', () => {
      if (cb.checked) state.batchHosts.add(t.sessionId);
      else state.batchHosts.delete(t.sessionId);
      updateBatchCount();
    });
    const name = document.createElement('span');
    name.textContent = `${t.session.name} (${t.session.host})`;
    if (!connected) name.classList.add('dim');
    label.appendChild(cb);
    label.appendChild(name);
    box.appendChild(label);
  }
  updateBatchCount();
}

function updateBatchCount() {
  els.batchPanelCount.textContent = `已选 ${state.batchHosts.size} 台`;
}

// 执行:把命令发到勾选的已连接主机,渲染逐台结果
async function runBatchExec() {
  const cmd = els.batchCmd.value.trim();
  if (!cmd) { alert('先输入要执行的命令'); return; }
  const selTabs = [...state.batchHosts].map((id) => state.tabs.get(id)).filter((t) => t && t.status === 'connected');
  if (!selTabs.length) { alert('请先勾选已连接的主机'); return; }
  const hosts = selTabs.map((t) => ({
    name: t.session.name, host: t.session.host, port: t.session.port,
    username: t.session.username, password: t.session.password,
    privateKey: t.session.private_key || '', passphrase: t.session.passphrase || '',
  }));
  els.batchRun.disabled = true;
  els.batchRun.textContent = '⏳ 执行中…';
  try {
    const res = await window.api.batchExec({ hosts, command: cmd });
    if (res && res.ok) renderBatchResults(res.results);
    else alert(res && res.error ? res.error : '执行失败');
  } catch (e) {
    alert('批量执行异常: ' + ((e && e.message) || '未知错误'));
  } finally {
    els.batchRun.disabled = false;
    els.batchRun.textContent = '▶ 执行'; // 异常也要复位按钮,否则永久卡在"执行中…"
  }
}

// =====================================================================
// 快速命令(命令收藏)
// =====================================================================
async function openQuickModal() {
  await refreshQuickList();
  els.quickModal.classList.remove('hidden');
}
function closeQuickModal() { els.quickModal.classList.add('hidden'); }

async function refreshQuickList() {
  const res = await window.api.quickList();
  renderQuickList(res && res.ok ? res.cmds : []);
}

// 渲染命令列表:每行 名称+命令 + [发送到当前][批量][删除]
function renderQuickList(cmds) {
  const box = els.quickList;
  box.innerHTML = '';
  if (!cmds.length) {
    const empty = document.createElement('div');
    empty.className = 'quick-empty dim';
    empty.textContent = '还没有收藏。填下面「名称 + 命令」保存一个。';
    box.appendChild(empty);
    return;
  }
  for (const c of cmds) {
    const row = document.createElement('div');
    row.className = 'quick-item';
    const main = document.createElement('div');
    main.className = 'quick-main';
    const title = document.createElement('div');
    title.className = 'quick-title';
    title.textContent = c.name;
    const cmd = document.createElement('div');
    cmd.className = 'quick-cmd dim';
    cmd.textContent = c.command;
    main.appendChild(title);
    main.appendChild(cmd);
    const actions = document.createElement('div');
    actions.className = 'quick-actions';
    const b1 = document.createElement('button');
    b1.className = 'btn-mini';
    b1.textContent = '▶ 当前';
    b1.title = '发送到当前激活的终端';
    b1.addEventListener('click', () => sendQuickCurrent(c.name, c.command));
    const b2 = document.createElement('button');
    b2.className = 'btn-mini';
    b2.textContent = '⚡ 批量';
    b2.title = '批量执行到所有已连接主机';
    b2.addEventListener('click', () => sendQuickBatch(c.command));
    const b3 = document.createElement('button');
    b3.className = 'btn-mini';
    b3.textContent = '编辑';
    b3.title = '修改名称/命令';
    b3.addEventListener('click', () => editQuick(c));
    const b4 = document.createElement('button');
    b4.className = 'btn-mini danger';
    b4.textContent = '删除';
    b4.addEventListener('click', async () => {
      if (confirm(`删除快速命令「${c.name}」?`)) { await window.api.quickDel(c.id); refreshQuickList(); }
    });
    actions.appendChild(b1);
    actions.appendChild(b2);
    actions.appendChild(b3);
    actions.appendChild(b4);
    row.appendChild(main);
    row.appendChild(actions);
    box.appendChild(row);
  }
}

// ---- 编辑已存快速命令:复用下方"名称+命令"表单(保存按钮变"保存修改") ----
let editingQuickId = null;
function editQuick(c) {
  editingQuickId = c.id;
  els.quickName.value = c.name;
  els.quickCommand.value = c.command;
  els.quickAddBtn.textContent = '✓ 保存修改';
  els.quickCancelBtn.classList.remove('hidden');
  els.quickName.focus();
}
function cancelEditQuick() {
  editingQuickId = null;
  els.quickName.value = '';
  els.quickCommand.value = '';
  els.quickAddBtn.textContent = '＋ 保存命令';
  els.quickCancelBtn.classList.add('hidden');
}

// 保存新命令 / 保存修改(名称+命令)
async function addQuickCommand() {
  const name = els.quickName.value.trim();
  const command = els.quickCommand.value.trim();
  if (!command) { alert('命令不能为空'); return; }
  const editing = editingQuickId;
  const res = editing
    ? await window.api.quickUpdate(editing, name || '未命名', command)
    : await window.api.quickAdd(name || '未命名', command);
  if (res && res.ok) {
    const shown = name || command.split('\n')[0].slice(0, 30) || '未命名';
    cancelEditQuick();
    refreshQuickList();
    setStatus(editing ? `已修改快速命令: ${shown}` : `已保存快速命令: ${shown}`, 'var(--green)');
  } else {
    alert(res && res.error ? res.error : '保存失败');
  }
}

// 发送到当前激活终端(状态提示只显示名称,不显示整条命令,避免状态栏被撑爆)
function sendQuickCurrent(name, command) {
  const t = state.tabs.get(state.activeSessionId);
  if (!t || t.status !== 'connected') { alert('请先连接一个会话'); return; }
  window.api.sshWrite(t.sessionId, command + '\r');
  setStatus(`已发送: ${name}`, 'var(--green)');
  closeQuickModal();
}

// 批量执行到所有已连接主机(复用批量面板)
async function sendQuickBatch(command) {
  const connected = [...state.tabs.values()].filter((t) => t.status === 'connected');
  if (!connected.length) { alert('没有已连接的主机'); return; }
  if (els.batchPanel.classList.contains('hidden')) toggleBatchPanel();
  state.batchHosts.clear();
  connected.forEach((t) => state.batchHosts.add(t.sessionId));
  renderBatchHosts();
  els.batchCmd.value = command;
  await runBatchExec();
  closeQuickModal();
}

// =====================================================================
// SSH 隧道 / 端口转发
// =====================================================================
// =====================================================================
// JumpServer 资产(堡垒机):登录 → 列资产 → 选资产连 SSH / SFTP(经 KoKo 网关)
// =====================================================================
function jmsFind(id) { return state.jmsServers.find((s) => s.id === id); }
function jmsActive() { return jmsFind(state.jmsActiveId); }

// 持久化服务器配置(名称/地址/账号/密码;token 不持久化,重启后静默重登)
// 落盘前用主进程 safeStorage 加密密码(异步;调用处不 await,持久化是最终一致的)
async function jmsPersistConfig() {
  const servers = await Promise.all(state.jmsServers.map(async (s) => {
    let enc = s.password;
    try { if (enc && !enc.startsWith('enc:v1:')) enc = (await window.api.cryptoEncrypt(enc)).value || enc; } catch { /* 加密失败保留原值 */ }
    return { id: s.id, name: s.name, baseUrl: s.baseUrl, sshHost: s.sshHost, sshPort: s.sshPort, account: s.account, password: enc, loggedOut: !!s.loggedOut };
  }));
  state.settings.jmsServers = servers;
  saveSettings();
  // 双写:主进程落一份 jms-servers.json(localStorage 偶发丢失,文件保证重启不丢)
  try { await window.api.jmsPersist(servers); } catch { /* 落盘失败不阻断 */ }
}

function openJmsModal() {
  jmsRenderServerSelect();
  els.jmsOtpWrap.style.display = 'none';
  els.jmsOtp.value = '';
  els.jmsModal.classList.remove('hidden');
}
function closeJmsModal() { els.jmsModal.classList.add('hidden'); }

// 在堡垒机面板 webview 中打开 JumpServer Web 控制台
// 打开 JumpServer 控制台首页(v3/v4 在 /ui/,登录后显示工作台/首页),不再直达 Luna Web 终端页:
// 站点根 / 会(登录后)被 JumpServer 重定向到 /luna/?token=xxx —— 那正是用户不需要的 Web 终端内容。
// 登录页则自动填凭据提交(MFA 等手输验证码)。
async function openJmsWeb() {
  const s = state.jmsServers.find((x) => x.token && x.user) || jmsActive();
  if (!s || !s.baseUrl) { showJmsMsg('请先配置并连接 JumpServer(🛡 → JumpServer(API 对接))'); openJmsModal(); return; }
  openBastionPanel();
  const base = s.baseUrl.replace(/\/+$/, '');
  const home = `${base}/ui/`;
  els.bastionUrl.value = home;
  loadBastion(home);
  setStatus('打开 JumpServer Web 控制台', 'var(--green)');
  // 等页面起来:停在登录页则自动填账号密码并提交(登录后即到控制台首页)
  setTimeout(async () => {
    try { await jmsWebEnsureLogin(s, base); } catch { /* 自动登录失败不打断,用户可手动操作 */ }
  }, 800);
}

function showJmsMsg(text) {
  els.jmsMsg.textContent = text;
  els.jmsMsg.classList.toggle('hidden', !text);
}

// 填充服务器下拉,并回显当前服务器配置
function jmsRenderServerSelect() {
  const sel = els.jmsServerSelect;
  sel.innerHTML = '';
  for (const s of state.jmsServers) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${s.name}${s.token ? ' ✓' : ''}`;
    sel.appendChild(opt);
  }
  if (state.jmsServers.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(暂无服务器,点 ＋ 新增)';
    sel.appendChild(opt);
  }
  if (!state.jmsActiveId && state.jmsServers.length) state.jmsActiveId = state.jmsServers[0].id;
  sel.value = state.jmsActiveId || '';
  jmsFillForm(jmsActive());
}

function jmsFillForm(s) {
  els.jmsName.value = s ? s.name : '';
  els.jmsUrl.value = s ? s.baseUrl : '';
  els.jmsSshHost.value = s ? s.sshHost : '';
  els.jmsSshPort.value = s ? s.sshPort : 2222;
  els.jmsUser.value = s ? s.account : '';
  els.jmsPass.value = s ? s.password : '';
  els.jmsOtpWrap.style.display = 'none';
  els.jmsOtp.value = '';
  const loggedIn = !!(s && s.token);
  els.jmsLoginBtn.classList.toggle('hidden', loggedIn);
  els.jmsLogoutBtn.classList.toggle('hidden', !loggedIn);
  els.jmsRefreshBtn.classList.toggle('hidden', !loggedIn);
}

function jmsSelectServer(id) {
  state.jmsActiveId = id || null;
  jmsFillForm(jmsActive());
}

// 编辑某个已创建的 JumpServer 服务器:选中并打开配置弹窗
function jmsEditServer(id) {
  state.jmsActiveId = id || null;
  openJmsModal();
}

// 新增服务器
function jmsAddServer() {
  const s = { id: `jms-server-${++state.jmsSeq}`, name: '新服务器', baseUrl: '', sshHost: '', sshPort: 2222, account: '', password: '', token: null, user: null, assets: [] };
  state.jmsServers.push(s);
  state.jmsActiveId = s.id;
  jmsPersistConfig();
  jmsRenderServerSelect();
  els.jmsName.focus();
}

// 删除当前服务器
function jmsDeleteServer() {
  const s = jmsActive();
  if (!s) return;
  if (!confirm(`删除服务器「${s.name}」的配置吗?`)) return;
  state.jmsServers = state.jmsServers.filter((x) => x.id !== s.id);
  state.jmsActiveId = state.jmsServers.length ? state.jmsServers[0].id : null;
  jmsPersistConfig();
  jmsRenderServerSelect();
  renderSessionList(els.inputSessionSearch.value);
}

// 保存当前服务器配置(不登录;之后可随时点"连接 JumpServer")
function jmsDoSave() {
  const s = jmsActive();
  const name = els.jmsName.value.trim() || 'JumpServer';
  let baseUrl = els.jmsUrl.value.trim();
  const sshHost = els.jmsSshHost.value.trim();
  const sshPort = parseInt(els.jmsSshPort.value || '2222', 10);
  const account = els.jmsUser.value.trim();
  const password = els.jmsPass.value;
  if (!baseUrl) { showJmsMsg('请填 Web 地址'); return; }
  if (!/^https?:\/\//i.test(baseUrl)) baseUrl = 'http://' + baseUrl;
  const server = s || { id: `jms-server-${++state.jmsSeq}`, assets: [], token: null, user: null };
  Object.assign(server, { name, baseUrl, sshHost, sshPort, account, password });
  if (!state.jmsServers.includes(server)) state.jmsServers.push(server);
  state.jmsActiveId = server.id;
  jmsPersistConfig();
  jmsRenderServerSelect();
  showJmsMsg(`✅ 已保存「${name}」(尚未连接,点"连接 JumpServer"登录)`);
}

async function jmsDoLogin() {
  const s = jmsActive();
  const name = els.jmsName.value.trim() || (s && s.name) || 'JumpServer';
  let baseUrl = els.jmsUrl.value.trim();
  let sshHost = els.jmsSshHost.value.trim();
  let sshPort = parseInt(els.jmsSshPort.value || '2222', 10);
  const account = els.jmsUser.value.trim();
  const password = els.jmsPass.value;
  if (!baseUrl || !account || !password) { showJmsMsg('请填 Web 地址、账号、密码'); return; }
  // 智能推导:Web 地址 → API 地址(同源);SSH 网关留空 = Web 地址主机;端口留空 = 2222
  if (!/^https?:\/\//i.test(baseUrl)) baseUrl = 'http://' + baseUrl;
  let webUrl;
  try { webUrl = new URL(baseUrl); } catch { showJmsMsg('Web 地址无效'); return; }
  if (!sshHost) sshHost = webUrl.hostname;
  if (!sshPort) sshPort = 2222;
  const server = s || { id: `jms-server-${++state.jmsSeq}`, assets: [] };
  Object.assign(server, { name, baseUrl, sshHost, sshPort, account, password });
  if (!state.jmsServers.includes(server)) state.jmsServers.push(server);
  state.jmsActiveId = server.id;
  showJmsMsg('');
  els.jmsLoginBtn.disabled = true;
  els.jmsLoginBtn.textContent = '登录中…';
  try {
    const r = await window.api.jmsLogin({ baseUrl, username: account, password });
    if (!r.ok) { showJmsMsg(`登录失败: ${r.error}`); els.jmsLoginBtn.disabled = false; els.jmsLoginBtn.textContent = '连接 JumpServer'; return; }
    if (r.mfaRequired) {
      server.mfaCookie = r.cookie; server.mfaUrl = r.challengeUrl; server.mfaType = (r.choices && r.choices[0]) || 'otp';
      jmsPersistConfig();
      jmsRenderServerSelect(); // 先刷新下拉(会重置表单),再显示 OTP
      els.jmsOtpWrap.style.display = '';
      els.jmsOtp.value = '';
      els.jmsOtp.focus();
      els.jmsLoginBtn.disabled = false;
      els.jmsLoginBtn.textContent = '验证并登录';
      showJmsMsg('该账号开启了双因素认证,请输入验证码');
      return;
    }
    server.token = r.token; server.user = r.user;
    server.loggedOut = false; // 手动登录成功 → 恢复自动登录
    els.jmsOtpWrap.style.display = 'none';
    els.jmsLoginBtn.disabled = false;
    els.jmsLoginBtn.textContent = '连接 JumpServer';
    // 登录成功 → 该服务器区块默认折叠(左侧分组收起,展开才看资产)
    state.collapsedJms.add(server.id);
    jmsPersistConfig();
    jmsRenderServerSelect();
    await jmsLoadAssets();
  } catch (e) {
    showJmsMsg('登录异常: ' + ((e && e.message) || '未知错误'));
    els.jmsLoginBtn.disabled = false;
    els.jmsLoginBtn.textContent = '连接 JumpServer'; // 异常也要复位,否则永久卡在"登录中…"
  }
}

// 提交双因素验证码 → 完成登录 → 拉资产
async function jmsDoMfa() {
  const s = jmsActive();
  if (!s) return;
  const code = els.jmsOtp.value.trim();
  if (!code) { showJmsMsg('请输入验证码'); return; }
  if (!s.mfaCookie) { showJmsMsg('会话已失效,请重新登录'); return; }
  showJmsMsg('');
  els.jmsLoginBtn.disabled = true;
  els.jmsLoginBtn.textContent = '验证中…';
  try {
    const r = await window.api.jmsMfa({
      baseUrl: s.baseUrl, cookie: s.mfaCookie, challengeUrl: s.mfaUrl,
      type: s.mfaType, code, username: s.account, password: s.password,
    });
    if (!r.ok) {
      showJmsMsg(`验证失败: ${r.error}`);
      els.jmsLoginBtn.disabled = false;
      els.jmsLoginBtn.textContent = '验证并登录';
      els.jmsOtp.select();
      return;
    }
    s.token = r.token; s.user = r.user; s.mfaCookie = null; s.mfaUrl = null;
    els.jmsOtpWrap.style.display = 'none';
    els.jmsOtp.value = '';
    els.jmsLoginBtn.disabled = false;
    els.jmsLoginBtn.textContent = '连接 JumpServer';
    jmsPersistConfig();
    jmsRenderServerSelect();
    await jmsLoadAssets();
  } catch (e) {
    showJmsMsg('验证异常: ' + ((e && e.message) || '未知错误'));
    els.jmsLoginBtn.disabled = false;
    els.jmsLoginBtn.textContent = '验证并登录'; // 异常也要复位按钮
  }
}

async function jmsLoadAssets() {
  const s = jmsActive();
  if (!s || !s.token) return;
  const r = await window.api.jmsAssets({ baseUrl: s.baseUrl, token: s.token });
  if (!r.ok) { showJmsMsg(`拉取资产失败: ${r.error}`); return; }
  s.assets = r.assets || [];
  els.jmsModal.classList.add('hidden'); // 登录成功 → 资产整合进会话列表
  jmsPersistConfig();
  jmsRenderServerSelect();
  renderSessionList(els.inputSessionSearch.value);
}

async function jmsRefreshActive() {
  const s = jmsActive();
  if (!s || !s.token) return;
  const r = await window.api.jmsAssets({ baseUrl: s.baseUrl, token: s.token });
  if (!r.ok) { showJmsMsg(`刷新失败: ${r.error}`); return; }
  s.assets = r.assets || [];
  renderSessionList(els.inputSessionSearch.value);
}

function jmsLogout() {
  const s = jmsActive();
  if (!s) return;
  s.token = null; s.user = null; s.assets = [];
  s.loggedOut = true; // 标记已退出:重启后不自动重登
  jmsPersistConfig();
  jmsRenderServerSelect();
  renderSessionList(els.inputSessionSearch.value);
  jmsWebLogoutServer(s); // 同步退出右侧 webview 的网页登录态
}

// 连接资产(经 KoKo 网关):用户名 = JMS用户@协议@账号@资产地址
// accountName 可选:多账号时指定;不传用第一个
function jmsConnect(serverId, asset, accountName, openSftp) {
  const s = jmsFind(serverId);
  if (!s || !s.user || !s.token) { alert('请先登录该 JumpServer'); return; }
  const protocol = (asset.protocols && asset.protocols[0] && asset.protocols[0].name) || 'ssh';
  const account = accountName || (asset.accounts && asset.accounts[0] && asset.accounts[0].username) || 'root';
  const username = `${s.user.username}@${protocol}@${account}@${asset.address}`;
  const session = {
    id: `jms-${++state.jmsSeq}`,
    name: asset.name,
    host: s.sshHost,
    port: s.sshPort || 2222,
    username,
    password: s.password,
    encoding: 'utf8',
    tag_color: '',
    // 标记来源:供会话列表按资产「断开连接」
    jmsKey: `${s.id}|${asset.address}|${account}`,
    // 真实目标主机(资产地址):host/port 是堡垒机网关,同堡垒机所有资产都一样,
    // SFTP/标签展示用它区分是哪台主机(否则两台堡垒主机分不清 SFTP 是谁的)
    displayHost: asset.address || asset.ip || '',
    displayPort: (asset.protocols && asset.protocols[0] && asset.protocols[0].port) || 22,
  };
  connectToServer(session);
  if (openSftp) setTimeout(() => toggleSftpPanel(), 800);
}

// 断开该 JumpServer 资产已打开的连接(标签保留,显示"已断开")
function jmsDisconnectAsset(serverId, asset, accountName) {
  const prefix = `${serverId}|${asset.address}|`;
  let n = 0;
  for (const t of state.tabs.values()) {
    if (t.session && t.session.jmsKey && t.session.jmsKey.startsWith(prefix) &&
        (!accountName || t.session.jmsKey === prefix + accountName)) {
      if (t.status === 'connected' || t.status === 'connecting') { disconnectTab(t.sessionId); n++; }
    }
  }
  setStatus(n ? `已断开「${asset.name}」的连接` : `「${asset.name}」无进行中的连接`, n ? 'var(--green)' : 'var(--orange)');
}

// =====================================================================
// JumpServer 网页版文件管理:webview 打开 JMS,自动登录,进入资产节点连接对话框选 SFTP 方式
// =====================================================================
const jmsWebSleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 在堡垒机 webview 里执行 JS;executeJavaScript 可能长期不 settle(页面导航中),加超时兜底防挂死
function jmsWebExec(expr, timeout = 8000) {
  const wv = els.bastionWebview;
  if (!wv || !wv.executeJavaScript) return Promise.resolve(null);
  return Promise.race([
    wv.executeJavaScript(expr).then((r) => (r === undefined ? null : r)).catch(() => null),
    new Promise((r) => setTimeout(() => r(null), timeout))
  ]);
}
function jmsWebUrl() {
  try { return els.bastionWebview.getURL && els.bastionWebview.getURL() ? els.bastionWebview.getURL() : ''; } catch { return ''; }
}

// 导航 webview 到 url,等待到达同一 origin(最多 ~15s);页面是否加载完由后续轮询兜底
function jmsWebGo(url) {
  return new Promise((resolve) => {
    try { els.bastionWebview.src = url; } catch { /* ignore */ }
    const origin = url.replace(/^https?:\/\//, '').split('/')[0];
    const t0 = Date.now();
    const poll = setInterval(() => {
      const cur = jmsWebUrl();
      const curHost = cur.replace(/^https?:\/\//, '').split('/')[0];
      if (curHost === origin) { clearInterval(poll); resolve(); }
      else if (Date.now() - t0 > 15000) { clearInterval(poll); resolve(); }
    }, 200);
  });
}

// 确保 webview 已登录 JMS:登录页则填账号密码并提交;MFA 账号提交后停手等用户在页面里输验证码
async function jmsWebEnsureLogin(s, base) {
  // 等 webview 初始化(executeJavaScript 就绪 = 已 attach;真实 URL 加载后 ~0.5s 内可用)
  const t0 = Date.now();
  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (await jmsWebExec(`1`) === 1) { ready = true; break; }
    if (Date.now() - t0 > 20000) break;
    await jmsWebSleep(500);
  }
  if (!ready) return false;
  // 轮询到已登录(资产树出现),最长 60s;期间若停在登录页则填账号密码并提交(MFA 账号提交后停在验证码页,等用户手输)
  const t1 = Date.now();
  let submitted = false;
  for (let i = 0; i < 120; i++) {
    // 用 pathname 判断是否已到 Luna 资产页(登录页 URL 带 next=/luna/ 会误命中 href 里的 /luna)
    const path = await jmsWebExec(`location.pathname`);
    const tree = await jmsWebExec(`document.querySelectorAll('span.node_name').length`);
    if ((path || '').indexOf('/luna') === 0 || (tree || 0) > 0) return true;
    // 登录页:自动填账号密码并提交(页面未就绪时每次重试,直到提交成功或超时)
    // JMS 登录表单:密码是双字段 —— #password(可见,type=password,无 name)+ #password-hidden(name=password),
    // 表单真正提交后者;故两个都要填,并点「登录」按钮走页面 JS 登录逻辑
    if (!submitted && (s.account || s.password)) {
      const r = await jmsWebExec(`(function(){
        const u = document.getElementById('id_username') || document.querySelector('input[name="username"], input[type=text]');
        const pws = [...document.querySelectorAll('input[name="password"], input[type=password]')];
        if (!pws.length && !u) return 'no-form';
        if (u) { u.value = ${JSON.stringify(s.account || '')}; u.dispatchEvent(new Event('input', {bubbles:true})); }
        for (const p of pws) { p.value = ${JSON.stringify(s.password || '')}; p.dispatchEvent(new Event('input', {bubbles:true})); }
        const btn = [...document.querySelectorAll('button, input[type=submit]')].find((x) => /登录|login/i.test((x.textContent || x.value || '').trim()));
        if (btn) { try { btn.click(); return 'submitted'; } catch(e) { return 'fail'; } }
        const f = document.querySelector('#login-form') || document.querySelector('#form_login') || document.querySelector('form');
        if (f) { try { f.submit(); return 'submitted'; } catch(e) { return 'fail'; } }
        return 'no-form';
      })()`);
      if (r === 'submitted') submitted = true;
    }
    if (Date.now() - t1 > 60000) break;
    await jmsWebSleep(500);
  }
  return false;
}


// 把已登录服务器的资产渲染进会话列表(JumpServer 区块)
// 会话列表"工具区"节点头:小三角折叠/展开 + 右键菜单(与分组头行为一致)
function makeSectionHead(label, collapsed, onToggle, menuItems) {
  const head = document.createElement('div');
  head.className = 'asset-group-head jms-head';
  const caret = document.createElement('span');
  caret.className = 'asset-group-caret';
  caret.textContent = collapsed ? '▶' : '▼';
  const name = document.createElement('span');
  name.className = 'asset-group-name';
  name.textContent = label;
  head.appendChild(caret);
  head.appendChild(name);
  caret.addEventListener('click', (e) => { e.stopPropagation(); onToggle(); });
  // 无菜单项(如纯分组头)时绑定右键 = 弹空白菜单,表现为"一闪而过的空菜单"、
  // 日志里 `MENU open: `(空)刷屏。只在有菜单项时才注册 contextmenu。
  if (menuItems && menuItems.length) {
    head.addEventListener('contextmenu', (e) => { e.preventDefault(); showCtxMenu(e.clientX, e.clientY, menuItems); });
  }
  return head;
}

// 批量打开连接:依次连接一组 JMS 资产(走 KoKo 网关,300ms 错峰避免压网关)
function batchJmsConnect(s, assets) {
  if (!s || !s.user || !s.token) { alert('请先登录该 JumpServer'); return; }
  const list = (assets || []).filter(Boolean);
  if (!list.length) return;
  setStatus(`批量连接「${s.name}」${list.length} 台…`, 'var(--accent)');
  list.forEach((a, i) => setTimeout(() => jmsConnect(s.id, a), i * 300));
}

// 批量打开连接:依次连接一组 H3C 资产(走 accessclient,500ms 错峰)
function batchBastionConnect(assets) {
  const list = (assets || []).filter(Boolean);
  if (!list.length) return;
  if (!els.bastionWebview || !els.bastionWebview.src) { alert('请先在堡垒机浏览器打开 H3C 控制台并登录'); openBastionPanel(); return; }
  setStatus(`批量连接 H3C 资产 ${list.length} 台…`, 'var(--accent)');
  list.forEach((a, i) => setTimeout(() => bastionConnect(a), i * 500));
}

// 批量打开连接:依次连接一组「已保存堡垒机连接」的资产(未登录先自动登录)
async function batchSavedAssetConnect(s, assets) {
  const list = (assets || []).filter(Boolean);
  if (!list.length) return;
  if (!s.user || !s.token) {
    setStatus(`正在登录「${s.name}」…`, 'var(--accent)');
    try {
      const pw = await decryptSecret(s.password || '');
      if (!s.account || !pw) { alert(`「${s.name}」未配置账号密码,无法登录`); return; }
      const lg = await window.api.jmsLogin({ baseUrl: s.url, username: s.account, password: pw });
      if (!lg.ok || !lg.token) { alert(`登录「${s.name}」失败: ${lg.error || '未知错误'}`); return; }
      s.token = lg.token; s.user = lg.user;
    } catch (e) { alert(`登录「${s.name}」失败: ${e.message}`); return; }
  }
  setStatus(`批量连接「${s.name}」${list.length} 台…`, 'var(--accent)');
  list.forEach((a, i) => setTimeout(() => bastionConnectAsset(s, a), i * 300));
}

function renderJmsInSessionList(container, f) {
  // 显示全部已配置的 JMS 服务器:未登录的也显示(标记「未登录」,右键可登录/编辑/删除)
  const servers = state.jmsServers.filter((s) => s.baseUrl);
  if (!servers.length) return;
  const kw = (f || '').toLowerCase();
  for (const s of servers) {
    const loggedIn = !!(s.token && s.user);
    const allAssets = s.assets || [];
    // 搜索:按 名称/IP/账号 过滤 JMS 资产;空搜索 = 全显示;空格分隔多关键词
    const list = allAssets.filter((a) => bastionAssetMatch(a, kw));
    const nameHit = !kw || (s.name || '').toLowerCase().includes(kw);
    if (kw && !nameHit && (!loggedIn || !list.length)) continue;
    const collapsed = state.collapsedJms.has(s.id);
    const label = loggedIn ? `🛡 ${s.name}(${list.length}${kw ? '/' + allAssets.length : ''})` : `🛡 ${s.name} ·未登录`;
    const menu = loggedIn
      ? [
          { label: '🔗 批量连接全部', action: () => batchJmsConnect(s, list) },
          { label: '✏️ 编辑服务器', action: () => jmsEditServer(s.id) },
          { label: '🔄 刷新资产', action: () => jmsRefreshServer(s.id) },
          { label: '🗑 删除服务器', danger: true, action: () => jmsDeleteServerCompletely(s.id) },
          { label: '🚪 退出登录', danger: true, action: () => jmsLogoutServer(s.id) },
        ]
      : [
          { label: '🔗 登录(拉取资产)', action: () => jmsRefreshServer(s.id) },
          { label: '✏️ 编辑服务器', action: () => jmsEditServer(s.id) },
          { label: '🗑 删除服务器', danger: true, action: () => jmsDeleteServerCompletely(s.id) },
        ];
    container.appendChild(makeSectionHead(label, collapsed,
      () => { collapsed ? state.collapsedJms.delete(s.id) : state.collapsedJms.add(s.id); renderSessionList(els.inputSessionSearch.value); },
      menu));
    if (collapsed || !loggedIn || !list.length) continue;
    if (kw) {
      // 搜索:平铺匹配项
      for (const a of list) container.appendChild(makeJmsAssetRow(s, a));
      continue;
    }
    // 空搜索:按 JumpServer 节点分组——资产可能挂在多个节点下(如生产三+堡垒机),
    // 在它所属的每个分组里都显示;无节点的归「未分组」(只出现一次)。
    const groups = new Map();
    const ungroupedSeen = new Set();
    for (const a of list) {
      const dirs = (a.nodes && a.nodes.length) ? a.nodes.map((n) => n.name).filter(Boolean) : [];
      if (!dirs.length) {
        if (!ungroupedSeen.has(a.id)) {
          if (!groups.has('')) groups.set('', []);
          groups.get('').push(a);
          ungroupedSeen.add(a.id);
        }
        continue;
      }
      for (const dir of dirs) {
        if (!groups.has(dir)) groups.set(dir, []);
        groups.get(dir).push(a);
      }
    }
    const keys = [...groups.keys()].sort((x, y) => {
      if (!x) return 1; if (!y) return -1;
      return x.localeCompare(y, 'zh');
    });
    for (const dir of keys) {
      const arr = groups.get(dir);
      const key = 'jms:' + s.id + ':' + (dir || '__ungrouped__');
      const c2 = state.bastionDirCollapsed.has(key);
      container.appendChild(makeSectionHead(`${dir ? '📁 ' + dir : '🗂 未分组'}(${arr.length})`, c2,
        () => { c2 ? state.bastionDirCollapsed.delete(key) : state.bastionDirCollapsed.add(key); renderSessionList(els.inputSessionSearch.value); },
        [{ label: '🔗 批量连接', action: () => batchJmsConnect(s, arr) }]));
      if (c2) continue;
      for (const a of arr) container.appendChild(makeJmsAssetRow(s, a));
    }
  }
}

function makeJmsAssetRow(s, a) {
  const item = document.createElement('div');
  item.className = 'asset-item jms-asset-item';
  item.title = `双击连 SSH → ${a.address}`;
  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.textContent = '🖥';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = a.name;
  const addr = document.createElement('span');
  addr.className = 'addr jms-a-addr';
  addr.textContent = a.address;
  item.appendChild(icon);
  item.appendChild(name);
  item.appendChild(addr);
  item.addEventListener('dblclick', () => jmsConnect(s.id, a));
  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const items = [{ label: `🔗 连接 SSH(${s.name})`, action: () => jmsConnect(s.id, a) }];
    const accts = (a.accounts || []).map((x) => x.username).filter(Boolean);
    if (accts.length > 1) {
      items.push({ label: '账号', separatorLabel: true });
      for (const un of accts) items.push({ label: `🔑 ${un}`, action: () => jmsConnect(s.id, a, un) });
      items.push({ separator: true });
      for (const un of accts) items.push({ label: `🔌 断开 ${un}`, action: () => jmsDisconnectAsset(s.id, a, un) });
    }
    items.push({ separator: true });
    items.push({ label: '🔌 断开连接', action: () => jmsDisconnectAsset(s.id, a) });
    items.push({ separator: true });
    items.push({ label: `🔄 刷新「${s.name}」资产`, action: () => jmsRefreshServer(s.id) });
    items.push({ label: `🗑 删除「${s.name}」服务器`, danger: true, action: () => jmsDeleteServerCompletely(s.id) });
    items.push({ label: `🚪 退出「${s.name}」登录`, danger: true, action: () => jmsLogoutServer(s.id) });
    showCtxMenu(e.clientX, e.clientY, items);
  });
  return item;
}

async function jmsRefreshServer(serverId) {
  const s = jmsFind(serverId);
  if (!s) return;
  setStatus(`刷新「${s.name}」资产…`, 'var(--accent)');
  let r = s.token ? await window.api.jmsAssets({ baseUrl: s.baseUrl, token: s.token }) : { ok: false };
  // token 失效/未登录 → 用保存的密码静默重登后再拉(否则刷新会静默失败,用户以为没生效)
  if (!r.ok && s.password) {
    try {
      const lg = await window.api.jmsLogin({ baseUrl: s.baseUrl, username: s.account, password: s.password });
      if (lg.ok && lg.token) { s.token = lg.token; s.user = lg.user; r = await window.api.jmsAssets({ baseUrl: s.baseUrl, token: s.token }); }
    } catch { /* 重登失败走下方报错 */ }
  }
  if (r.ok) {
    s.assets = r.assets || [];
    renderSessionList(els.inputSessionSearch.value);
    setStatus(`已刷新「${s.name}」资产(${s.assets.length} 台)`, 'var(--green)');
  } else {
    setStatus(`刷新「${s.name}」失败:${r.error || '未登录'}(请退出重登)`, 'var(--red)');
  }
}

function jmsLogoutServer(serverId) {
  const s = jmsFind(serverId);
  if (!s) return;
  // 退出登录:断开该服务器所有已连接会话 + 清登录态 + 标记"已退出"
  // (标记持久化:否则 app 重启后 jmsRestore 会用保存的密码静默重登,
  //  表现就是"退出登录后还是存在"。配置保留,想再用需手动重新登录)
  for (const t of state.tabs.values()) {
    if (t.session && t.session.jmsKey && String(t.session.jmsKey).startsWith(serverId + '|') &&
        (t.status === 'connected' || t.status === 'connecting')) {
      closeTab(t.sessionId);
    }
  }
  s.token = null; s.user = null; s.assets = [];
  s.loggedOut = true; // 已退出:jmsRestore 跳过,不再自动重登
  jmsPersistConfig();
  renderSessionList(els.inputSessionSearch.value);
  // 同步退出右侧 webview 里该堡垒机的网页登录态(否则左侧退出了,右侧浏览器标签还登录着)
  jmsWebLogoutServer(s);
}

// 彻底删除一个 JumpServer 服务器(用户要求:清除保存的信息 + 浏览器信息):
//   1. 断开该服务器所有已连接会话
//   2. 从配置里移除(内存 + localStorage + jms-servers.json 文件)
//   3. 清除该堡垒机站点的浏览器登录态(cookie)+ 持久化资产
function jmsDeleteServerCompletely(serverId) {
  const s = jmsFind(serverId);
  if (!s) return;
  if (!confirm(`彻底删除服务器「${s.name}」吗?\n将清除:保存的配置、该服务器的全部连接、浏览器登录态与资产记录。此操作不可恢复。`)) return;
  // 1. 断开所有已连接会话
  for (const t of state.tabs.values()) {
    if (t.session && t.session.jmsKey && String(t.session.jmsKey).startsWith(serverId + '|') &&
        (t.status === 'connected' || t.status === 'connecting')) {
      closeTab(t.sessionId);
    }
  }
  // 2. 从配置移除
  const base = s.baseUrl || '';
  state.jmsServers = state.jmsServers.filter((x) => x.id !== serverId);
  if (state.jmsActiveId === serverId) state.jmsActiveId = state.jmsServers.length ? state.jmsServers[0].id : null;
  jmsPersistConfig(); // localStorage + jms-servers.json 同步删除
  renderSessionList(els.inputSessionSearch.value);
  // 3. 清除浏览器登录态 + 持久化资产(该站点 origin)
  const origin = (() => { try { return base ? new URL(base).origin : ''; } catch { return ''; } })();
  if (origin) {
    // webview 若正显示该站点 → 清空导航到空白页
    try {
      const cur = jmsWebUrl();
      const curOrigin = (() => { try { return new URL(cur).origin; } catch { return ''; } })();
      if (curOrigin === origin) els.bastionWebview.src = 'about:blank';
    } catch { /* ignore */ }
    // 清 cookie + 清持久化资产
    window.api.jmsWebLogout(origin).catch(() => {});
    if (window.api.bastionDeleteAssets) window.api.bastionDeleteAssets(origin).catch(() => {});
  }
  setStatus(`已彻底删除「${s.name}」及其浏览器信息`, 'var(--green)');
}

// 让右侧 webview 退出指定 JumpServer 的网页登录:
//   1. webview 若正显示该站点 → 导航到 JMS 登出端点(/core/auth/logout/)
//   2. 清除该域名的 cookie(双保险;即使退出端点没跳到,登录态也被清掉)
async function jmsWebLogoutServer(s) {
  try {
    const wv = els.bastionWebview;
    if (!wv || !wv.executeJavaScript) return;
    const base = String(s.baseUrl || '').replace(/\/+$/, '');
    if (!base) return;
    const cur = jmsWebUrl();
    const curOrigin = (() => { try { return new URL(cur).origin; } catch { return ''; } })();
    const baseOrigin = (() => { try { return new URL(base).origin; } catch { return ''; } })();
    // webview 正显示该堡垒机站点 → 先导航到登出页(带完整清理)
    if (curOrigin === baseOrigin) {
      try { wv.src = base + '/core/auth/logout/'; } catch { /* ignore */ }
    }
    // 清该域 cookie(无论 webview 是否显示它,都清掉登录态)
    if (baseOrigin) {
      try { await window.api.jmsWebLogout(baseOrigin); } catch { /* ignore */ }
    }
    dlog('JMS', `已同步退出 webview 登录: ${baseOrigin}`);
  } catch { /* ignore */ }
}

// 启动时恢复:从设置加载服务器配置,对已登录过的服务器静默重登(MFA 账号则等用户手动登录)
async function jmsRestore() {
  if (state.jmsRestoreDone) return;
  state.jmsRestoreDone = true;
  let saved = state.settings.jmsServers || [];
  // 文件备份优先:localStorage 实测偶发丢失 jmsServers,主进程落盘的 jms-servers.json 更可靠
  try {
    const fb = await window.api.jmsRestore();
    if (fb.ok && fb.servers && fb.servers.length) saved = fb.servers;
  } catch { /* 文件读取失败回退 localStorage */ }
  if (!saved.length) return;
  for (const c of saved) {
    let pw = c.password;
    try { if (pw && pw.startsWith('enc:v1:')) pw = (await window.api.cryptoDecrypt(pw)).value || ''; } catch { /* 解密失败保留原值 */ }
    const s = { id: c.id || `jms-server-${++state.jmsSeq}`, name: c.name || 'JumpServer', baseUrl: c.baseUrl, sshHost: c.sshHost, sshPort: c.sshPort || 2222, account: c.account, password: pw, token: null, user: null, assets: [], loggedOut: !!c.loggedOut };
    state.jmsServers.push(s);
    state.jmsActiveId = state.jmsActiveId || s.id;
  }
  jmsRenderServerSelect();
  for (const s of state.jmsServers) {
    // 用户主动退出过登录的服务器:不自动重登(配置保留,需手动登录)
    if (s.loggedOut) continue;
    if (!s.password) continue;
    try {
      const r = await window.api.jmsLogin({ baseUrl: s.baseUrl, username: s.account, password: s.password });
      if (r.ok && r.token) {
        s.token = r.token; s.user = r.user;
        // 恢复登录成功 → 该服务器区块默认折叠(左侧分组收起,展开才看资产)
        state.collapsedJms.add(s.id);
        const ar = await window.api.jmsAssets({ baseUrl: s.baseUrl, token: s.token });
        if (ar.ok) s.assets = ar.assets || [];
      }
      // MFA 账号:静默登录返回 mfa_required,不打扰用户,等手动登录
    } catch { /* 网络/超时,忽略 */ }
  }
  renderSessionList(els.inputSessionSearch.value);
}

// =====================================================================
// 堡垒机客户端:右侧停靠面板 + 内置浏览器登录,拦截 accessclient://,解码后用 Polaris 连 SSH
// =====================================================================
// 面板默认宽度:未手动拖过(无持久化宽度)时默认占屏一半,保证堡垒机完整页面不被右侧遮挡
function applyBastionDefaultWidth() {
  const saved = Number(state.settings.bastionWidth) || 0;
  if (saved >= 300) els.bastionPanel.style.width = `${saved}px`;
  else els.bastionPanel.style.width = `${Math.max(420, Math.round(window.innerWidth * 0.5))}px`;
}
// 会话列表宽度 / SFTP 面板高度:拖动后持久化,启动时恢复(与堡垒机宽度持久化一致)
function applySessionPanelWidth() {
  const saved = Number(state.settings.sessionPanelWidth) || 0;
  if (saved >= 160) els.sessionPanel.style.width = `${saved}px`;
}
function applySftpPanelHeight() {
  const saved = Number(state.settings.sftpPanelHeight) || 0;
  if (saved >= 120) els.sftpPanel.style.height = `${saved}px`;
}
function openBastionPanel() {
  els.bastionSlot.classList.remove('hidden');
  els.bastionMini.classList.add('hidden');
  applyBastionDefaultWidth();
  bastionRenderTabs(); // 渲染堡垒机标签栏
  bastionRenderServerSelect();
  const saved = state.settings.bastionUrl || '';
  if (saved) els.bastionUrl.value = saved;
  // 有已保存堡垒机且无激活标签 → 自动选第一个(像主机连接一样开箱即用)
  if (!bastionActiveTabId && bastionServers().length) {
    bastionSwitchTab(bastionServers()[0].id);
  }
  // 键盘焦点:webview 已加载 → 焦点给 webview(否则点击 guest 页面时,宿主焦点停在地址框,
  // 按键会被地址框吞掉、输入框"打不进去";见 bastion-focus-fix)。空 webview 才聚焦地址框让用户输地址。
  if (!els.bastionWebview.src && saved) loadBastion(saved);
  else if (els.bastionWebview.src) els.bastionWebview.focus();
  else els.bastionUrl.focus();
  refitAll(); // 面板打开后终端区变窄,重排 xterm(否则旧宽度 canvas 外溢盖到面板区)
}
// 渲染堡垒机 web 标签页专属的资产列表:显示当前 web 标签页对应堡垒机(JMS)的资产,
// 双击直接连 SSH(与左侧会话树 JMS 区块一致)。无登录的 JMS 服务器时隐藏侧边栏。
// 头部显示服务器名 + 连接状态;资产行带连接状态点(●绿=该资产有已连接会话)。
// 最小化(收起面板,在会话列表显示入口;webview 会话保留,展开不用重登)
function minimizeBastion() {
  els.bastionSlot.classList.add('hidden');
  updateBastionMini();
  els.bastionMini.classList.remove('hidden');
  refitAll(); // 面板收起后终端区恢复全宽,重排 xterm
}
// 关闭:彻底收起面板,连会话列表里的小入口也不留(与「— 最小化」区分)。
// webview 会话保留,之后用工具栏 🛡 堡垒机 → H3C 重新打开无需重登。
function closeBastionPanel() {
  els.bastionSlot.classList.add('hidden');
  els.bastionMini.classList.add('hidden');
  refitAll(); // 面板收起后终端区恢复全宽,重排 xterm
}
function restoreBastion() { openBastionPanel(); }

// 堡垒机会话 id:accessclient 解码连的用 bastion-*,JumpServer API 资产连的用 jms-*
function isBastionSessionId(id) {
  const s = String(id);
  return s.startsWith('bastion-') || s.startsWith('jms-');
}

// 更新最小化入口:显示从堡垒机连了几台终端
function updateBastionMini() {
  const n = [...state.tabs.values()].filter((t) => t.session && isBastionSessionId(t.session.id)).length;
  els.bastionMini.textContent = n ? `🌐 堡垒机(${n})` : '🌐 堡垒机';
}

// ---- 堡垒机(H3C)配置:保存/管理常用 Web 地址 ----
function bastionServers() { return state.settings.bastionServers || (state.settings.bastionServers = []); }

// 当前激活的堡垒机标签 id(与 bastionServers 的 id 对应;null=手动地址模式)
let bastionActiveTabId = null;

// 渲染堡垒机标签栏:每个已保存堡垒机一个标签
function bastionRenderTabs() {
  const list = els.bastionTabsList;
  if (!list) return;
  list.innerHTML = '';
  for (const s of bastionServers()) {
    const tab = document.createElement('div');
    tab.className = 'bastion-tab' + (s.id === bastionActiveTabId ? ' active' : '');
    tab.title = s.url || s.name;
    const name = document.createElement('span');
    name.textContent = s.name || s.url || '堡垒机';
    tab.appendChild(name);
    // 关闭按钮:移除该堡垒机连接(同时清它的登录态)
    const close = document.createElement('span');
    close.className = 'bt-close';
    close.textContent = '×';
    close.title = '关闭此堡垒机(清除其登录)';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      bastionRemoveTab(s.id);
    });
    tab.appendChild(close);
    // 点标签:切换加载该堡垒机
    tab.addEventListener('click', () => bastionSwitchTab(s.id));
    // 右键:编辑 / 删除该堡垒机连接
    tab.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, [
        { label: '✏️ 编辑连接', action: () => bastionCfgEdit(s.id) },
        { label: '🗑 删除连接', danger: true, action: () => bastionRemoveTab(s.id) },
      ]);
    });
    list.appendChild(tab);
  }
  if (!bastionServers().length) {
    const hint = document.createElement('span');
    hint.className = 'bastion-tab-hint';
    hint.textContent = '点 ⚙ 添加堡垒机站点';
    list.appendChild(hint);
  }
}

// 切换到指定堡垒机标签:填地址并加载(用保存的凭据自动登录)
function bastionSwitchTab(id) {
  const s = bastionServers().find((x) => x.id === id);
  if (!s) return;
  bastionActiveTabId = id;
  els.bastionUrl.value = s.url || '';
  if (s.url) loadBastion(s.url);
  bastionPendingFill = (s.account || s.password) ? s : null; // 加载后自动填充账号密码
  bastionRenderTabs();
}

// 移除一个堡垒机连接:清除其登录态(cookie)+ 关闭标签;若它是当前标签,回退到第一个
async function bastionRemoveTab(id) {
  const s = bastionServers().find((x) => x.id === id);
  bastionServers().splice(bastionServers().findIndex((x) => x.id === id), 1);
  saveSettings();
  // 清除该堡垒机站点的登录态
  if (s && s.url) {
    try {
      const origin = (() => { try { return new URL(s.url).origin; } catch { return ''; } })();
      if (origin) await window.api.jmsWebLogout(origin);
    } catch { /* ignore */ }
  }
  if (bastionActiveTabId === id) {
    bastionActiveTabId = bastionServers().length ? bastionServers()[0].id : null;
    if (bastionActiveTabId) bastionSwitchTab(bastionActiveTabId);
    else { els.bastionWebview.src = 'about:blank'; els.bastionCurrent.textContent = ''; }
  }
  bastionRenderTabs();
  bastionRenderServerSelect();
  renderSessionList(els.inputSessionSearch.value); // 左侧堡垒机分组同步移除
  updateBastionMini();
}

// 渲染地址栏的服务器下拉
// 右侧堡垒机下拉可选的站点:已保存的堡垒机配置 + 左侧创建的 JumpServer 服务器(需求:下拉选左侧信息)
function bastionSelectableServers() {
  const list = [];
  for (const s of bastionServers()) {
    list.push({ id: 'B:' + s.id, name: s.name || s.url, url: s.url, account: s.account, password: s.password, src: 'cfg' });
  }
  for (const j of state.jmsServers) {
    if (!j.baseUrl) continue;
    list.push({ id: 'JMS:' + j.id, name: (j.name || 'JMS') + ' (JMS)', url: j.baseUrl, account: j.account, password: j.password, src: 'jms', jmsId: j.id });
  }
  return list;
}

function bastionRenderServerSelect() {
  const sel = els.bastionServerSelect;
  sel.innerHTML = '';
  // 手动输入地址放最前(默认选中):避免"打开"误用第一个已保存堡垒机,而忽略用户手输的地址
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = '(手动输入地址)';
  sel.appendChild(empty);
  for (const s of bastionSelectableServers()) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    sel.appendChild(opt);
  }
}

// 选择保存的服务器 → 填地址并加载(页面加载完自动填充账号密码)
let bastionPendingFill = null;
function bastionSelectServer(id) {
  const s = bastionSelectableServers().find((x) => x.id === id);
  if (!s) return;
  els.bastionUrl.value = s.url;
  loadBastion(s.url);
  // JMS 服务器用其保存的账号密码自动登录;堡垒机配置同前
  bastionPendingFill = (s.account || s.password) ? { url: s.url, account: s.account, password: s.password } : null;
  closeBastionCfg();
}

// 工具栏「加载」:加载当前选中的已保存堡垒机并自动填充账号密码;无选中则加载地址栏输入的地址
function bastionLoadSelected() {
  const id = els.bastionServerSelect.value;
  if (id) { bastionSelectServer(id); return; }
  const url = els.bastionUrl.value.trim();
  if (url) loadBastion(url);
  else alert('请先选一个已保存的堡垒机,或输入 Web 地址');
}

// 在堡垒机登录页自动填充账号密码(尽力而为:H3C 等浏览器登录)
async function bastionAutoFill(s) {
  const wv = els.bastionWebview;
  if (!wv || !wv.executeJavaScript) return;
  // 存的密码是 safeStorage 密文,填充前先解密(老明文无前缀直接通过)
  const password = await decryptSecret(s.password || '');
  try {
    wv.executeJavaScript(`(function(){
      try {
        const pwList = document.querySelectorAll('input[type=password]');
        if (!pwList.length) return false;
        const pw = pwList[0];
        let user = null;
        const cands = document.querySelectorAll('input[type=text], input:not([type])');
        for (const u of cands) {
          const n = (u.name + ' ' + u.id).toLowerCase();
          if (n.includes('user') || n.includes('account') || n.includes('login')) { user = u; break; }
        }
        if (!user && cands.length) user = cands[0]; // 退而求其次:第一个文本框
        if (user) { user.value = ${JSON.stringify(s.account || '')}; user.dispatchEvent(new Event('input', {bubbles:true})); }
        pw.value = ${JSON.stringify(password || '')};
        pw.dispatchEvent(new Event('input', {bubbles:true}));
        return true;
      } catch(e) { return false; }
    })()`).then((r) => { if (r && r.result && r.result.value) console.log('[堡垒机] 已自动填充账号密码'); }).catch(() => {});
  } catch { /* ignore */ }
}

function openBastionCfg() {
  els.bastionCfgName.value = '';
  els.bastionCfgUrl.value = '';
  els.bastionCfgType.value = 'jms';
  els.bastionCfgAccount.value = '';
  els.bastionCfgPass.value = '';
  delete els.bastionCfgPass.dataset.enc;
  els.bastionCfgPass.placeholder = '密码';
  els.bastionCfgMsg.classList.add('hidden');
  delete els.bastionCfgAdd.dataset.editingId;
  els.bastionCfgAdd.textContent = '＋ 保存堡垒机';
  els.bastionCfgModal.classList.remove('hidden');
}
function closeBastionCfg() { els.bastionCfgModal.classList.add('hidden'); }

// 配置弹窗里的服务器列表已移除(已保存堡垒机连接现在展示在左侧堡垒机分组根目录下)

async function bastionCfgAdd() {
  const name = els.bastionCfgName.value.trim();
  let url = els.bastionCfgUrl.value.trim();
  const account = els.bastionCfgAccount.value.trim();
  let password = els.bastionCfgPass.value;
  // 从"现有堡垒机"选择且密码留空 → 沿用已保存的加密密码
  if (!password && els.bastionCfgPass.dataset.enc) password = els.bastionCfgPass.dataset.enc;
  if (!url) { showBastionCfgMsg('请填 Web 地址'); return; }
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  // 密码 safeStorage 加密落盘(与 JMS 一致;之前明文存 localStorage,任何能读 userData 的进程可窃取)
  const encPw = await encryptSecret(password);
  // 编辑模式:更新现有连接;否则新增
  const editingId = els.bastionCfgAdd.dataset.editingId;
  if (editingId) {
    const s = bastionServers().find((x) => x.id === editingId);
    if (s) {
      s.name = name || url; s.url = url; s.account = account;
      s.type = els.bastionCfgType.value || 'jms';
      if (password) s.password = encPw; // 留空 = 保留原密码
    }
    delete els.bastionCfgAdd.dataset.editingId;
  } else {
    bastionServers().push({ id: `bastion-cfg-${++state.jmsSeq}`, name: name || url, url, account, password: encPw, type: els.bastionCfgType.value || 'jms' });
  }
  state.settings.bastionServers = bastionServers();
  saveSettings();
  bastionRenderServerSelect();
  bastionRenderTabs(); // 标签栏同步新堡垒机
  state.collapsedTopBastion = false; // 展开「🛡 堡垒机」分组,让新建的连接立刻可见
  renderSessionList(els.inputSessionSearch.value); // 左侧堡垒机分组同步显示新连接
  closeBastionCfg(); // 保存后直接关闭弹窗
  // 新增成功即打开右侧浏览器并加载该站点;编辑则回到列表
  if (editingId) {
    setStatus(`已更新堡垒机「${name || url}」`, 'var(--green)');
  } else {
    openBastionPanel();
    bastionSelectServer('B:' + bastionServers()[bastionServers().length - 1].id);
    setStatus(`已保存并打开「${name || url}」`, 'var(--green)');
  }
}
// 编辑堡垒机连接:把该连接填入表单,保存时更新(增删改查的"改")
async function bastionCfgEdit(id) {
  const s = bastionServers().find((x) => x.id === id);
  if (!s) return;
  els.bastionCfgName.value = s.name || '';
  els.bastionCfgUrl.value = s.url || '';
  els.bastionCfgType.value = s.type === 'h3c' ? 'h3c' : 'jms';
  els.bastionCfgAccount.value = s.account || '';
  els.bastionCfgPass.value = '';
  delete els.bastionCfgPass.dataset.enc;
  if (s.password && s.password.startsWith('enc:v1:')) {
    els.bastionCfgPass.placeholder = '已保存密码,留空沿用';
    els.bastionCfgPass.dataset.enc = s.password;
  }
  els.bastionCfgAdd.dataset.editingId = id;
  els.bastionCfgAdd.textContent = '💾 保存修改';
  els.bastionCfgModal.classList.remove('hidden');
  els.bastionCfgMsg.classList.add('hidden');
  els.bastionCfgName.focus();
}
function bastionCfgDelete(id) {
  const s = bastionServers().find((x) => x.id === id);
  state.settings.bastionServers = bastionServers().filter((x) => x.id !== id);
  saveSettings();
  bastionRenderServerSelect();
  // 顺手清掉该堡垒机的持久化资产(重启后不再出现)。删除键与保存键统一用 origin ——
  // 旧版删除用配置 URL、保存用深链接 URL,键对不上导致删了也"复活"。
  if (s && s.url && window.api.bastionDeleteAssets) {
    window.api.bastionDeleteAssets(bastionOrigin(s.url)).catch(() => {});
  }
  // 若删的是当前展示来源,清空内存里的资产与折叠状态
  const cur = state.bastionUrl || '';
  const delOrigin = bastionOrigin(s && s.url);
  if (delOrigin && cur && cur === delOrigin) {
    state.bastionAssets = [];
    state.bastionTree = [];
    state.bastionFavSet = new Set();
    state.bastionFavTree = null;
    state.bastionDirCollapsed.clear();
    state.bastionAllFetched = false;
    renderSessionList(els.inputSessionSearch.value);
  }
  bastionRenderTabs(); // 标签栏同步移除
  if (bastionActiveTabId === s.id) {
    bastionActiveTabId = bastionServers().length ? bastionServers()[0].id : null;
    if (bastionActiveTabId) bastionSwitchTab(bastionActiveTabId);
  }
}
function showBastionCfgMsg(text) {
  els.bastionCfgMsg.textContent = text;
  els.bastionCfgMsg.classList.toggle('hidden', !text);
}

// ---- H3C 堡垒机资产捕获:在 webview 里钩住资产 API(fetch/XHR),把响应存到 window.__bastionAssets ----
function injectBastionAssetHook(requireStable) {
  const wv = els.bastionWebview;
  if (!wv || !wv.executeJavaScript) return;
  if (bastionWebviewLoading()) return; // 加载中不注入(executeJavaScript 会失败)
  // 轮询路径(requireStable=true 默认):要求页面稳定 2s 再注入,避免导航风暴中帧层面报错;
  // did-stop-loading 的 debounce 路径传 false:debounce(800ms)本身就是稳定等待,不再二次卡 2s
  if (requireStable !== false && !bastionPageStable(2000)) return;
  try {
    wv.executeJavaScript(`(function(){
      try {
      if (window.__bastionHookInjected) return;
      window.__bastionHookInjected = true;
      window.__bastionAssets = [];
      window.__bastionDiag = [{ ts: Date.now(), ev: 'hook-injected' }];
      // 键盘焦点桥:记录"用户最后交互发生在 guest"的时间戳(click 时 webview guest 的
      // focus/focusin 事件被 Chromium 抑制、不发;pointerdown/mousedown 正常)。宿主用它
      // 判断该把键盘焦点补到 webview 元素上,否则按键会被宿主当前焦点(如地址框)吞掉。
      window.__bastionFocusTs = 0;
      // 只记录"用户真实交互"(isTrusted=true):脚本/SPA 自动请求触发的模拟
      // pointerdown/mousedown(isTrusted=false)会持续刷新时间戳 → 宿主误以为用户
      // 一直在操作 guest → 每 500ms 抢焦点(假 blur/焦点被吞)。真实用户点击才更新。
      ['pointerdown', 'mousedown'].forEach(function (ev) {
        document.addEventListener(ev, function (e) { if (e && e.isTrusted) window.__bastionFocusTs = Date.now(); }, true);
      });
      function parseDevs(j) {
        var out = [];
        try {
          if (j.content) { // getAccessViewDevs / getFavoriteDevices: { content:[{ id, dev:{id,name,ip,services,accounts}, recent:{account} }] }
            out = j.content.map(function(c){
              var d = c.dev || {};
              var srv = (d.services && d.services.services) || {};
              var accts = ((d.accounts && d.accounts.accounts) || []).map(function(a){ return a.name; }).filter(Boolean);
              return {
                name: d.name || c.name,
                ip: d.ip || '',
                id: d.id || c.id || '',
                devId: String(d.id != null ? d.id : c.id || ''),
                port: (srv.ssh && srv.ssh.port) || 22,
                proto: srv.ssh ? 'ssh' : (srv.sftp ? 'sftp' : 'ssh'),
                accounts: accts,
                recentAccount: (c.recent && c.recent.account) || '',
                favorite: false, dir: '', dirs: []
              };
            }).filter(function(d){ return d.name; });
          } else if (j.children) { // 树结构:递归收集设备(有 ip 的节点)
            (function walk(nodes){
              for (var i = 0; i < (nodes || []).length; i++) {
                var n = nodes[i];
                if (n.ip) out.push({ name: n.name, ip: n.ip, id: n.id, devId: String(n.id != null ? n.id : ''), port: 22, proto: 'ssh', accounts: [], recentAccount: '', favorite: false, dir: '', dirs: [] });
                if (n.children) walk(n.children);
              }
            })(j.children);
          }
        } catch (e) {}
        return out;
      }
      // 合并进 __bastionAssets:按 devId 去重(保留已有 dir/收藏标记,新数据覆盖)
      function mergeDevs(list) {
        var prev = window.__bastionAssets || [];
        var map = new Map(prev.map(function(d){ return [d.devId || d.name + d.ip, d]; }));
        (list || []).forEach(function(d){
          var k = d.devId || d.name + d.ip;
          var old = map.get(k);
          if (old && old.dir && !d.dir) d.dir = old.dir;
          if (old && old.dirs && old.dirs.length && (!d.dirs || !d.dirs.length)) d.dirs = old.dirs;
          if (old && old.dirPath && !d.dirPath) d.dirPath = old.dirPath;
          // 保留旧 favGroup 前先剔除历史脏数据("undefinedxxx" 是早期版本映射 bug 产物),
          // 否则合并时会把残留的坏分组一直带下去;干净的 favGroup 正常保留
          if (old && old.favGroup && !d.favGroup && old.favGroup.indexOf('undefined') !== 0) d.favGroup = old.favGroup;
          if (old && old.favorite) d.favorite = true;
          map.set(k, d);
        });
        window.__bastionAssets = Array.from(map.values());
      }
      function capture(url, text, body) {
        if (!url || !text) return;
        const matched = /getAccessViewDevs|getFavoriteDevices|getAccessViewTree|userFav\\/getTree/.test(url);
        // 兜底:所有"像资产请求"的 URL 都记录(判断真实 API 名是否与代码假设不同)
        const broad = /accessView|device|tree|asset|host|group|fav/i.test(url);
        if (!matched && !broad) return;
        const rec = { ts: Date.now(), url: String(url).slice(0, 250), len: text.length, matched };
        let j = null;
        try { j = JSON.parse(text); } catch (e) {}
        if (j && typeof j === 'object') {
          const page = {};
          ['total','totalCount','count','pageSize','pageNum','pageNo','page','size','current','pages','records']
            .forEach(function(k){ if (k in j) page[k] = j[k]; });
          if (Object.keys(page).length) rec.page = page;
          rec.devs = Array.isArray(j.content) ? j.content.length
            : (j.children ? (function countIp(ns){ var c2 = 0; (ns || []).forEach(function(n){ if (n.ip) c2++; if (n.children) c2 += countIp(n.children); }); return c2; })(j.children) : -1);
        }
        rec.preview = String(text).slice(0, 300);
        const diag = window.__bastionDiag || [];
        diag.push(rec);
        if (diag.length > 200) diag.shift();
        window.__bastionDiag = diag;
        if (!matched || !j) return; // 没匹配到已知资产 API:只记录(供判断真实接口名),不并入资产
        // 目录树:getAccessViewTree → 存树结构(分组展示 + 逐目录请求用)
        if (/getAccessViewTree/.test(url) && j.children) { window.__bastionTree = j.children; return; }
        // 收藏夹树:userFav/getTree → {name, children:[{name,...}]}
        if (/userFav\\/getTree/.test(url) && (j.children || j.name)) { window.__bastionFavTree = j; return; }
        // 分页拉全量:H3C 前端默认只请求 page=0(size=20),totalPages>1 时按原请求体主动翻页补齐
        // (真实堡垒机 totalElements=870 / 44 页,只捕获第 0 页 20 台 = "资产不完整"根因)
        // 仅 getAccessViewDevs 触发;收藏接口一次 100 条,不翻页
        if (/getAccessViewDevs/.test(url) && j.last === false && Array.isArray(j.content) && j.totalPages && j.totalPages > 1 && !window.__bastionAllLoading) {
          window.__bastionAllLoading = true;
          window.__bastionFetchedPages = window.__bastionFetchedPages || {};
          let pb = null;
          try { pb = body ? JSON.parse(body) : null; } catch (e) {}
          const tp = j.totalPages;
          const size = (pb && pb.size) || 20;
          const baseUrl = url.split('?')[0];
          const pathsKey = (pb && pb.paths && pb.paths.join(',')) || '';
          // 递归串行翻页(一次只发一个请求,完成后隔 150ms 发下一页,避免 44 并发打爆堡垒机)
          (function fetchPage(pg) {
            if (pg >= tp) { window.__bastionAllLoading = false; return; }
            const key = pathsKey + '|p' + pg;
            const next = () => setTimeout(() => fetchPage(pg + 1), 150);
            if (window.__bastionFetchedPages[key]) { next(); return; }
            window.__bastionFetchedPages[key] = true;
            try {
              const nb = pb ? JSON.parse(body) : { page: pg, size: size };
              nb.page = pg;
              window.fetch(baseUrl + '?page=' + pg + '&size=' + size, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(nb),
              }).then(next).catch(next);
            } catch (e) { next(); }
          })(1);
        }
        // 解析并合并设备
        const devs = parseDevs(j);
        if (/getFavoriteDevices/.test(url)) {
          devs.forEach(function(d){ d.favorite = true; });
          const favs = window.__bastionFavSet || (window.__bastionFavSet = new Set());
          devs.forEach(function(d){ if (d.devId) favs.add(d.devId); });
        }
        if (devs.length) mergeDevs(devs);
      }
      // 钩 XMLHttpRequest
      const oOpen = XMLHttpRequest.prototype.open;
      const oSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(m, u) { this.__u = u; return oOpen.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function() {
        try { this.__body = arguments[0]; this.addEventListener('load', function(){ capture(this.__u, this.responseText, this.__body); }); } catch(e) {}
        return oSend.apply(this, arguments);
      };
      // 钩 fetch(保存原始 fetch,翻页请求也用被 hook 的 window.fetch,响应自动走 capture 合并+记录)
      const oFetch = window.fetch;
      window.fetch = function() {
        const _init = arguments[1] || {};
        return oFetch.apply(this, arguments).then(function(r){
          try { r.clone().text().then(function(t){ capture(r.url, t, _init.body || ''); }); } catch(e) {}
          return r;
        });
      };
      // ---- 主动拉全量(宿主触发,不依赖前端 UI 行为;失败单页重试 2 次,串行 150ms 防压垮堡垒机) ----
      window.__bastionFetchState = { running: false, dirRunning: false, favRunning: false };
      function bdelay(ms){ return new Promise(function(res){ setTimeout(res, ms); }); }
      // 网络层用 XHR 而非 window.fetch:SPA 前端框架可能覆盖 window.fetch
      // (注入的 fetch 钩子会因此失效),XHR 我们只加捕获监听、不改行为,最可靠。
      // XHR 发出的请求同样会被钩子捕获(capture 合并资产),与 fetch 版等效。
      function bxhr(method, url, bodyStr) {
        return new Promise(function(resolve, reject) {
          try {
            var x = new XMLHttpRequest();
            x.open(method, url, true);
            if (bodyStr !== undefined) x.setRequestHeader('Content-Type', 'application/json');
            x.onload = function() { resolve(x.responseText || ''); };
            x.onerror = function() { reject(new Error('XHR 请求失败: ' + url)); };
            x.send(bodyStr);
          } catch (e) { reject(e); }
        });
      }
      function bget(url, init, retries) {
        retries = retries || 0;
        var method = (init && init.method) || 'GET';
        var body = (init && init.body) !== undefined ? (init && init.body) : undefined;
        return bxhr(method, url, body).catch(function(err){
          if (retries < 2) return bget(url, init, retries + 1);
          throw err;
        });
      }
      window.__bastionFetchAll = function() {
        if (window.__bastionFetchState.running) return Promise.resolve(false);
        window.__bastionFetchState.running = true;
        window.__bastionAllLoading = true;
        (window.__bastionDiag = window.__bastionDiag || []).push({ ts: Date.now(), ev: 'full-fetch-start' });
        function fetchRootDevs(rootName, page) {
          page = page || 0;
          var size = 100;
          var body = JSON.stringify({ page: page, size: size, sort: 'name,asc', stateIn: '0', paths: [rootName] });
          return bget('/shterm/api/asset/getAccessViewDevs?page=' + page + '&size=' + size, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: body
          }).then(function(t){
            var j = null; try { j = JSON.parse(t); } catch (e) {}
            if (!j || !j.content) return true; // 该页失败:跳过(已有结果保留,不阻塞整体)
            if (j.last === false && j.totalPages && page + 1 < j.totalPages) {
              return bdelay(150).then(function(){ return fetchRootDevs(rootName, page + 1); });
            }
            return true;
          }).catch(function(){ return true; }); // M2:单页彻底失败(重试后仍挂)也继续后续 root/收藏,不中止整链
        }
        return bget('/shterm/api/asset/getAccessViewTree', { method: 'GET' }).then(function(t){
          var j = null; try { j = JSON.parse(t); } catch (e) {}
          if (!j || !j.children) { window.__bastionFetchState.running = false; window.__bastionAllLoading = false; return false; }
          window.__bastionTree = j.children;
          var roots = {};
          (function walk(ns){ (ns || []).forEach(function(n){ roots[(n.path && n.path[0]) || n.name] = 1; walk(n.children); }); })(j.children);
          var rootNames = Object.keys(roots);
          var p = Promise.resolve();
          rootNames.forEach(function(rn){ p = p.then(function(){ return fetchRootDevs(rn); }); });
          return p.then(function(){
            // 收藏设备主动拉一次(真实接口是 PUT + body {favId:null},不是 GET ——
            // 用 GET 会被拒/返回空,收藏永远拉不到;来自 10.204.240.4-5.har 实测)
            var favBody = JSON.stringify({ page: 0, size: 100, favId: null });
            return bget('/shterm/api/asset/getFavoriteDevices?page=0&size=100&sort=dev.name,asc', { method: 'PUT', body: favBody }).catch(function(){ return ''; });
          }).then(function(){
            // 收藏夹树(userFav/getTree)主动拉一次,前端不一定每次都会发;结果存下来供收藏分组映射
            return bget('/shterm/api/userFav/getTree', { method: 'GET' }).then(function(t){
              var j = null; try { j = JSON.parse(t); } catch (e) {}
              if (j && (j.children || j.name)) window.__bastionFavTree = j;
              return t;
            }).catch(function(){ return ''; });
          }).then(function(){
            (window.__bastionDiag = window.__bastionDiag || []).push({ ts: Date.now(), ev: 'full-fetch-done' });
            window.__bastionFetchState.running = false;
            window.__bastionAllLoading = false;
            return true;
          });
        }).catch(function(){ window.__bastionFetchState.running = false; window.__bastionAllLoading = false; return false; });
      };
      // ---- 后台按目录补充分组(串行 + 120ms 间隔渐进式,避免打爆堡垒机;树节点 empty=true 跳过) ----
      // 设备响应本身不带"所属业务目录",只能逐目录请求;结果渐进合并,完成前资产显示在"未分组"。
      window.__bastionFetchDirs = function() {
        if (window.__bastionFetchState.dirRunning) return Promise.resolve(false);
        var tree = window.__bastionTree || [];
        var dirs = [];
        // path.length >= 2 才算目录(根节点 path=[根] 只有 1 段,不是目录)
        (function walk(ns){ (ns || []).forEach(function(n){ if (n.path && n.path.length >= 2 && !n.empty) dirs.push(n); walk(n.children); }); })(tree);
        if (!dirs.length) return Promise.resolve(false);
        window.__bastionFetchState.dirRunning = true;
        (window.__bastionDiag = window.__bastionDiag || []).push({ ts: Date.now(), ev: 'dir-fetch-start', dirs: dirs.length });
        var idx = 0, done = 0;
        // 单个目录翻页拉全(M3:>100 台的目录旧版只拉 page0 会永久缺分组)
        function fetchDirPages(n, page) {
          page = page || 0;
          var body = JSON.stringify({ page: page, size: 100, sort: 'name,asc', stateIn: '0', paths: n.path });
          return bxhr('PUT', '/shterm/api/asset/getAccessViewDevs?page=' + page + '&size=100', body).then(function(t){
            var j = null; try { j = JSON.parse(t); } catch (e) {}
            if (j && j.content) {
              var ids = {};
              var prev = window.__bastionAssets || [];
              var map = new Map(prev.map(function(x){ return [x.devId || x.name + x.ip, x]; }));
              var newDevs = []; // 目录查询返回、但资产集缺失的设备(扁平根查询可能漏掉只在子目录的设备)
              j.content.forEach(function(c){
                var d = c.dev || {};
                // devId 为空时用 name+ip 兜底,否则多台无 id 设备互相覆盖/无法归组
                var key = String(d.id != null ? d.id : c.id || (d.name + d.ip));
                if (key) {
                  ids[key] = 1;
                  if (!map.has(key)) newDevs.push({ name: d.name || c.name, ip: d.ip || '', devId: key, port: 22, proto: 'ssh', accounts: [], recentAccount: (c.recent && c.recent.account) || '', favorite: false, dir: '', dirs: [] });
                }
              });
              map.forEach(function(x){
                var k = x.devId || x.name + x.ip;
                if (ids[k]) {
                  // 一台设备可属多个业务目录(H3C 目录树是重叠的):全部记录到 dirs,
                  // 左侧按 dirs 分组展示与网页一致;dir 保留最后一个匹配的作主目录。
                  if (!x.dirs) x.dirs = [];
                  if (x.dirs.indexOf(n.name) === -1) x.dirs.push(n.name);
                  x.dir = n.name; x.dirPath = n.path;
                }
              });
              // 把缺失设备补进资产集并归入本目录(不依赖扁平根查询覆盖全部设备)
              newDevs.forEach(function(nd){
                if (!map.has(nd.devId)) { nd.dirs = [n.name]; nd.dir = n.name; nd.dirPath = n.path; map.set(nd.devId, nd); }
              });
              window.__bastionAssets = Array.from(map.values());
              done += Object.keys(ids).length;
            }
            if (j && j.last === false && j.totalPages && page + 1 < j.totalPages) {
              return bdelay(120).then(function(){ return fetchDirPages(n, page + 1); });
            }
            return true;
          }).catch(function(){ return true; }); // 该目录失败:跳过,不阻塞其他目录
        }
        function one() {
          if (idx >= dirs.length) {
            // 目录补充完成:仍未分配到任何子目录的设备 = 根级设备(直接在业务根下),
            // 归到业务根,避免落进「未分组」与浏览器不一致。
            var rootsSeen = [];
            (function collectRoots(ns){ (ns || []).forEach(function(n){
              if (n.path && n.path[0] && rootsSeen.indexOf(n.path[0]) === -1) rootsSeen.push(n.path[0]);
              collectRoots(n.children);
            }); })(window.__bastionTree || []);
            var rn = rootsSeen[0] || '';
            if (rn) {
              (window.__bastionAssets || []).forEach(function(x){
                if (!x.dir && !((x.dirs || []).length) && !((x.dirPath || []).length)) { x.dir = rn; x.dirPath = [rn]; }
              });
            }
            (window.__bastionDiag = window.__bastionDiag || []).push({ ts: Date.now(), ev: 'dir-fetch-done', done: done });
            window.__bastionFetchState.dirRunning = false;
            return Promise.resolve(true);
          }
          var n = dirs[idx++];
          return fetchDirPages(n).then(function(){ return bdelay(120).then(one); });
        }
        return one();
      };
      // ---- 收藏夹树主动拉取:getTree 前端不一定每次都会发,收藏分组显示前缺树 → poll 兜底调用 ----
      window.__bastionFetchFavTree = function() {
        return bget('/shterm/api/userFav/getTree', { method: 'GET' }).then(function(t){
          var j = null; try { j = JSON.parse(t); } catch (e) {}
          if (j && (j.children || j.name)) window.__bastionFavTree = j;
          return !!window.__bastionFavTree;
        }).catch(function(){ return false; });
      };
      // ---- 收藏分组:按 userFav/getTree 的分组逐个查设备,映射 favGroup(左侧收藏按分组展示) ----
      // getFavoriteDevices 带 favId=组id 只返回该组收藏;favId=null 才是全部。平铺抓取拿不到分组归属。
      window.__bastionFetchFavGroups = function() {
        if (window.__bastionFetchState.favRunning) return Promise.resolve(false);
        var favTree = window.__bastionFavTree;
        // 递归所有层级(收藏分组可嵌套):favGroup 存全路径"父/子",渲染端据此缩进。
        // 组名/id 字段因堡垒机版本而异,统一兜底,绝不出现 "undefined" 前缀。
        var groups = [];
        (function walk(ns, prefix) {
          (ns || []).forEach(function(n){
            var gid = n.id != null ? n.id : (n.key != null ? n.key : n.favId);
            var nm = n.name || n.label || n.title || n.text || n.favName || ('组' + (gid != null ? gid : '?'));
            groups.push({ id: gid, name: prefix + (prefix ? '/' : '') + nm });
            walk(n.children || n.nodes || n.items, prefix + (prefix ? '/' : '') + nm);
          });
        })((favTree && (favTree.children || favTree.nodes)) || []);
        if (!groups.length) return Promise.resolve(false);
        // 清除历史残留的 favGroup(早期版本映射出过 "undefinedxxx"),再按组重新映射,保证数据干净
        (window.__bastionAssets || []).forEach(function(x){ delete x.favGroup; });
        window.__bastionFetchState.favRunning = true;
        var idx = 0, done = 0;
        function one() {
          if (idx >= groups.length) {
            window.__bastionFetchState.favRunning = false;
            return Promise.resolve(true);
          }
          var g = groups[idx++];
          var body = JSON.stringify({ page: 0, size: 100, favId: g.id != null ? g.id : null });
          return bxhr('PUT', '/shterm/api/asset/getFavoriteDevices?page=0&size=100&sort=dev.name,asc', body).then(function(t){
            var j = null; try { j = JSON.parse(t); } catch (e) {}
            if (j && j.content && j.content.length) {
              var map = new Map((window.__bastionAssets || []).map(function(x){ return [x.devId || x.name + x.ip, x]; }));
              j.content.forEach(function(c){
                var d = c.dev || {};
                var key = String(d.id != null ? d.id : c.id || (d.name + d.ip));
                if (map.has(key)) { map.get(key).favorite = true; map.get(key).favGroup = g.name; }
              });
              window.__bastionAssets = Array.from(map.values());
              done += j.content.length;
            }
            return bdelay(120).then(one);
          }).catch(function(){ return bdelay(120).then(one); });
        }
        return one();
      };
      } catch (e) {
        // 页面状态异常(导航中/登录页 fetch 已被 SPA 重定义等):静默失败并复位注入标记,
        // 下轮 poll 会重新尝试。不抛错 → 避免 Electron 的
        // "GUEST_VIEW_MANAGER_CALL: Script failed to execute" 错误刷屏。
        window.__bastionHookInjected = false;
        window.__bastionDiag = (window.__bastionDiag || []);
        window.__bastionDiag.push({ ts: Date.now(), ev: 'hook-throw', msg: String(e && e.message).slice(0, 200) });
      }
    })()`).then(() => {
      // 注入成功:复位退避与禁用标记
      bastionInjectFails = 0;
      bastionInjectBackoff = 8000;
      bastionInjectDisabled = false;
    }).catch(() => {
      // 帧层面失败(页面导航/卸载中,executeJavaScript 拒绝,guest 侧 try/catch 拦不住):
      // 指数退避;连续失败过多则暂停自动注入(页面明显不可用,不再产生错误日志)
      bastionInjectFails++;
      bastionInjectBackoff = Math.min(60000, 8000 * Math.pow(2, Math.min(bastionInjectFails, 3)));
      if (bastionInjectFails >= 3) {
        bastionInjectDisabled = true;
        console.warn('[堡垒机] 钩子注入连续失败,暂停自动注入/拉取(页面不稳定);重新加载页面或手动刷新后恢复');
      } else {
        console.warn('[堡垒机] 钩子注入失败(页面导航中?),' + Math.round(bastionInjectBackoff / 1000) + 's 后重试');
      }
    });
  } catch { /* ignore */ }
}

// 从 webview 读取捕获的资产(资产+目录树+收藏),刷新会话列表并持久化
// 钩子丢失检测的限流状态:只在"活着→丢失"首次打日志;注入失败时指数退避(8s→60s),
// 避免页面导航/不稳定时每几秒重试 + 触发 fetchAll,把 GUEST_VIEW_MANAGER_CALL 刷屏。
let bastionHookLost = false;
let bastionLastInject = 0;
let bastionInjectFails = 0;   // 注入连续失败次数(帧层面失败,JS try/catch 拦不住)
let bastionInjectBackoff = 8000; // 当前注入间隔(失败翻倍,上限 60s;成功复位 8s)
let bastionInjectDebounce = null; // did-stop-loading 的注入 debounce(页面稳定后再注入)
let bastionInjectDisabled = false; // 注入连续失败过多:自动注入/拉取全部暂停(页面明显不可用)
let bastionSpasLogged = false;    // "SPA 未拉全量"日志只打一次
let bastionLastPollKey = '';      // 轮询诊断日志限流:状态变化才打
let bastionPageStableTs = 0;      // 最近一次 did-stop-loading 时间;重定向风暴期间反复刷新 → 一直不稳
// 页面是否已稳定(停止加载 ≥ms 且未再开始导航):稳定前不执行注入/轮询,避免导航瞬间帧层面报错
function bastionPageStable(ms) {
  return bastionPageStableTs > 0 && Date.now() - bastionPageStableTs >= ms;
}
// webview 是否在加载中:加载/导航期间 executeJavaScript 必然失败,还会让 Electron
// 打 GUEST_VIEW_MANAGER_CALL 'Script failed to execute' 错误 → 加载中一律跳过
function bastionWebviewLoading() {
  try { const wv = els.bastionWebview; return !!(wv && wv.isLoading && wv.isLoading()); } catch { return false; }
}
// 规范化 JSON 比较:键按字典序排序后再序列化。
// 用途:判断堡垒机 tree/favTree 是否真变化 —— guest 每次轮询返回的是新解析的对象,
// 即使内容相同,对象属性书写顺序不同(如 {name,children} vs {children,name})也会让
// JSON.stringify 结果不同 → 误判"变了" → 每 4s 全量重建会话列表(折叠丢失/滚动重置/选中闪烁)。
function stableJson(v) {
  if (v === null || v === undefined) return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

// 合并一次新的 webview 捕获到已有资产:重捕获/换页时注入钩子重置 guest 状态,
// 新扁平捕获的设备 dir/dirs 全空,且逐目录补充是渐进式的(先处理的目录先把设备"拉走")。
// 按 devId 把旧 state 的 dir/dirs 与新的 dirs 取并集:补充期间旧分组不丢、不渐进掏空,
// 补充完成后新 dirs 已含全部目录(旧目录本就是设备所属,并集不再增加)。
function mergeBastionCapture(prev, fresh) {
  const prevMap = new Map((prev || []).map((a) => [a.devId || a.name + a.ip, a]));
  return (fresh || []).map((a) => {
    const old = prevMap.get(a.devId || a.name + a.ip);
    if (!old) return a;
    const m = { ...a };
    if (!m.dir && old.dir) m.dir = old.dir;
    const union = new Set(m.dirs && m.dirs.length ? m.dirs : []);
    if (old.dirs && old.dirs.length) old.dirs.forEach((d) => union.add(d));
    else if (old.dir) union.add(old.dir);
    m.dirs = Array.from(union);
    if (!m.dirPath || !m.dirPath.length) m.dirPath = old.dirPath ? old.dirPath.slice() : [];
    if (!m.favGroup && old.favGroup && old.favGroup.indexOf('undefined') !== 0) m.favGroup = old.favGroup;
    return m;
  });
}

function pollBastionAssets(force) {
  const wv = els.bastionWebview;
  if (!wv || !wv.executeJavaScript) return;
  if (els.bastionSlot.classList.contains('hidden')) return; // 面板已收起:不打扰后台 webview,恢复展开后再轮询
  // 操作驱动:用户最近 5 秒内操作过 H3C 页面(__bastionFocusTs 新)才立即同步资产,
  // 否则跳过本轮 —— 闲置时每 4s 轮询纯属浪费(executeJavaScript IPC + guest 开销),
  // 改为 15s 低频兜底 + 用户操作时快速同步,兼顾实时性与性能。
  // force=true:流程内重触发(拉目录/拉全量后继续同步),不受操作驱动限制。
  if (!force && !bastionFocusCheckPending()) return;
  // 只对 H3C 控制台(路径含 /shterm)做资产捕获:webview 里若是 JumpServer(/ui /luna)等
  // 非 H3C 站点,钩子永远无效 —— 旧逻辑仍每 4s 轮询 + 每 10s 触发拉取,状态栏反复
  // "正在拉取堡垒机全部资产…/未完成",表现为连接堡垒机后界面频繁刷新。
  let curUrl = '';
  try { if (wv.getURL && wv.getURL()) curUrl = wv.getURL(); } catch { /* ignore */ }
  if (!curUrl && els.bastionCurrent) curUrl = els.bastionCurrent.textContent.split(' — ').pop() || '';
  // 只对 H3C 控制台做资产捕获:路径含 /shterm(登录页/资产页都在此路径下,见 HAR),
  // 或裸根 URL(跳转前首页可能无路径)。JMS(/ui /luna /core)等非 H3C 站点跳过,
  // 否则钩子永远无效 → 每 4s 轮询 + 每 10s 拉取,状态栏反复刷"正在拉取…/未完成"。
  const pathPart = (() => { try { return new URL(curUrl).pathname; } catch { return ''; } })();
  const isH3c = curUrl && (curUrl.indexOf('/shterm') !== -1 || pathPart === '' || pathPart === '/');
  if (!isH3c) {
    state.bastionAllFetched = true; // 复位"未拉取"标记,避免切回 H3C 前反复自动重试
    return;
  }
  if (bastionWebviewLoading()) return; // 加载中:跳过本轮,避免 executeJavaScript 失败刷屏
  if (!bastionPageStable(1200)) return; // 刚停止加载/还在导航风暴中:再等等,避免帧层面报错
  try {
    wv.executeJavaScript(`(function(){
      try {
        return {
          assets: window.__bastionAssets || [],
          tree: window.__bastionTree || [],
          favTree: window.__bastionFavTree || null,
          favs: Array.from(window.__bastionFavSet || []),
          fetchState: window.__bastionFetchState || { running: false, dirRunning: false },
          hookAlive: typeof window.__bastionFetchAll === 'function'
        };
      } catch (e) {
        // 页面导航中/被卸载:返回空快照,下轮再试(不抛错,避免错误刷屏)
        return { assets: [], tree: [], favTree: null, favs: [], fetchState: { running: false, dirRunning: false }, hookAlive: false };
      }
    })()`).then((r) => {
      r = r || {};
      // 重捕获时注入钩子重置 guest 状态,新扁平捕获的设备 dir/dirs 全空 → 若直接替换 state,
      // 左侧 202 个分组会瞬间全部掉进「未分组」,直到逐目录补充跑完(1-2 分钟)。用旧的
      // state 数据按 devId 回填 dir/dirs/dirPath(新数据为空才回填),重捕获期间旧分组不丢,
      // 逐目录补充完成后 dirs 渐进合并成完整的多目录归属。
      const list = mergeBastionCapture(state.bastionAssets, r.assets);
      let changed = false; // 仅当数据真变化才重渲染(旧版无条件 renderSessionList,每 4s 全量重建 870 资产 DOM)
      // 钩子存活检测:SPA 页面登录跳转/整页重载会重置 guest 环境(__bastionHookInjected 和
      // __bastionFetchAll 全丢)→ 前端资产请求不被捕获、fetchAll 也不存在,资产区静默消失
      // 且提示"拉取未完成"。检测到丢失就重新注入,并触发一次主动拉取。
      // 日志/注入都限流:只在"活着→丢失"的首次打日志,注入 ≥8s 一次 —— 登录页/导航中
      // 反复失败不再刷屏(错误本身已被 guest 侧 try/catch 吞掉)。
      if (!r.hookAlive) {
        if (!bastionHookLost) {
          bastionHookLost = true;
          if (!bastionInjectDisabled) console.log('[堡垒机] webview 钩子丢失(页面可能重载),重新注入');
        }
        const now = Date.now();
        // 注入被禁用(页面不稳定):不再自动重试/拉取,只保留轮询读取
        if (!bastionInjectDisabled && (!bastionLastInject || now - bastionLastInject > bastionInjectBackoff)) {
          bastionLastInject = now;
          injectBastionAssetHook();
          // 注入连续失败时不再触发 fetchAll(否则每个周期成对报错)
          if (bastionInjectFails < 2) {
            if (!state.bastionLastAutoFetch || now - state.bastionLastAutoFetch > 10000) {
              state.bastionLastAutoFetch = now;
              triggerBastionFullFetch();
            }
          }
        }
      } else {
        bastionHookLost = false; // 钩子恢复,复位"已丢失"标记
      }
      // 持久化键:随 webview 当前地址同步为 origin(S1/S2 修复——
      // 旧版 state.bastionUrl 只在 restore 赋值永不更新,多堡垒机切换时 B 的数据写进 A 的键)
      let curUrl2 = '';
      try { if (wv.getURL && wv.getURL()) curUrl2 = wv.getURL(); } catch { /* ignore */ }
      if (!curUrl2 && els.bastionCurrent) curUrl2 = els.bastionCurrent.textContent.split(' — ').pop() || '';
      const curOrigin = bastionOrigin(curUrl2);
      if (curOrigin && curOrigin !== state.bastionUrl) {
        state.bastionUrl = curOrigin;
        // 换了堡垒机 → 清掉上一台的折叠状态与内存资产(避免跨堡垒机串扰/旧资产残留)
        state.bastionDirCollapsed.clear();
        state.bastionDirsInit = false; // 新堡垒机的分组重新"首次默认折叠"
        state.bastionTree = [];
        state.bastionFavTree = null;
      }
      const json = stableJson(list);
      if (list.length && json !== stableJson(state.bastionAssets)) {
        // 首次拿到资产(之前为空)→ H3C 区块与目录分组默认折叠(左侧分组收起,展开才看)
        if (!state.bastionAssets.length) {
          state.bastionCollapsed = true;
          state.bastionDirCollapsed.add('__fav__');
        }
        state.bastionAssets = list;
        persistBastionAssets(); // 异步持久化,不阻塞渲染
        changed = true;
        console.log('[堡垒机] 已刷新会话列表,资产数:', state.bastionAssets.length);
      } else {
        // 诊断:资产没更新的原因 —— 只打"状态变化"的轮次(每 4s 刷屏无意义)
        const key = [list.length, state.bastionAssets.length, state.bastionUrl].join('|');
        if (key !== bastionLastPollKey) {
          bastionLastPollKey = key;
          console.log('[堡垒机] poll: webview资产', list.length, '| state资产', state.bastionAssets.length,
            '| origin', state.bastionUrl, '| collapsed', state.bastionCollapsed, '| grouping', state.bastionGrouping);
        }
      }
      // 目录树 / 收藏夹树变化也同步(用键序无关的比较:guest 每次返回新对象,
      // 键序抖动会让 JSON.stringify 误判"变了" → 每 4s 全量重建会话列表)
      const treeJson = stableJson(r.tree);
      if (treeJson && treeJson !== stableJson(state.bastionTree)) {
        state.bastionTree = r.tree;
        changed = true;
        // 拿到树后自动后台补充分组(仅一次;失败/已跑则不重复)
        if (!state.bastionGrouping && !(r.fetchState && r.fetchState.dirRunning)) {
          state.bastionGrouping = true;
          try { wv.executeJavaScript('try { window.__bastionFetchDirs && window.__bastionFetchDirs() } catch(e) { false }').then(() => setTimeout(() => pollBastionAssets(true), 3000)); } catch { state.bastionGrouping = false; }
        }
      }
      // 目录分组跑完 → 复位"分组中…"提示并刷新
      if (state.bastionGrouping && !(r.fetchState && r.fetchState.dirRunning)) {
        state.bastionGrouping = false;
        changed = true;
      }
      const favTreeJson = stableJson(r.favTree);
      if (favTreeJson !== stableJson(state.bastionFavTree)) {
        state.bastionFavTree = r.favTree;
        changed = true;
        // 收藏树变化 → 后台按分组拉设备,映射 favGroup(左侧收藏按分组展示)
        if (!(r.fetchState && r.fetchState.favRunning)) {
          try { wv.executeJavaScript('try { window.__bastionFetchFavGroups && window.__bastionFetchFavGroups() } catch(e) { false }').then(() => setTimeout(() => pollBastionAssets(true), 2500)); } catch { /* ignore */ }
        }
      }
      // 收藏树缺失兜底:SPA 常不发 userFav/getTree(组 id 在它缓存里),主动拉一次存下来。
      // 10s 节流,失败(未登录/接口异常)下轮可重试;拉到后走上面的"收藏树变化 → 映射 favGroup"。
      if (!r.favTree && !(r.fetchState && r.fetchState.favRunning) && !bastionWebviewLoading()) {
        const now = Date.now();
        if (!state.bastionFavFetchAt || now - state.bastionFavFetchAt > 10000) {
          state.bastionFavFetchAt = now;
          try { wv.executeJavaScript('try { window.__bastionFetchFavTree && window.__bastionFetchFavTree() } catch(e) { false }').then(() => setTimeout(() => pollBastionAssets(true), 1500)); } catch { /* ignore */ }
        }
      }
      if (r.favs && r.favs.length) {
        const favSet = new Set(r.favs);
        // 对比用"排序后的内容",不能只比 size:数量不变但收藏内容变了(如 A→B)也要更新(M7)
        const favKey = [...favSet].sort().join(',');
        if (favKey !== [...state.bastionFavSet].sort().join(',')) {
          state.bastionFavSet = favSet;
          state.bastionAssets = state.bastionAssets.map((a) => ({ ...a, favorite: favSet.has(a.devId) || !!a.favorite }));
          persistBastionAssets();
          changed = true;
        }
      }
      if (changed) renderSessionList(els.inputSessionSearch.value);
      // SPA 登录后自动重触发(M8):H3C 控制台是 SPA,登录后不刷新页面 → 没有 did-stop-loading,
      // 主动拉全量只在页面加载时触发一次。这里检测:钩子已注入、但从未拉成功过、且未在跑 → 每 10s 试一次
      if (!state.bastionAllFetched && !(r.fetchState && r.fetchState.running) && !bastionInjectDisabled) {
        const now = Date.now();
        if (!state.bastionLastAutoFetch || now - state.bastionLastAutoFetch > 10000) {
          state.bastionLastAutoFetch = now;
          if (!bastionSpasLogged) { bastionSpasLogged = true; console.log('[堡垒机] SPA 页检测到未拉全量,自动重试拉取'); }
          triggerBastionFullFetch();
        }
      }
    }).catch((e) => console.log('[堡垒机] pollBastionAssets 异常:', e && e.message));
  } catch { /* ignore */ }
}

// 主动拉全量:页面就绪/点击刷新时调用,不依赖前端是否请求过资产 API
function triggerBastionFullFetch() {
  const wv = els.bastionWebview;
  if (!wv || !wv.executeJavaScript) return;
  // 只对 H3C(/shterm)做资产捕获:JMS 等非 H3C 站点没有 getAccessViewDevs,拉了也是失败刷状态栏
  let cu = '';
  try { if (wv.getURL && wv.getURL()) cu = wv.getURL(); } catch { /* ignore */ }
  const cp = (() => { try { return new URL(cu).pathname; } catch { return ''; } })();
  if (cu && cu.indexOf('/shterm') === -1 && cp !== '' && cp !== '/') return;
  if (bastionWebviewLoading()) return; // 加载中不触发(executeJavaScript 会失败)
  if (bastionInjectFails >= 2) return; // 注入一直失败:页面不稳定,不主动拉取(避免成对报错)
  injectBastionAssetHook(); // 确保钩子已注入(换页后 guest 环境重置);注入是异步的,稍等再触发
  // 只在"首次拉取"或"用户手动触发"时提示"正在拉取";后台 SPA 重试不再刷状态栏
  if (!bastionFetchOkNotified && !bastionFetchFailNotified) {
    setStatus('正在拉取堡垒机全部资产…', 'var(--accent)');
  }
  try {
    // 先注入钩子,400ms 后调用主动拉取(避免钩子未装好时 __bastionFetchAll 不存在)
    setTimeout(() => {
      if (bastionWebviewLoading()) return; // 延时期间页面开始导航 → 放弃本次
      wv.executeJavaScript('try { window.__bastionFetchAll && window.__bastionFetchAll() } catch(e) { false }').then((ok) => {
        if (ok) {
          state.bastionAllFetched = true; // SPA 登录后 poll 据此不再反复重试
          // 只提示一次"拉取完成"(数据就绪);重复触发不刷状态栏,避免闲置时状态栏反复闪
          if (!bastionFetchOkNotified) {
            bastionFetchOkNotified = true;
            setStatus('堡垒机资产已拉取完成', 'var(--green)');
          }
        } else if (!state.bastionAllFetched) {
          // 未成功:只在"从未成功过"时提示一次;后续重复失败静默(数据没变就不打扰用户)
          if (!bastionFetchFailNotified) {
            bastionFetchFailNotified = true;
            setStatus('堡垒机资产拉取未完成(可能未登录或接口异常)', 'var(--orange)');
          }
        }
        setTimeout(() => pollBastionAssets(true), 1200);
      }).catch((e) => {
        console.log('[堡垒机] triggerBastionFullFetch 异常:', e && e.message);
        if (!bastionFetchFailNotified) {
          bastionFetchFailNotified = true;
          setStatus('堡垒机资产拉取失败: ' + ((e && e.message) || '未知错误'), 'var(--red)');
        }
      });
    }, 400);
  } catch { /* ignore */ }
}

// 把堡垒机地址规范化为持久化键:统一用 origin(协议+主机+端口),去掉路径/查询/斜杠差异。
// 旧版直接用当前 URL(可能带 /shterm/ 深链接)当键,删除配置时又用配置 URL → 键不一致,
// 删除后旧数据"复活"、同一设备在多个键下重复。origin 归一后所有读写走同一把钥匙。
// 注意:about:blank / 无效 URL 的 origin 是字符串 "null",绝不能拿来当键(会污染持久化数据)。
function bastionOrigin(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch { return s.replace(/\/+$/, ''); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''; // about: 等非 http 协议 → 不作为键
  return u.origin;
}

// 把当前资产持久化到 SQLite(按当前堡垒机 origin 分组;防抖,避免频繁写盘)
let bastionPersistTimer = null;
function persistBastionAssets() {
  clearTimeout(bastionPersistTimer);
  // 首次变化立即落盘一次(不等 800ms),防抖只压后续高频变化 —— 否则捕获资产后
  // 很快退出应用,防抖 timer 没触发,资产根本没进 SQLite,重启后恢复不到
  flushBastionAssets();
  bastionPersistTimer = setTimeout(flushBastionAssets, 800);
}
function flushBastionAssets() {
  const url = state.bastionUrl || '';
  if (!url || !state.bastionAssets.length) return;
  window.api.bastionSaveAssets(url, state.bastionAssets).then((r) => {
    if (r && !r.ok) console.log('[堡垒机] 资产持久化失败:', r.error);
  }).catch(() => {});
}
// 应用退出前立即冲刷未落盘的资产(不等防抖 timer;防抖期间退出 = 数据丢失)
window.addEventListener('beforeunload', () => {
  if (bastionPersistTimer) { clearTimeout(bastionPersistTimer); bastionPersistTimer = null; }
  flushBastionAssets();
});

// 堡垒机连接链路诊断(主渲染进程;webview 的资产请求记录在 __bastionDiag,连接在 __bastionConnLog)
window.__bastionConnLog = [];
function bastionLog(evt) {
  window.__bastionConnLog.push(Object.assign({ ts: Date.now() }, evt));
  if (window.__bastionConnLog.length > 50) window.__bastionConnLog.shift();
}

// 导出堡垒机资产诊断包:把捕获到的所有资产请求记录 + 当前资产列表打包成 JSON 文件,拷贝给开发者排查"资产不完整"
function exportBastionDiag() {
  const wv = els.bastionWebview;
  // diag 记录存在 webview(隔离的 guest 页面)的 window 里,必须从 webview 读,不是主窗口
  const readDiag = (wv && wv.executeJavaScript)
    ? wv.executeJavaScript(`window.__bastionDiag || []`).catch(() => [])
    : Promise.resolve([]);
  readDiag.then((diag) => {
    const data = {
      app: 'Polaris',
      time: new Date().toISOString(),
      ua: navigator.userAgent,
      webviewUrl: els.bastionCurrent ? els.bastionCurrent.textContent : '',
      assetCount: (state.bastionAssets || []).length,
      assets: state.bastionAssets,
      tree: state.bastionTree || [],
      favTree: state.bastionFavTree || null,
      favCount: state.bastionFavSet ? state.bastionFavSet.size : 0,
      diag: diag || [],
      connLog: window.__bastionConnLog || [],
    };
    window.api.exportBastionDiag(data).then((r) => {
      alert(r && r.ok
        ? '✅ 堡垒机诊断包已导出:\n' + r.path + '\n\n请把该文件拷贝/发给我。'
        : '❌ 导出失败: ' + ((r && r.error) || '未知错误'));
    }).catch((e) => alert('❌ 导出异常: ' + e.message));
  });
}

// 会话列表里的"🌐 H3C 堡垒机"资产区(双击连 SSH;右键:连接/账号/SFTP/断开)
// 单个堡垒机资产行(双击连 SSH;右键:连接/账号/SFTP/断开)
function makeBastionAssetItem(a) {
  const item = document.createElement('div');
  item.className = 'asset-item jms-asset-item' + (a.favorite ? ' bastion-fav' : '');
  const acctHint = (a.accounts && a.accounts.length) ? a.accounts.join('/') : (a.recentAccount || '');
  item.title = `双击连 SSH → ${a.ip}${acctHint ? '(' + acctHint + ')' : ''}${a.dir ? '\n目录: ' + a.dir : ''}${a.favorite ? '\n⭐ 收藏设备' : ''}`;
  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.textContent = a.favorite ? '⭐' : '🖥';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = a.name;
  const addr = document.createElement('span');
  addr.className = 'addr jms-a-addr';
  addr.textContent = a.ip || '';
  item.appendChild(icon);
  item.appendChild(name);
  item.appendChild(addr);
  item.addEventListener('dblclick', () => bastionConnect(a));
  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const items = [{ label: `🔗 连接 SSH`, action: () => bastionConnect(a) }];
    const accts = (a.accounts || []).filter(Boolean);
    if (accts.length > 1) {
      items.push({ label: '账号', separatorLabel: true });
      for (const un of accts) items.push({ label: `🔑 ${un}`, action: () => bastionConnect(a, un) });
    }
    items.push({ separator: true });
    items.push({ label: '🔌 断开连接', action: () => bastionDisconnect(a) });
    items.push({ separator: true });
    items.push({ label: '📁 打开 SFTP', action: () => bastionConnect(a, null, 'ssh', true) });
    items.push({ separator: true });
    items.push({ label: '🔄 刷新资产', action: () => triggerBastionFullFetch() });
    showCtxMenu(e.clientX, e.clientY, items);
  });
  return item;
}

// 左侧堡垒机分组下显示"已保存的堡垒机连接"(配置弹窗创建的),点击即在右侧浏览器打开
function renderBastionSavedSessions(container, f) {
  const saved = bastionServers();
  if (!saved.length) return;
  const kw = (f || '').toLowerCase();
  // 连接本身(名称/URL)命中,或其已加载资产(名称/IP/地址/账号)命中,才显示
  const list = saved.filter((s) => {
    if (!kw) return true;
    if (((s.name || '').toLowerCase().includes(kw)) || ((s.url || '').toLowerCase().includes(kw))) return true;
    return (s.assets || []).some((a) => bastionAssetMatch(a, kw));
  });
  if (!list.length) return;
  // 已保存堡垒机连接:默认折叠(登录后不自动展开);搜索时忽略折叠直接展示命中项
  const savedCollapsed = !!state.collapsedBastionSaved && !kw;
  container.appendChild(makeSectionHead(`🛡 已保存堡垒机连接(${list.length})`, savedCollapsed,
    () => { state.collapsedBastionSaved = !state.collapsedBastionSaved; renderSessionList(els.inputSessionSearch.value); }, []));
  if (savedCollapsed) return;
  for (const s of list) {
    const item = document.createElement('div');
    item.className = 'asset-item jms-asset-item bastion-saved-item';
    item.title = `${s.name || s.url}\n${s.url}${s.account ? ' · ' + s.account : ''}\n点击加载/收起资产;右键可编辑/刷新/删除`;
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = '🛡';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = s.name || s.url;
    const addr = document.createElement('span');
    addr.className = 'addr jms-a-addr';
    addr.textContent = s.url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const badge = document.createElement('span');
    badge.className = 'bastion-saved-badge';
    badge.textContent = s.assets && s.assets.length ? `(${s.assets.length})` : (s.assetsLoading ? '加载中…' : '');
    item.appendChild(icon);
    item.appendChild(name);
    item.appendChild(addr);
    item.appendChild(badge);
    // 单击:展开/收起资产列表(懒加载 JumpServer 资产)
    item.addEventListener('click', () => {
      if (s.assetsExpanded) {
        s.assetsExpanded = false;
        renderSessionList(els.inputSessionSearch.value);
        return;
      }
      s.assetsExpanded = true;
      renderSessionList(els.inputSessionSearch.value);
      bastionLoadSavedAssets(s); // 异步拉资产,完成后重渲染
    });
    // 双击:打开右侧浏览器加载该堡垒机
    item.addEventListener('dblclick', () => { openBastionPanel(); bastionSelectServer('B:' + s.id); });
    // 右键:编辑 / 刷新资产(JMS 站点才有,可 REST 拉取)/ 删除
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const menu = [
        { label: '✏️ 编辑连接', action: () => bastionCfgEdit(s.id) },
      ];
      if (!isH3CSavedConn(s)) {
        menu.push({ label: '🔄 刷新资产', action: () => { s.assetsExpanded = true; s.assets = null; s.assetsLoadFailed = false; s.assetsLoadError = ''; bastionLoadSavedAssets(s); } });
      }
      menu.push({ label: '🗑 删除连接', danger: true, action: () => bastionRemoveTab(s.id) });
      showCtxMenu(e.clientX, e.clientY, menu);
    });
    container.appendChild(item);
    // 展开状态:连接下方渲染资产主机列表(按主机分组归类)
    if (s.assetsExpanded) {
      const assetsWrap = document.createElement('div');
      assetsWrap.className = 'bastion-saved-assets';
      if (s.assets && s.assets.length) {
        // 按主机分组(nodes 全部节点)归类:一个资产可属多个节点 → 在每个所属组都出现;
        // 无 nodes → 未分组。badge 显示的是去重资产总数。搜索时按名称/IP/账号过滤资产。
        const groups = new Map();
        for (const a of (kw ? s.assets.filter((x) => bastionAssetMatch(x, kw)) : s.assets)) {
          const nodeNames = (a.nodes && a.nodes.length)
            ? a.nodes.map((n) => n.name).filter(Boolean)
            : [a.dir || '__ungrouped__'];
          if (!nodeNames.length) nodeNames.push('__ungrouped__');
          for (const g of nodeNames) {
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(a);
          }
        }
        for (const [g, arr] of groups) {
          {
            const ghead = document.createElement('div');
            ghead.className = 'bastion-asset-group-head';
            ghead.textContent = g === '__ungrouped__' ? `🗂 未分组(${arr.length})` : `📁 ${g}(${arr.length})`;
            ghead.addEventListener('contextmenu', (e) => {
              e.preventDefault();
              showCtxMenu(e.clientX, e.clientY, [{ label: '🔗 批量连接', action: () => batchSavedAssetConnect(s, arr) }]);
            });
            assetsWrap.appendChild(ghead);
          }
          for (const a of arr) {
            const row = document.createElement('div');
            row.className = 'asset-item jms-asset-item';
            row.title = `双击连 SSH → ${a.address || a.ip}`;
            const ic = document.createElement('span');
            ic.className = 'icon';
            ic.textContent = '🖥';
            const nm = document.createElement('span');
            nm.className = 'name';
            nm.textContent = a.name;
            const ad = document.createElement('span');
            ad.className = 'addr jms-a-addr';
            ad.textContent = a.address || a.ip || '';
            row.appendChild(ic);
            row.appendChild(nm);
            row.appendChild(ad);
            // 双击:通过该堡垒机连 SSH(复用 JMS 复合用户名走 KoKo 网关);
            // 未登录时自动用保存的账号密码登录(不必手动刷新)
            row.addEventListener('dblclick', async () => {
              const jmsServer = {
                id: 'saved-' + s.id, name: s.name, baseUrl: s.url,
                sshHost: s.sshHost || (() => { try { return new URL(s.url).hostname; } catch { return ''; } })(),
                sshPort: s.sshPort || 2222,
                account: s.account || '', password: s.password || '', token: s.token || null, user: s.user || null,
              };
              if (!jmsServer.token) {
                setStatus(`正在登录「${s.name}」…`, 'var(--accent)');
                try {
                  const pw = await decryptSecret(s.password || '');
                  if (!s.account || !pw) {
                    setStatus(`「${s.name}」未配置账号密码,无法登录`, 'var(--red)');
                    return;
                  }
                  const lg = await window.api.jmsLogin({ baseUrl: s.url, username: s.account, password: pw });
                  if (!lg.ok || !lg.token) {
                    setStatus(`登录「${s.name}」失败: ${lg.error || '未知错误'}`, 'var(--red)');
                    return;
                  }
                  s.token = lg.token; s.user = lg.user; // 存回连接,后续直接可用
                  jmsServer.token = lg.token; jmsServer.user = lg.user;
                } catch (e) {
                  setStatus(`登录「${s.name}」失败: ${e.message}`, 'var(--red)');
                  return;
                }
              }
              await bastionConnectAsset(s, a); // 不经过 jmsFind(该连接不在 state.jmsServers)
            });
            assetsWrap.appendChild(row);
          }
        }
      } else if (s.assetsLoading) {
        assetsWrap.textContent = '加载资产中…';
      } else if (s.assetsLoadFailed) {
        assetsWrap.textContent = s.assetsLoadError
          ? `资产加载失败: ${s.assetsLoadError}`
          : '资产加载失败(确认站点为 JumpServer 且账号可登录)';
      } else if (isH3CSavedConn(s)) {
        assetsWrap.textContent = 'H3C 站点:资产由右侧浏览器登录后捕获,展开「🌐 H3C 堡垒机」区块查看;双击连接可打开右侧浏览器';
      } else {
        assetsWrap.textContent = '点击连接行加载资产…';
      }
      container.appendChild(assetsWrap);
    }
  }
}

// 通过已保存堡垒机连接连某资产 SSH(复用 JMS 复合用户名走 KoKo 网关)。
// 不经过 jmsFind:该连接存于 bastionServers,不在 state.jmsServers。
async function bastionConnectAsset(bastionServer, asset, accountName) {
  const s = bastionServer;
  if (!s || !s.user || !s.token) { alert('请先登录该 JumpServer'); return; }
  const protocol = (asset.protocols && asset.protocols[0] && asset.protocols[0].name) || 'ssh';
  const account = accountName || (asset.accounts && asset.accounts[0] && asset.accounts[0].username) || 'root';
  const jmsUser = (s.user && s.user.username) || s.account || 'admin';
  const username = `${jmsUser}@${protocol}@${account}@${asset.address}`;
  const sshHost = s.sshHost || (() => { try { return new URL(s.url).hostname; } catch { return ''; } })();
  // 密码是 safeStorage 密文(enc:v1:),连接前必须解密——否则 KoKo 收到密文 → 认证失败
  const password = await decryptSecret(s.password || '');
  const session = {
    id: `jms-${++state.jmsSeq}`,
    name: asset.name,
    host: sshHost,
    port: s.sshPort || 2222,
    username,
    password,
    encoding: 'utf8',
    tag_color: '',
    jmsKey: `saved-${s.id}|${asset.address}|${account}`,
    displayHost: asset.address || asset.ip || '',
    displayPort: (asset.protocols && asset.protocols[0] && asset.protocols[0].port) || 22,
  };
  connectToServer(session);
  setStatus(`连接 ${asset.name}(${account})…`, 'var(--accent)');
}

// H3C Shterm 站点:URL 含 /shterm 或配置类型为 h3c。这类站点没有 JumpServer REST API,
// 资产由右侧浏览器登录后从网页捕获(见「🌐 H3C 堡垒机」区块),不走 jmsLogin/jmsAssets。
function isH3CSavedConn(s) {
  return !!(s && (s.type === 'h3c' || (s.url && /\/shterm/.test(s.url))));
}

// 懒加载已保存堡垒机的资产:用保存的账号登录 JumpServer 拉资产列表
// 失败时把真实原因存进 s.assetsLoadError,界面显示具体错误(原来只显示笼统的
// "确认站点为 JumpServer…",登录失败的具体原因被吞了没法排查)。
async function bastionLoadSavedAssets(s) {
  if (s.assetsLoading) return;
  // H3C 站点没有 JMS REST 接口:这里调 jmsLogin 会用 H3C 地址拼出
  // {url}/login/api/v1/authentication/auth/ → H3C 返回 HTTP 401。直接提示走右侧浏览器捕获。
  if (isH3CSavedConn(s)) {
    s.assetsLoading = false;
    s.assetsLoadFailed = false;
    s.assetsLoadError = '';
    renderSessionList(els.inputSessionSearch.value);
    setStatus('H3C 站点资产由右侧浏览器登录后捕获,展开「🌐 H3C 堡垒机」区块查看(双击该连接打开浏览器)', 'var(--accent)');
    return;
  }
  s.assetsLoading = true;
  s.assetsLoadError = '';
  renderSessionList(els.inputSessionSearch.value);
  const fail = (msg) => {
    s.assetsLoadFailed = true;
    s.assetsLoadError = msg;
    s.assetsLoading = false;
    renderSessionList(els.inputSessionSearch.value);
  };
  try {
    // 已有 token 直接用;否则用保存的账号密码登录
    if (!s.token) {
      const pw = await decryptSecret(s.password || '');
      if (!s.account || !pw) { fail('未配置账号或密码,无法登录'); return; }
      const lg = await window.api.jmsLogin({ baseUrl: s.url, username: s.account, password: pw });
      // MFA 双因素账号:弹验证码输入框,输对后完成登录再拉资产(复用 jms:mfa 链路)
      if (lg && lg.mfaRequired) {
        s.assetsLoading = false;
        s.assetsLoadError = '';
        renderSessionList(els.inputSessionSearch.value);
        promptJmsMfa(s, {
          cookie: lg.cookie, challengeUrl: lg.challengeUrl,
          choices: lg.choices, username: s.account, password: pw,
        });
        return;
      }
      if (!lg || !lg.ok || !lg.token) { fail((lg && lg.error) || '登录失败'); return; }
      s.token = lg.token; s.user = lg.user;
    }
    const r = await window.api.jmsAssets({ baseUrl: s.url, token: s.token });
    if (r && r.ok && r.assets) {
      s.assets = r.assets || [];
      s.assetsLoadFailed = false;
    } else {
      // token 过期是常见原因:清掉,下次自动重新登录
      if (r && /401|403|未登录|invalid token|expired/i.test(r.error || '')) s.token = null;
      fail((r && r.error) || '资产列表为空');
    }
  } catch (e) { fail((e && e.message) || String(e)); }
  s.assetsLoading = false;
  renderSessionList(els.inputSessionSearch.value);
}

// 已保存堡垒机登录遇到 MFA 双因素:弹验证码输入框,输对后完成登录(登录态写回 s.token,
// 再重走 bastionLoadSavedAssets 拉资产);验证码错了重弹让用户重输,取消则恢复原状。
function promptJmsMfa(s, { cookie, challengeUrl, choices, username, password }) {
  const mfaType = (choices && choices[0]) || 'otp';
  const attempt = () => {
    showPrompt({
      title: `「${s.name}」双因素验证`,
      label: '该账号开启了双因素认证,请输入验证码(OTP/动态码)', value: '', password: false,
      onOk: (code) => {
        code = (code || '').trim();
        if (!code) { setStatus('未输入验证码', 'var(--red)'); attempt(); return; }
        setStatus(`验证「${s.name}」…`, 'var(--accent)');
        window.api.jmsMfa({
          baseUrl: s.url, cookie, challengeUrl, type: mfaType, code, username, password,
        }).then((r) => {
          if (r && r.ok && r.token) {
            s.token = r.token; s.user = r.user;
            s.assetsLoadFailed = false; s.assetsLoadError = '';
            setStatus(`「${s.name}」登录成功`, 'var(--green)');
            bastionLoadSavedAssets(s); // 已有 token,重走直接拉资产
          } else {
            setStatus(`验证失败: ${(r && r.error) || '未知错误'}`, 'var(--red)');
            attempt(); // 验证码错了,再弹一次重输
          }
        }).catch((e) => {
          setStatus(`验证异常: ${(e && e.message) || e}`, 'var(--red)');
          attempt();
        });
      },
    });
  };
  attempt();
}

// 会话列表里的"🌐 H3C 堡垒机"资产区:
// 空搜索 → 按目录分组展示(⭐收藏置顶 + 业务目录组,可折叠);有搜索词 → 平铺匹配项(性能考虑)
function renderBastionInSessionList(container, f) {
  const all = state.bastionAssets;
  const kw = (f || '').toLowerCase();
  // 搜索:按 名称/IP/账号 过滤;空搜索 = 全显示;空格分隔多关键词
  const list = all.filter((a) => bastionAssetMatch(a, kw));
  if (!list.length) return;
  const favCount = all.filter((a) => a.favorite).length;
  container.appendChild(makeSectionHead(`🌐 H3C 堡垒机(${list.length}${kw ? '/' + all.length : ''}${favCount ? ' ⭐' + favCount : ''}${state.bastionGrouping ? ' ·分组中…' : ''})`, state.bastionCollapsed,
    () => { state.bastionCollapsed = !state.bastionCollapsed; renderSessionList(els.inputSessionSearch.value); },
    [
      { label: '🔗 批量连接全部', action: () => batchBastionConnect(list) },
      { label: '🔄 拉取全部资产', action: () => triggerBastionFullFetch() },
      { label: '📤 导出诊断包', action: () => exportBastionDiag() },
      { label: '🔌 断开全部堡垒机连接', action: () => disconnectBastionAll() },
    ]));
  if (state.bastionCollapsed) return;
  if (kw) {
    // 搜索:平铺匹配项(星标保留)
    for (const a of list) container.appendChild(makeBastionAssetItem(a));
    return;
  }
  // ---- 空搜索:分组展示 ----
  // 设备可属多个业务目录(与网页一致):按 dirs(全部所属目录)分组,同一设备出现在每个所属组。
  const dirs = [];
  const map = new Map();
  for (const a of all) {
    if (a.favorite) continue; // M4:收藏设备只出现在 ⭐收藏 置顶组,目录组/未分组不再重复渲染
    const groups = (a.dirs && a.dirs.length) ? a.dirs : [a.dir || ''];
    for (const dn of groups) {
      if (!map.has(dn)) map.set(dn, []);
      map.get(dn).push(a);
    }
  }
  for (const [d, arr] of map) dirs.push({ dir: d, assets: arr });
  // 排序:有目录的按目录名 → 未分组最后
  dirs.sort((x, y) => {
    if (!x.dir) return 1;
    if (!y.dir) return -1;
    return x.dir.localeCompare(y.dir, 'zh');
  });
  // 业务目录分组:有资产的目录(flat map)全部渲染,不漏(树 path 长度/空标记因堡垒机版本而异,
  // 不能拿树过滤有资产的目录)。层级:按资产的 dirPath[0](业务根,如"中华人寿大连IDC")分组,
  // 根作父级、其下目录缩进;无 dirPath 的目录平铺。树缺失也能工作(靠 dirPath 而非 tree)。
  const groupKeys = dirs.filter((g) => g.dir && g.dir !== '__fav__');
  const ungrouped = dirs.find((g) => !g.dir);
  const dirRoot = new Map(); // 目录名 → 业务根(取该目录任一资产的 dirPath[0])
  const roots = new Map();   // 业务根 → [目录名]
  const rootLevel = new Map(); // 业务根 → [根级设备](dir === 业务根名,直接在根下,非子目录)
  const rootless = [];       // 无业务根的目录名(平铺)
  for (const g of groupKeys) {
    const sample = (g.assets || []).find((a) => a.dirPath && a.dirPath[0]);
    if (sample) {
      const r = sample.dirPath[0];
      if (g.dir === r) {
        // 根级设备(如 dir=中华人寿大连IDC,dirPath=[中华人寿大连IDC]):归到根下单独展示,不进子目录列表
        if (!rootLevel.has(r)) rootLevel.set(r, []);
        rootLevel.get(r).push(...g.assets);
        continue;
      }
      dirRoot.set(g.dir, r);
      if (!roots.has(r)) roots.set(r, []);
      roots.get(r).push(g.dir);
    } else rootless.push(g.dir);
  }
  // 只含根级设备、没有子目录的业务根也要渲染(否则这些设备被漏掉)
  for (const r of rootLevel.keys()) if (!roots.has(r)) roots.set(r, []);
  // 根计数必须按设备去重:设备可属多个子目录,直接求和会把重叠设备重复计数(871 → 2066)。
  // 同时包含根级设备(dir=业务根名,非子目录),总数 = 该业务根下全部主机。
  const rootTotal = (r) => {
    const seen = new Set();
    let n = 0;
    for (const dn of (roots.get(r) || [])) {
      for (const a of (map.get(dn) || [])) {
        const k = a.devId || a.name + a.ip;
        if (!seen.has(k)) { seen.add(k); n++; }
      }
    }
    for (const a of (rootLevel.get(r) || [])) {
      const k = a.devId || a.name + a.ip;
      if (!seen.has(k)) { seen.add(k); n++; }
    }
    return n;
  };
  const collectRootAssets = (r) => {
    const seen = new Set();
    const out = [];
    for (const dn of (roots.get(r) || [])) {
      for (const a of (map.get(dn) || [])) {
        const k = a.devId || a.name + a.ip;
        if (!seen.has(k)) { seen.add(k); out.push(a); }
      }
    }
    for (const a of (rootLevel.get(r) || [])) {
      const k = a.devId || a.name + a.ip;
      if (!seen.has(k)) { seen.add(k); out.push(a); }
    }
    return out;
  };
  // 首次渲染分组视图:所有目录/收藏分组默认折叠(左侧分组收起,展开才看资产)
  if (!state.bastionDirsInit && !kw) {
    state.bastionDirsInit = true;
    for (const r of roots.keys()) state.bastionDirCollapsed.add('__root__' + r);
    for (const g of groupKeys) state.bastionDirCollapsed.add(g.dir);
    state.bastionDirCollapsed.add('__ungrouped__');
  }
  // 收藏组(置顶,独立分组,可折叠;内部再按收藏分组 favGroup 展示,嵌套分组按 "/" 段缩进)
  const favs = all.filter((a) => a.favorite);
  if (favs.length) {
    const collapsed = state.bastionDirCollapsed.has('__fav__');
    container.appendChild(makeSectionHead(`⭐ 收藏(${favs.length})`, collapsed,
      () => { collapsed ? state.bastionDirCollapsed.delete('__fav__') : state.bastionDirCollapsed.add('__fav__'); renderSessionList(els.inputSessionSearch.value); },
      [{ label: '🔗 批量连接', action: () => batchBastionConnect(favs) }]));
    if (!collapsed) {
      const gmap = new Map();
      for (const a of favs) {
        const raw = a.favGroup;
        // 历史脏数据("undefinedxxx" 是早期映射 bug 产物)视为无分组,归「默认收藏」,
        // 避免收藏区显示 "undefined资金管理系统" 这类垃圾分组名(与 merge 守卫一致)
        const g = (raw && raw.indexOf('undefined') !== 0) ? raw : '默认收藏';
        if (!gmap.has(g)) gmap.set(g, []);
        gmap.get(g).push(a);
      }
      // 按 favGroup 的 "/" 段建树:设备挂在叶子组;父组头显示后代总数并缩进
      const favRoot = { children: new Map() };
      for (const [g, arr] of gmap) {
        let node = favRoot;
        for (const seg of g.split('/')) {
          if (!node.children.has(seg)) node.children.set(seg, { children: new Map(), assets: [] });
          node = node.children.get(seg);
        }
        node.assets.push(...arr);
      }
      const favTotal = (n) => n.assets.length + [...n.children.values()].reduce((s, c) => s + favTotal(c), 0);
      const collectFavAssets = (n) => n.assets.concat(...[...n.children.values()].map(collectFavAssets));
      const renderFavNode = (node, path, depth) => {
        for (const [name, child] of node.children) {
          const gk = '__fav__' + (path ? path + '/' : '') + name;
          const gCollapsed = state.bastionDirCollapsed.has(gk);
          const head = makeSectionHead(`📁 ${name}(${favTotal(child)})`, gCollapsed,
            () => { gCollapsed ? state.bastionDirCollapsed.delete(gk) : state.bastionDirCollapsed.add(gk); renderSessionList(els.inputSessionSearch.value); },
            [{ label: '🔗 批量连接', action: () => batchBastionConnect(collectFavAssets(child)) }]);
          if (depth > 0) head.style.paddingLeft = (8 + depth * 14) + 'px';
          container.appendChild(head);
          if (gCollapsed) continue;
          for (const a of child.assets) container.appendChild(makeBastionAssetItem(a));
          renderFavNode(child, (path ? path + '/' : '') + name, depth + 1);
        }
      };
      renderFavNode(favRoot, '', 0);
    }
  }
  // 按业务根分组渲染:根父级 → 其下目录缩进一级;无根的目录平铺(上下级缩进,不漏目录)
  for (const [r, dirNames] of roots) {
    const rk = '__root__' + r;
    const rCollapsed = state.bastionDirCollapsed.has(rk);
    container.appendChild(makeSectionHead(`📁 ${r}(${rootTotal(r)})`, rCollapsed,
      () => { rCollapsed ? state.bastionDirCollapsed.delete(rk) : state.bastionDirCollapsed.add(rk); renderSessionList(els.inputSessionSearch.value); },
      [{ label: '🔗 批量连接', action: () => batchBastionConnect(collectRootAssets(r)) }]));
    if (rCollapsed) continue;
    for (const dn of dirNames) {
      const assets = map.get(dn) || [];
      const collapsed = state.bastionDirCollapsed.has(dn);
      const head = makeSectionHead(`📁 ${dn}(${assets.length})`, collapsed,
        () => { collapsed ? state.bastionDirCollapsed.delete(dn) : state.bastionDirCollapsed.add(dn); renderSessionList(els.inputSessionSearch.value); },
        [{ label: '🔗 批量连接', action: () => batchBastionConnect(assets) }]);
      head.style.paddingLeft = (8 + 14) + 'px'; // 子目录缩进一级
      container.appendChild(head);
      if (collapsed) continue;
      for (const a of assets) container.appendChild(makeBastionAssetItem(a));
    }
    // 根级设备:直接在业务根下的主机(非任何子目录),浏览器里它们在根视图可见
    if (rootLevel.has(r)) {
      const rl = rootLevel.get(r);
      const rlKey = '__rootdev__' + r;
      const rlCollapsed = state.bastionDirCollapsed.has(rlKey);
      const rlHead = makeSectionHead(`📁 ${r}·根目录(${rl.length})`, rlCollapsed,
        () => { rlCollapsed ? state.bastionDirCollapsed.delete(rlKey) : state.bastionDirCollapsed.add(rlKey); renderSessionList(els.inputSessionSearch.value); },
        [{ label: '🔗 批量连接', action: () => batchBastionConnect(rl) }]);
      rlHead.style.paddingLeft = (8 + 14) + 'px'; // 与子目录同级缩进
      container.appendChild(rlHead);
      if (!rlCollapsed) for (const a of rl) container.appendChild(makeBastionAssetItem(a));
    }
  }
  // 无业务根的目录:平铺
  for (const dn of rootless) {
    const assets = map.get(dn) || [];
    const collapsed = state.bastionDirCollapsed.has(dn);
    container.appendChild(makeSectionHead(`📁 ${dn}(${assets.length})`, collapsed,
      () => { collapsed ? state.bastionDirCollapsed.delete(dn) : state.bastionDirCollapsed.add(dn); renderSessionList(els.inputSessionSearch.value); },
      [{ label: '🔗 批量连接', action: () => batchBastionConnect(assets) }]));
    if (collapsed) continue;
    for (const a of assets) container.appendChild(makeBastionAssetItem(a));
  }
  // 未分组(目录请求未完成或该设备不在任何目录)
  if (ungrouped && ungrouped.assets.length) {
    const collapsed = state.bastionDirCollapsed.has('__ungrouped__');
    container.appendChild(makeSectionHead(`🗂 未分组(${ungrouped.assets.length}${state.bastionGrouping ? ',分组中…' : ''})`, collapsed,
      () => { collapsed ? state.bastionDirCollapsed.delete('__ungrouped__') : state.bastionDirCollapsed.add('__ungrouped__'); renderSessionList(els.inputSessionSearch.value); },
      [{ label: '🔗 批量连接', action: () => batchBastionConnect(ungrouped.assets) }]));
    if (!collapsed) for (const a of ungrouped.assets) container.appendChild(makeBastionAssetItem(a));
  }
}

// 通过堡垒机 web 控制台发起连接:POST /shterm/api/deviceAccess/accessUrl
// (真实 H3C:请求 { misc, sessRemark, account, proto, dev } → 响应 { url: accessclient://... })
// 拿到 accessclient:// 后走和网页点击完全相同的解码+SSH 路径。
function bastionConnect(asset, accountName, proto, openSftp) {
  const wv = els.bastionWebview;
  if (!wv || !wv.src) { alert('请先在堡垒机浏览器打开 H3C 控制台并登录(🛡 → 🌐 堡垒机)'); openBastionPanel(); return; }
  const dev = asset.devId || asset.id || '';
  if (!dev) { alert('该资产缺少设备 ID,无法发起连接'); return; }
  const account = accountName || asset.recentAccount || (asset.accounts && asset.accounts[0]) || '*root';
  // 与真实 HAR(-2.har 成功请求)完全一致:misc 不带 appclient,H3C 前端从不发送该字段
  const body = { misc: { resolution: '80x24', tab: true, isDualAuth: false }, sessRemark: '', account, proto: proto || 'ssh', dev };
  bastionLog({ ev: 'accessUrl-req', asset: asset.name, dev, account, body });
  const bodyStr = JSON.stringify(body).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  setStatus(`请求堡垒机连接 ${asset.name}(${account})…`, 'var(--accent)');
  wv.executeJavaScript(
    `fetch('/shterm/api/deviceAccess/accessUrl',{method:'POST',headers:{'Content-Type':'application/json'},body:'${bodyStr}'}).then(function(r){return r.text()}).catch(function(){ return ''; })`
  ).then((txt) => {
    let url = '';
    try { url = (JSON.parse(txt).url) || ''; } catch { /* 非 JSON */ }
    if (!url || url.indexOf('accessclient://') !== 0) {
      bastionLog({ ev: 'accessUrl-fail', asset: asset.name, dev, resp: txt.slice(0, 300) });
      alert('堡垒机未返回连接凭证(可能已退出登录),请先在控制台重新登录');
      return;
    }
    bastionLog({ ev: 'accessUrl-ok', asset: asset.name, dev, account, token: url.slice(0, 60) + '…' });
    handleAccessClientUrl(url, openSftp, dev);
  }).catch((e) => { bastionLog({ ev: 'accessUrl-throw', error: e && e.message }); alert('请求堡垒机连接失败: ' + (e && e.message)); });
}

// 断开该 H3C 资产已打开的连接(标签保留,显示"已断开")
function bastionDisconnect(asset) {
  const key = 'h3c-' + (asset.devId || asset.id || '');
  let n = 0;
  for (const t of state.tabs.values()) {
    if (t.session && t.session.bastionKey === key && (t.status === 'connected' || t.status === 'connecting')) {
      disconnectTab(t.sessionId); n++;
    }
  }
  setStatus(n ? `已断开「${asset.name}」的连接` : `「${asset.name}」无进行中的连接`, n ? 'var(--green)' : 'var(--orange)');
}

// 断开所有堡垒机连接:accessclient 连的(bastion-*)和 JumpServer API 连的(jms-*)都断。
// 原来只断 bastion-*,JMS 方式连的会话断不掉(点"断开全部"没反应)。
function disconnectBastionAll() {
  for (const sid of [...state.tabs.keys()]) {
    if (isBastionSessionId(sid)) closeTab(sid);
  }
}

function loadBastion(url) {
  if (!url) { alert('请填堡垒机 Web 地址'); return; }
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  state.settings.bastionUrl = url;
  saveSettings();
  els.bastionEmpty.classList.remove('hidden');
  els.bastionEmpty.textContent = '加载中…';
  els.bastionLoading.classList.remove('hidden');
  els.bastionCurrent.textContent = url;
  els.bastionWebview.src = url;
  applyBastionZoom(); // 新页面同样套用已保存的缩放
}

// 画面缩放:webview 内容整体放大/缩小(0.5~2.5),状态持久化
function applyBastionZoom() {
  const wv = els.bastionWebview;
  try { if (wv.setZoomFactor) wv.setZoomFactor(state.bastionZoom); } catch { /* ignore */ }
  if (els.bastionZoomLabel) els.bastionZoomLabel.textContent = `${Math.round(state.bastionZoom * 100)}%`;
}
// 页面自动适配面板宽度(fit-to-width):整页加载后按 面板宽/页面内容宽 等比缩放(只缩不放,0.4~1),
// 保证堡垒机完整页面不被右侧遮挡。手动 A−/A+ 调整过则本会话内不再自动适配。
let bastionManualZoom = false;
function bastionFitToWidth() {
  const wv = els.bastionWebview;
  if (!wv || !wv.executeJavaScript) return;
  const panelW = (els.bastionPanel ? els.bastionPanel.offsetWidth : 0) - 24;
  if (panelW <= 0) return;
  wv.executeJavaScript('document.documentElement.scrollWidth || document.body.scrollWidth || 0')
    .then((sw) => {
      if (!sw || sw <= 0) return;
      const z = Math.min(1, Math.max(0.4, panelW / sw));
      state.bastionZoom = Math.round(z * 100) / 100;
      applyBastionZoom();
    }).catch(() => {});
}
function setBastionZoom(delta) {
  bastionManualZoom = true; // 手动调整过 → 不再自动适配
  state.bastionZoom = Math.min(2.5, Math.max(0.5, Math.round((state.bastionZoom + delta) * 10) / 10));
  applyBastionZoom();
  saveSettings();
}

// 处理 accessclient:// —— 解码 token(H3C 单点登录凭证) → 用 Polaris 终端连 SSH
// openSftp:连上后顺带打开 SFTP 面板;devId:标记来源资产(供会话列表按资产断开)
async function handleAccessClientUrl(acUrl, openSftp, devId) {
  bastionLog({ ev: 'token-decode', token: acUrl.slice(0, 60) + '…' });
  const r = await window.api.bastionDecode(acUrl);
  if (!r.ok) { bastionLog({ ev: 'token-decode-fail', error: r.error }); alert('解码堡垒机连接失败: ' + r.error); return; }
  const info = r.info;
  // hn = 堡垒机 SSH 网关(TERM-SSHD,实测监听 hn:pn;probe 证实目标机 sh 被防火墙丢弃不可直连)。
  // 无论 direct/代理模式,SSH 都经网关:连 hn:pn,用户名=目标账号 sa,密码=一次性密码 OTP,网关按 OTP 路由到目标。
  const gw = info.hn && String(info.hn).trim();
  const host = gw ? gw : ((info.mode === 'direct' && info.sh) ? info.sh : (info.hn || info.sh || ''));
  const port = Number(info.pn) || 22;
  const account = info.sa || '';
  const password = info.pw || '';
  bastionLog({ ev: 'token-decode-ok', mode: info.mode, viaGateway: !!gw, host, port, account, sn: info.sn, st: info.st, cp: info.cp, hasPw: !!password });
  if (!host || !password) { bastionLog({ ev: 'ssh-abort', reason: 'host/pw 缺失', host, hasPw: !!password }); alert('堡垒机连接信息不完整'); return; }
  // 编码按 token 里的 cp 字段(如 UTF-8 / GBK)映射
  const cp = String(info.cp || 'UTF-8').toLowerCase();
  const encoding = (cp.includes('gbk') || cp.includes('gb2312')) ? 'gbk' : (cp.includes('utf-8') ? 'utf8' : 'utf8');
  const session = {
    id: `bastion-${++state.jmsSeq}`,
    name: info.sn || info.st || `${account}@${host}`,
    host,
    port,
    username: account,
    password, // 一次性密码(OTP:xxx),堡垒机 SSH 代理据此路由到目标主机
    encoding,
    tag_color: '',
    bastionKey: devId ? `h3c-${devId}` : null, // 会话列表按资产断开用
    // 真实目标主机(token 的 sh):host 是堡垒机网关,所有资产都一样,
    // SFTP/标签展示用它区分是哪台主机(否则两台堡垒主机分不清 SFTP 是谁的)
    displayHost: (info.sh && String(info.sh).trim()) || host,
  };
  bastionLog({ ev: 'ssh-connect-start', sessionId: session.id, host, port, account, name: session.name });
  // 并行探测实际连接目标(TCP+banner),不阻塞连接,结果进诊断包
  if (window.api.bastionProbe) {
    window.api.bastionProbe({ host, port, timeoutMs: 6000 })
      .then((r) => bastionLog({ ev: 'net-probe', host, port, ...r }))
      .catch((e) => bastionLog({ ev: 'net-probe-throw', error: e.message }));
  }
  connectToServer(session);
  setStatus(`堡垒机直连: ${session.name}`, 'var(--green)');
  // 连接成功 → 最小化到会话列表,终端在前台(SSH 连接独立,不受页面收起影响)
  minimizeBastion();
  if (openSftp) setTimeout(() => toggleSftpPanel(), 800);
}

// 拦截堡垒机触发的 accessclient://(外部工具/单点登录)
function initBastionWebview() {
  const wv = els.bastionWebview;
  if (!wv) return;
  // Electron webview 内部 WebContents 每次导航可能重新 attach,did-stop-loading 等
  // 事件监听会在底层累积(触发 MaxListenersExceededWarning,良性但刷屏)。放宽阈值消除警告。
  try { if (wv.setMaxListeners) wv.setMaxListeners(50); } catch { /* ignore */ }
  wv.addEventListener('will-navigate', (e) => {
    if (e.url && e.url.startsWith('accessclient://')) { e.preventDefault(); handleAccessClientUrl(e.url); }
  });
  wv.addEventListener('new-window', (e) => {
    // accessclient:// → 接管连接;其他新窗口链接 → 留在同一 webview 打开(避免弹窗)
    e.preventDefault();
    if (e.url && e.url.startsWith('accessclient://')) handleAccessClientUrl(e.url);
    // file:// 一律拒绝:webview 是网页上下文,允许 file:// 导航等于让任意网页读本地文件
    else if (e.url && !e.url.startsWith('about:') && !e.url.startsWith('file:')) { try { wv.src = e.url; } catch { /* ignore */ } }
  });
  // 加载状态:开始显示"加载中"转圈,成功隐藏,失败显示错误
  wv.addEventListener('did-start-loading', () => {
    bastionPageStableTs = 0; // 开始导航 → 页面不再视为稳定
    els.bastionLoading.classList.remove('hidden');
    els.bastionEmpty.classList.remove('hidden');
    els.bastionEmpty.textContent = '加载中…';
  });
  wv.addEventListener('did-stop-loading', () => {
    bastionPageStableTs = Date.now(); // 停止加载 → 记稳定起点(2s 内不注入/轮询)
    els.bastionLoading.classList.add('hidden');
    els.bastionEmpty.classList.add('hidden');
    try { if (wv.getURL && wv.getURL()) els.bastionCurrent.textContent = wv.getURL(); } catch { /* ignore */ }
    // 页面加载完:注入资产捕获钩子 + 自动适配面板宽度(完整页面不遮挡) + 若有待填充账号密码则自动填充。
    // 登录页会连续跳转(每次 did-stop-loading 都触发注入),而导航切换瞬间 executeJavaScript
    // 帧层面必失败 → debounce:最后一次停止加载 800ms 且未再导航才注入,消除启动期错误爆发。
    bastionInjectDisabled = false; // 页面重新加载 → 恢复自动注入尝试
    bastionSpasLogged = false;
    bastionInjectFails = 0;
    bastionInjectBackoff = 8000;
    // 页面重载 → 重新允许"拉取完成/失败"提示(新页面状态未知)
    bastionFetchOkNotified = false;
    bastionFetchFailNotified = false;
    clearTimeout(bastionInjectDebounce);
    bastionInjectDebounce = setTimeout(() => {
      if (bastionWebviewLoading()) return; // debounce 期间又开始导航 → 放弃本次
      injectBastionAssetHook(false); // 页面已停 800ms:不再要求 2s 稳定(debounce 本身就是稳定等待)
    }, 800);
    if (!bastionManualZoom) setTimeout(bastionFitToWidth, 250);
    setTimeout(() => { if (!bastionWebviewLoading()) pollBastionAssets(true); }, 1200);
    // 页面就绪后主动拉一次全量(不依赖前端是否请求过资产 API;未登录时接口会失败,静默跳过)
    setTimeout(() => { if (!bastionWebviewLoading()) triggerBastionFullFetch(); }, 3500);
    if (bastionPendingFill) {
      const s = bastionPendingFill;
      setTimeout(() => { bastionAutoFill(s); }, 800);
      bastionPendingFill = null;
    }
  });
  // 地址栏显示当前地址 + 页面标题(诊断空白页:能看到加载到哪个地址/标题)
  wv.addEventListener('did-navigate', (e) => {
    try { if (e.url && e.url !== 'about:blank') els.bastionCurrent.textContent = e.url; } catch { /* ignore */ }
  });
  wv.addEventListener('page-title-updated', (e) => {
    try {
      const title = (e.title || '').trim();
      if (title) els.bastionCurrent.textContent = `${title} — ${els.bastionCurrent.textContent.split(' — ').pop()}`;
    } catch { /* ignore */ }
  });
  wv.addEventListener('did-fail-load', (e) => {
    if (e && e.isMainFrame === false) return; // 子资源失败不提示
    els.bastionLoading.classList.add('hidden');
    els.bastionEmpty.classList.remove('hidden');
    const code = e.errorCode || '未知';
    const desc = (e.errorDescription || '').replace(/^ERR_/, '');
    els.bastionEmpty.textContent = `⚠️ 加载失败(${code}${desc ? ' ' + desc : ''})\n请检查堡垒机地址或网络,可点右上角 ↻ 重试`;
  });
}

async function openTunnelModal() {
  // 填充会话下拉(全部打开连接,未连的置灰提示);Telnet 无 SSH 通道,直接跳过
  const sel = els.tunnelSession;
  sel.innerHTML = '';
  for (const t of state.tabs.values()) {
    if (t.session && (t.session.protocol || 'ssh') === 'telnet') continue;
    const opt = document.createElement('option');
    opt.value = t.sessionId;
    const connected = t.status === 'connected';
    opt.textContent = `${t.session.name} (${t.session.host})${connected ? '' : ' · 未连接'}`;
    opt.disabled = !connected;
    sel.appendChild(opt);
  }
  if (!els.tunnelForm.classList.contains('hidden')) { els.tunnelForm.classList.add('hidden'); updateTunnelTypeFields(); }
  await refreshTunnels();
  els.tunnelModal.classList.remove('hidden');
}

async function refreshTunnels() {
  const res = await window.api.tunnelList();
  const list = res && res.ok ? res.tunnels : [];
  const box = els.tunnelList;
  box.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'tunnel-empty dim';
    empty.textContent = '还没有隧道。点「＋ 新建隧道」创建。';
    box.appendChild(empty);
    return;
  }
  for (const t of list) {
    const row = document.createElement('div');
    row.className = 'tunnel-item';
    const main = document.createElement('div');
    main.className = 'tunnel-main';
    const title = document.createElement('div');
    title.className = 'tunnel-title';
    title.textContent = `${t.name} · ${t.type.toUpperCase()} · ${t.status === 'active' ? '运行中' : '已停'}`;
    const meta = document.createElement('div');
    meta.className = 'tunnel-meta dim';
    if (t.type === 'remote') meta.textContent = `本地 ${t.localHost}:${t.localPort} ← 远程 ${t.remotePort}`;
    else meta.textContent = `${t.localHost}:${t.localPort} → ${t.remoteHost || ''}:${t.remotePort}`;
    main.appendChild(title);
    main.appendChild(meta);
    const del = document.createElement('button');
    del.className = 'btn-mini danger';
    del.textContent = '停用';
    del.title = '停用并删除这条隧道';
    del.addEventListener('click', async () => {
      await window.api.tunnelDelete(t.id);
      refreshTunnels();
    });
    row.appendChild(main);
    row.appendChild(del);
    box.appendChild(row);
  }
}

function toggleTunnelForm() {
  els.tunnelForm.classList.toggle('hidden');
  updateTunnelTypeFields();
}

// 类型切换:动态代理不需要"远程主机/端口"
function updateTunnelTypeFields() {
  const isDynamic = els.tunnelType.value === 'dynamic';
  els.tunnelRemoteRow.classList.toggle('hidden', isDynamic);
}

async function createTunnel() {
  const res = await window.api.tunnelCreate({
    sessionId: els.tunnelSession.value,
    type: els.tunnelType.value,
    localPort: Number(els.tunnelLocalport.value),
    name: els.tunnelName.value.trim(),
    remoteHost: els.tunnelRemotehost.value.trim(),
    remotePort: Number(els.tunnelRemoteport.value),
  });
  if (res && res.ok) {
    els.tunnelForm.classList.add('hidden');
    await refreshTunnels();
    setStatus(`隧道已创建: ${res.tunnel.name}`, 'var(--green)');
  } else {
    alert(res && res.error ? res.error : '创建失败');
  }
}

// 渲染结果:每台主机一张卡片(状态 + 输出)
function renderBatchResults(results) {
  const box = els.batchResults;
  box.innerHTML = '';
  const okCount = results.filter((r) => r.ok).length;
  const head = document.createElement('div');
  head.className = 'batch-res-head';
  head.textContent = `共 ${results.length} 台 · 成功 ${okCount} · 失败 ${results.length - okCount}`;
  box.appendChild(head);
  for (const r of results) {
    const card = document.createElement('div');
    card.className = `batch-res-item ${r.ok ? 'ok' : 'err'}`;
    const title = document.createElement('div');
    title.className = 'batch-res-title';
    title.textContent = `${r.name || r.host} · ${r.ok ? '成功' : '失败'} · 退出码 ${r.code ?? '-'} · ${r.durationMs}ms`;
    const pre = document.createElement('pre');
    pre.className = 'batch-res-output';
    pre.textContent = r.error ? `执行失败: ${r.error}` : r.output;
    card.appendChild(title);
    card.appendChild(pre);
    box.appendChild(card);
  }
  box.scrollTop = box.scrollHeight;
}

// 横向工具栏开关按钮的激活态:面板打开 → 按钮高亮
function syncPanelButtons() {
  els.btnSftpToggle.classList.toggle('active', state.sftp.visible);
  els.btnAi.classList.toggle('active', !els.aiPanel.classList.contains('hidden'));
  els.btnCmd.classList.toggle('active', !els.cmdPanel.classList.contains('hidden'));
  els.btnBatch.classList.toggle('active', !els.batchPanel.classList.contains('hidden'));
}

// 刷新命令记录开关按钮的显示(● 记录中 / ○ 已暂停)
function updateCmdRecordBtn() {
  const on = state.settings.cmdRecord !== false;
  els.cmdRecordToggle.textContent = on ? '● 记录中' : '○ 已暂停';
  els.cmdRecordToggle.classList.toggle('active', on);
  els.cmdRecordToggle.title = on ? '点击暂停命令记录' : '点击开启命令记录';
}

// 切换命令记录开关(设置面板复选框 / 面板头部按钮共用)
function toggleCmdRecord() {
  state.settings.cmdRecord = state.settings.cmdRecord === false;
  saveSettings();
  updateCmdRecordBtn();
  setStatus(state.settings.cmdRecord ? '命令记录已开启' : '命令记录已暂停', state.settings.cmdRecord ? 'var(--green)' : 'var(--orange)');
}

// =====================================================================
// 会话录制与回放
// 原理:录制 = 主进程在数据流里把"输出字节 + 输入命令"按时间戳写进 JSONL 文件,
//       回放 = 渲染层按时间轴把录好的内容再写一遍到独立的 xterm 里。
// =====================================================================

// 毫秒 → mm:ss(回放时间显示用)
function fmtDur(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(s / 60), r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

// 字节数 → 人类可读(录制列表显示大小)
function fmtSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

// 当前激活的标签(没有连接时返回 null)
function currentTab() { return state.tabs.get(state.activeSessionId) || null; }

// 刷新工具栏录制按钮 + 下拉菜单:跟随"当前激活标签"的录制状态(红点 + 文案)
function updateRecordBtn() {
  const t = currentTab();
  const on = !!(t && state.recording.has(t.sessionId));
  els.btnRec.classList.toggle('recording', on);
  els.btnRec.classList.toggle('active', on);
  els.btnRec.textContent = on ? '录制中' : '录制';
  els.btnRec.title = on ? '正在录制当前会话,点开后选「停止录制」' : '录制 / 回放(点开后选「开始录制」或「回放列表」)';
  // 下拉菜单第一项:跟随录制状态(未录=开始,录中=停止)
  const toggleItem = els.recMenu.querySelector('[data-rec-act="toggle"]');
  if (toggleItem) toggleItem.textContent = on ? '■ 停止录制' : '● 开始录制';
}

// 录制/回放下拉菜单:点按钮弹出(定位在按钮下方),选完或点外面收起
function toggleRecMenu() {
  if (!els.recMenu.classList.contains('hidden')) { els.recMenu.classList.add('hidden'); return; }
  const rect = els.btnRec.getBoundingClientRect();
  els.recMenu.style.left = `${rect.left}px`;
  els.recMenu.style.top = `${rect.bottom + 4}px`;
  els.recMenu.classList.remove('hidden');
}
function closeRecMenu() { els.recMenu.classList.add('hidden'); }

// 下拉菜单点击:toggle=开始/停止录制,list=打开回放列表
function onRecMenuClick(e) {
  const act = e.target.closest('.ctx-item');
  if (!act) return;
  closeRecMenu();
  const name = act.dataset.recAct;
  if (name === 'toggle') toggleRecord();
  else if (name === 'list') openRecordingsModal();
}

// =====================================================================
// 智能命令推荐(参考 Chaterm):当前主机历史高频 + 常用运维命令库,一键发送
// =====================================================================
function toggleRecommendMenu() {
  if (!els.recommendMenu.classList.contains('hidden')) { els.recommendMenu.classList.add('hidden'); return; }
  const rect = els.btnRecommend.getBoundingClientRect();
  els.recommendMenu.style.left = `${Math.max(8, rect.left)}px`;
  els.recommendMenu.style.top = `${rect.bottom + 4}px`;
  els.recommendMenu.classList.remove('hidden');
  refreshRecommendMenu();
}
function closeRecommendMenu() { els.recommendMenu.classList.add('hidden'); }

// 拉取推荐并渲染:当前激活标签的主机 → cmd:recommend(历史高频 + 常用库)
async function refreshRecommendMenu() {
  const t = currentTab();
  const host = t && t.session ? t.session.host : null;
  els.recommendHost.textContent = host ? `@ ${host}` : '未连接会话';
  const box = els.recommendList;
  box.textContent = '';
  // AI 推荐入口(恒在最上):结合当前终端上下文让模型推荐下一条命令
  const aiRow = document.createElement('div');
  aiRow.className = 'recommend-item ai-row';
  aiRow.textContent = '🤖 AI 推荐(基于当前终端上下文)';
  aiRow.title = '让 AI 结合该主机历史命令与终端最近输出,推荐一条下一条要执行的命令(需在 AI ⚙ 配置 API Key)';
  aiRow.addEventListener('click', aiRecommendCommand);
  box.appendChild(aiRow);
  let list = [];
  try {
    const res = await window.api.recommendCmds(host);
    if (res && res.ok) list = res.list || [];
  } catch { /* 保留空列表 */ }
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'recommend-empty';
    empty.textContent = '暂无历史推荐';
    const hint = document.createElement('span');
    hint.className = 'dim';
    hint.textContent = host ? '在该主机执行过命令后,高频命令会出现在这里' : '连接一个会话后,会基于该主机历史 + 常用运维命令推荐';
    empty.appendChild(hint);
    box.appendChild(empty);
    return;
  }
  for (const item of list) {
    const row = document.createElement('div');
    row.className = 'recommend-item ' + item.source;
    row.title = (item.source === 'history' ? `本主机执行过 ${item.count} 次` : item.desc) + ' · 点击发送到当前终端';
    const cmdEl = document.createElement('span');
    cmdEl.className = 'recommend-cmd';
    cmdEl.textContent = item.command;
    const meta = document.createElement('span');
    meta.className = 'recommend-meta';
    const badge = document.createElement('span');
    badge.className = 'recommend-badge ' + item.source;
    badge.textContent = item.source === 'history' ? '历史' : '常用';
    meta.appendChild(badge);
    if (item.source === 'history') {
      const count = document.createElement('span');
      count.className = 'recommend-count';
      count.textContent = `×${item.count}`;
      meta.appendChild(count);
    } else if (item.desc) {
      const desc = document.createElement('span');
      desc.className = 'recommend-count';
      desc.textContent = item.desc;
      meta.appendChild(desc);
    }
    row.append(cmdEl, meta);
    row.addEventListener('click', () => { closeRecommendMenu(); runInActiveTerminal(item.command); });
    box.appendChild(row);
  }
}

// ---- AI 命令推荐(参考 Chaterm 的"智能命令推荐"):模型结合上下文推荐下一条命令 ----
let aiRecommendBusy = false;
async function aiRecommendCommand() {
  const av = activeAiVendor();
  if (!av || !av.key) { alert('请先在 AI ⚙ 里配置当前厂商的 API Key'); return; }
  if (aiRecommendBusy) return;
  aiRecommendBusy = true;
  const t = currentTab();
  const hostLabel = t && t.session
    ? (t.session.displayHost ? `${t.session.name}(${t.session.displayHost})` : `${t.session.name}(${t.session.host})`)
    : '(未连接)';
  const aiRow = els.recommendList.querySelector('.recommend-ai-row');
  if (aiRow) { aiRow.classList.add('loading'); aiRow.textContent = '🤖 AI 思考中…'; }
  try {
    // 历史:该主机的推荐清单(高频 + 常用)
    let history = '';
    try {
      const res = await window.api.recommendCmds(t && t.session ? t.session.host : null);
      if (res && res.ok) history = (res.list || []).slice(0, 12).map((x) => x.command).join('\n');
    } catch { /* ignore */ }
    // 上下文:终端最近 ~40 行输出
    let context = '';
    try {
      if (t && t.term) {
        const b = t.term.buffer.active;
        const lines = [];
        for (let i = Math.max(0, b.length - 40); i < b.length; i++) {
          const l = b.getLine(i);
          if (l) lines.push(l.translateToString(false));
        }
        context = lines.join('\n').slice(-1500);
      }
    } catch { /* ignore */ }
    const res = await window.api.aiSuggestCmd({
      apiKey: await decryptSecret(av.key),
      url: av.url, model: av.model, format: av.format,
      host: hostLabel, history, context,
    });
    if (aiRow) aiRow.remove();
    if (!res || !res.ok) { alert('AI 推荐失败: ' + ((res && res.error) || '未知错误')); return; }
    if (!res.command) { alert('AI 未给出命令'); return; }
    renderAiRecommendItem(res);
  } catch (e) {
    if (aiRow) aiRow.remove();
    alert('AI 推荐异常: ' + (e && e.message));
  } finally {
    aiRecommendBusy = false;
  }
}

// 渲染 AI 推荐结果:插在 AI 入口行之后,点击发送到当前终端
function renderAiRecommendItem(res) {
  const box = els.recommendList;
  for (const old of box.querySelectorAll('.recommend-item.ai-result')) old.remove(); // 只保留最新一条
  const row = document.createElement('div');
  row.className = 'recommend-item history ai-result';
  row.title = 'AI 推荐 · 点击发送到当前终端';
  const cmdEl = document.createElement('span');
  cmdEl.className = 'recommend-cmd';
  cmdEl.textContent = res.command;
  const meta = document.createElement('span');
  meta.className = 'recommend-meta';
  const badge = document.createElement('span');
  badge.className = 'recommend-badge history';
  badge.textContent = 'AI';
  meta.appendChild(badge);
  if (res.reason) {
    const d = document.createElement('span');
    d.className = 'recommend-count';
    d.textContent = res.reason;
    meta.appendChild(d);
  }
  row.append(cmdEl, meta);
  row.addEventListener('click', () => { closeRecommendMenu(); runInActiveTerminal(res.command); });
  const aiRow = box.querySelector('.recommend-ai-row');
  if (aiRow) aiRow.after(row);
  else box.prepend(row);
}

// 录制开关:当前标签没录 → 开始;在录 → 停止
async function toggleRecord() {
  const t = currentTab();
  if (!t) { setStatus('请先连接一个会话再录制', 'var(--orange)'); return; }
  const sid = t.sessionId;
  if (state.recording.has(sid)) {
    // ---- 停止录制 ----
    const res = await window.api.recStop(sid);
    state.recording.delete(sid);
    updateRecordBtn();
    if (res && res.ok) setStatus('录制已保存', 'var(--green)');
    else setStatus(res && res.error ? `停止失败: ${res.error}` : '停止失败', 'var(--red)');
  } else {
    // ---- 开始录制:把会话信息(名称/主机/编码/窗口尺寸)传给主进程,回放时才能还原 ----
    const meta = {
      sessionName: t.session ? t.session.name : t.title,
      host: t.session ? t.session.host : '',
      port: t.session ? (t.session.port || 22) : 22,
      username: t.session ? (t.session.username || '') : '',
      encoding: t.session ? (t.session.encoding || 'utf8') : 'utf8',
      cols: t.term.cols || 120,
      rows: t.term.rows || 32,
    };
    const res = await window.api.recStart(sid, meta);
    if (res && res.ok) { state.recording.set(sid, true); setStatus('开始录制', 'var(--red)'); }
    else setStatus(res && res.error ? `录制失败: ${res.error}` : '录制失败', 'var(--red)');
    updateRecordBtn();
  }
}

// 打开录制列表弹窗
async function openRecordingsModal() {
  const res = await window.api.recList();
  renderRecordings(res && res.ok ? res.recordings : []);
  els.recordingsModal.classList.remove('hidden');
}
function closeRecordingsModal() { els.recordingsModal.classList.add('hidden'); }

// 渲染录制列表(全部用 textContent,不拼 HTML,防止会话名里的特殊字符注入)
function renderRecordings(list) {
  const box = els.recordingsList;
  box.innerHTML = '';
  els.recordingsEmpty.classList.toggle('hidden', (list || []).length > 0);
  for (const r of list || []) {
    const item = document.createElement('div');
    item.className = 'rec-item';
    const main = document.createElement('div');
    main.className = 'rec-main';
    const title = document.createElement('div');
    title.className = 'rec-title';
    title.textContent = r.session_name || '未知会话';
    const meta = document.createElement('div');
    meta.className = 'rec-meta';
    meta.textContent = `${r.username || ''}@${r.host}:${r.port} · ${r.started_at || ''} · ${fmtDur(r.duration_ms)} · ${fmtSize(r.size)}`;
    main.appendChild(title);
    main.appendChild(meta);
    const actions = document.createElement('div');
    actions.className = 'rec-actions';
    const btnPlay = document.createElement('button');
    btnPlay.className = 'btn-mini';
    btnPlay.textContent = '▶ 回放';
    btnPlay.title = '回放这段录制';
    btnPlay.addEventListener('click', () => openReplay(r.id));
    const btnDel = document.createElement('button');
    btnDel.className = 'btn-mini danger';
    btnDel.textContent = '删除';
    btnDel.title = '删除这段录制';
    btnDel.addEventListener('click', () => deleteRecording(r.id));
    actions.appendChild(btnPlay);
    actions.appendChild(btnDel);
    item.appendChild(main);
    item.appendChild(actions);
    box.appendChild(item);
  }
}

async function deleteRecording(id) {
  if (!confirm('确定删除这条录制?JSONL 文件也会一并删除。')) return;
  const res = await window.api.recDelete(id);
  if (res && res.ok) {
    const listRes = await window.api.recList();
    renderRecordings(listRes && listRes.ok ? listRes.recordings : []);
  } else {
    alert(res && res.error ? res.error : '删除失败');
  }
}

// ---------- 回放播放器 ----------
// replay 对象只在回放弹窗打开期间存在:
//   events:  [{ t, kind, text }] 已按时间排好
//   cursor:  下一个待播放事件的下标
//   clock:   虚拟时钟(毫秒,相对录制开始)——按"真实时间 × 倍速"推进
//   speed / playing / timer / term / inputItems / totalMs / dragging / wasPlaying
let replay = null;

// 从输入事件还原命令行列表:
//   回车(\r\n)提交一行;退格(\x7f/\b)删掉末尾;Ctrl+C/U 清空当前行;
//   两次按键间隔超过 1 秒,视为上一条命令结束、新命令开始
function reconstructInputs(events) {
  const items = [];
  let buf = '';
  let lastT = -Infinity;
  const commit = (t) => { const s = buf.trim(); if (s) items.push({ t, text: s }); buf = ''; };
  for (const evt of events) {
    if (evt.kind !== 'i') continue;
    const d = String(evt.text || '');
    if (evt.t - lastT > 1000 && buf) commit(evt.t); // 停顿超 1s:上一条算结束
    for (const ch of d) {
      if (ch === '\r' || ch === '\n') commit(evt.t);
      else if (ch === '\x7f' || ch === '\b') buf = buf.slice(0, -1);
      else if (ch === '\x03' || ch === '\x15') buf = '';
      else if (ch >= ' ' && ch !== '\x1b') buf += ch;
    }
    lastT = evt.t;
  }
  if (buf.trim()) items.push({ t: lastT === -Infinity ? 0 : lastT, text: buf.trim() });
  return items;
}

// 渲染输入侧栏;playingIndex 为当前高亮行(-1 = 不高亮)
function renderReplayInputs(items, playingIndex) {
  const box = els.replayInputList;
  box.innerHTML = '';
  items.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'replay-input-item' + (i === playingIndex ? ' playing' : '');
    row.title = '点击跳转到这个时刻';
    const time = document.createElement('span');
    time.className = 'ri-time';
    time.textContent = fmtDur(it.t);
    const text = document.createElement('span');
    text.className = 'ri-text';
    text.textContent = it.text;
    row.appendChild(time);
    row.appendChild(text);
    row.addEventListener('click', () => { seekReplay(it.t); });
    box.appendChild(row);
  });
}

// 打开回放弹窗:读录制文件 → 建独立 xterm → 铺好播放器状态
async function openReplay(recordId) {
  // 打开新回放前先收掉上一个:dispose 旧 term + 清掉播放定时器,否则旧 interval 永久空转、
  // 旧 xterm 的 ResizeObserver/canvas 引用泄漏
  if (replay) {
    if (replay.timer) { clearInterval(replay.timer); replay.timer = null; }
    try { replay.term && replay.term.dispose(); } catch { /* ignore */ }
    replay = null;
  }
  const res = await window.api.recReplay(recordId);
  if (!res || !res.ok) { alert(res && res.error ? res.error : '回放加载失败'); return; }
  const { meta, events } = res;
  const inputItems = reconstructInputs(events);

  // 回放终端:尺寸按录制时的来,画面跟直播一致;不进 state.tabs,只在弹窗里
  const termEl = els.replayTerm;
  termEl.innerHTML = ''; // 清掉上一次回放留下的终端
  const curTheme = THEMES[state.settings.theme] || THEMES.dark;
  const term = new XTermClass({
    fontFamily: state.settings.fontFamily,
    fontSize: state.settings.fontSize,
    cursorBlink: false,
    scrollback: 5000,
    cols: meta.cols || 120,
    rows: meta.rows || 32,
    theme: { ...curTheme.term },
  });
  term.open(termEl);

  const totalMs = events.length ? events[events.length - 1].t : 0;
  replay = {
    meta, events, inputItems, cursor: 0, clock: 0,
    playing: false, speed: 1, timer: null, term, totalMs,
    lastActiveIdx: -1, dragging: false, wasPlaying: false,
  };
  els.replayTitle.textContent = `${meta.session_name || ''} · ${meta.host || ''}`;
  // 没有输入事件时把侧栏收起来(纯输出回放)
  els.replayInputSide.classList.toggle('hidden', inputItems.length === 0);
  renderReplayInputs(inputItems, -1);
  els.replayPlay.textContent = '▶ 播放';
  els.replaySpeed.textContent = '1x';
  els.replayProgress.min = 0;
  els.replayProgress.max = Math.max(1, totalMs || 1);
  els.replayProgress.value = 0;
  els.replayTime.textContent = `00:00 / ${fmtDur(totalMs)}`;
  els.replayModal.classList.remove('hidden');
  // 等 xterm 渲染完成后再聚焦,否则焦点抢不过去
  setTimeout(() => { try { term.focus(); } catch { /* ignore */ } }, 30);
}

// 播放循环:按"真实时间 × 倍速"推进虚拟时钟,把到点的输出/输入都执行掉
function replayLoop() {
  const p = replay;
  if (!p || !p.playing) return;
  const now = Date.now();
  p.clock += (now - p.lastReal) * p.speed;
  p.lastReal = now;
  let guard = 0;
  while (p.cursor < p.events.length && p.events[p.cursor].t <= p.clock) {
    const evt = p.events[p.cursor];
    if (evt.kind === 'o') { try { p.term.write(evt.text); } catch { /* ignore */ } }
    p.cursor++;
    if (++guard > 10000) break; // 安全阀:防止极端情况卡死
  }
  if (!p.dragging) updateReplayProgress();
  updateReplayActiveInput();
  if (p.cursor >= p.events.length) {
    // 播完了:停住,按钮变"重放"(再点会从头再来)
    p.playing = false;
    if (p.timer) { clearInterval(p.timer); p.timer = null; }
    els.replayPlay.textContent = '▶ 重放';
    updateReplayProgress();
  }
}

function playReplay() {
  const p = replay;
  if (!p || p.playing) return;
  if (p.cursor >= p.events.length) seekReplay(0); // 播完了 → 从头再来
  p.playing = true;
  p.lastReal = Date.now();
  p.timer = setInterval(replayLoop, 50); // 每 50ms 推进一步,流畅且开销小
  els.replayPlay.textContent = '⏸ 暂停';
}

function pauseReplay() {
  const p = replay;
  if (!p) return;
  p.playing = false;
  if (p.timer) { clearInterval(p.timer); p.timer = null; }
  els.replayPlay.textContent = '▶ 播放';
}

function replayPlayPause() {
  const p = replay;
  if (!p) return;
  if (p.playing) pauseReplay(); else playReplay();
}

// 循环切换倍速:1x → 2x → 4x → 0.5x
function replaySpeed() {
  const p = replay;
  if (!p) return;
  const speeds = [1, 2, 4, 0.5];
  p.speed = speeds[(speeds.indexOf(p.speed) + 1) % speeds.length];
  els.replaySpeed.textContent = (p.speed === 0.5 ? '0.5x' : p.speed + 'x');
}

// 跳到某个时间点:清屏 → 把 <= 目标时刻的所有输出瞬间写完(输入侧栏同步高亮)
function seekReplay(targetT) {
  const p = replay;
  if (!p) return;
  p.clock = targetT;
  p.cursor = 0;
  try { p.term.reset(); } catch { /* ignore */ }
  for (const evt of p.events) {
    if (evt.t > targetT) break;
    if (evt.kind === 'o') { try { p.term.write(evt.text); } catch { /* ignore */ } }
    p.cursor++;
  }
  updateReplayProgress();
  updateReplayActiveInput();
}

function updateReplayProgress() {
  const p = replay;
  if (!p) return;
  const t = Math.min(p.clock, p.totalMs);
  els.replayProgress.value = t;
  els.replayTime.textContent = `${fmtDur(t)} / ${fmtDur(p.totalMs)}`;
}

// 输入侧栏高亮:跟着时钟定位到"正在进行"的那条命令
function updateReplayActiveInput() {
  const p = replay;
  if (!p || !p.inputItems.length) return;
  let idx = -1;
  for (let i = 0; i < p.inputItems.length; i++) {
    if (p.inputItems[i].t <= p.clock) idx = i; else break;
  }
  if (idx !== p.lastActiveIdx) {
    p.lastActiveIdx = idx;
    renderReplayInputs(p.inputItems, idx);
  }
}

// 显示全部:不播了,一次性把内容全部渲染出来(相当于跳到末尾)
function replayShowAll() {
  const p = replay;
  if (!p) return;
  pauseReplay();
  seekReplay(p.totalMs);
  els.replayPlay.textContent = '▶ 重放';
}

function closeReplay() {
  pauseReplay();
  if (replay && replay.term) { try { replay.term.dispose(); } catch { /* ignore */ } }
  replay = null;
  els.replayModal.classList.add('hidden');
  els.replayTerm.innerHTML = '';
}

// 收起输入侧栏(纯看终端画面)
function closeReplaySide() { els.replayInputSide.classList.add('hidden'); }

async function connectToServer(session) {
  const sessionId = `sess-${++sessionSeq}`;
  const title = session.name; // 标签只显示名称,去掉 username@host,更紧凑

  // ---- 标签头 ----
  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  if (session.tag_color) tabEl.classList.add(`tab-color-${session.tag_color}`); // 标签颜色标记
  // 标签只显示名称(悬停时显示 ✕ 关闭按钮);状态点和 OS 徽标已去掉
  const titleSpan = document.createElement('span');
  titleSpan.className = 'tab-title';
  titleSpan.textContent = title;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'tab-close';
  closeBtn.textContent = '✕';
  tabEl.appendChild(titleSpan);
  tabEl.appendChild(closeBtn);
  tabEl.addEventListener('click', (e) => {
    if (e.target !== closeBtn) activateTab(sessionId);
  });
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(sessionId);
  });
  // 右键标签:关闭/复制/重命名/定位 菜单
  tabEl.addEventListener('contextmenu', (e) => {
    e.stopPropagation(); // 不触发会话列表的右键
    showTabMenu(e, sessionId);
  });
  // 注意:标签不直接塞进标签栏,由 renderTabs() 按分屏布局统一渲染

  // ---- 终端面板 ----
  // 注意:paneEl 不直接塞进容器,而是由 renderLayout 挂到分屏布局的某个面板槽里
  const paneEl = document.createElement('div');
  paneEl.className = 'term-pane';
  // 分屏时点击终端面板 = 选中该会话:否则快捷命令/AI 执行/搜索/录制等走
  // state.activeSessionId 的操作,都发到上一次激活的标签(通常是最后一个/最右)。
  paneEl.addEventListener('mousedown', () => {
    if (state.activeSessionId !== sessionId) activateTab(sessionId);
  });
  // 终端面板右键菜单:选择/复制/粘贴(与 Xshell 一致)。xterm 鼠标拖选默认开启,
  // 但右键若无菜单,选中后没有明确的复制入口 —— 这里补上。
  paneEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const sel = term.getSelection();
    showCtxMenu(e.clientX, e.clientY, [
      { label: '📋 复制', action: () => { const s = term.getSelection(); if (s) window.api.copyText(s); } },
      { label: '📥 粘贴', action: () => {
        const t = window.api.readClipboard();
        if (t) term.paste(t);
        refocusTerminal(sessionId); // 菜单是 <div>,点击会把 textarea 焦点顶掉(落到 body),
        // 用户接着敲的字(含空格)会全被吞掉直到再点终端 —— 粘贴完立刻把焦点还回终端。
      } },
      { label: '全选', action: () => { try { term.selectAll(); } catch { /* xterm 某些版本无 selectAll */ } } },
    ]);
  });

  // ---- xterm 终端 ----
  // 直接用当前主题配色创建(否则新终端永远用写死的深色)
  const curTheme = THEMES[state.settings.theme] || THEMES.dark;
  const term = new XTermClass({
    fontFamily: state.settings.fontFamily || '"SF Mono", Menlo, Consolas, "Courier New", monospace',
    fontSize: state.settings.fontSize || 13,
    cursorBlink: true,
    cursorStyle: 'block',
    scrollback: 5000,
    theme: { ...curTheme.term },
  });
  const fit = new FitAddonClass();
  term.loadAddon(fit);
  const searchAddon = new SearchAddonClass();
  term.loadAddon(searchAddon);
  term.open(paneEl);
  fit.fit();

  // 键盘输入 → SSH(term.onData 会在每个按键/粘贴时触发)
  term.onData((data) => {
    // 始终跟踪输入行:①记录命令历史 ②生产环境危险命令确认
    let lineOnEnter = null;
    // 转义序列(方向键/Home/End 等)或 Tab(补全)→ 行内容可能被服务器改写
    // (历史回显 / 自动补全),本地输入镜像不再可信,标记 dirty,回车时从缓冲区还原真实命令
    if (String(data).includes('\x1b') || String(data).includes('\t')) {
      tab.inputDirty = true;
      tab.inputBuf = '';
    }
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        lineOnEnter = tab.inputBuf.trim();
        tab.inputBuf = '';
      } else if (ch === '\x7f' || ch === '\b') {
        tab.inputBuf = tab.inputBuf.slice(0, -1); // 退格
      } else if (ch === '\x03' || ch === '\x15') {
        tab.inputBuf = ''; // Ctrl+C / Ctrl+U 清空当前行
      } else if (ch >= ' ' && ch !== '\x1b') {
        // 开始输入第一个字符时,快照当前缓冲区行作为提示符(此刻行里只有提示符)。
        // 这样即使是第一条命令、还没"学习过提示符",Tab 补全/历史回显也能正确还原命令。
        if (tab.inputBuf === '' && !tab.inputDirty) {
          try {
            const l = term.buffer.active.getLine(term.buffer.active.cursorY);
            const t = l ? l.translateToString(true).trimEnd() : '';
            if (t) tab.promptText = t;
          } catch { /* ignore */ }
        }
        tab.inputBuf += ch;
      }
    }
    // 跟踪 cd 命令 → 更新 shell 当前目录(供 SFTP 面板打开时定位到终端所在目录;
    // 与"命令记录"开关无关,SFTP 定位总是需要)
    if (lineOnEnter != null) trackShellCwd(tab, lineOnEnter);
    // 命令记录:开关开启时才记。
    if (lineOnEnter != null && state.settings.cmdRecord !== false) {
      if (tab.inputDirty) {
        // 行被服务器改写(↑↓ 历史回显):从终端缓冲区还原真实命令(去掉提示符)
        tab.inputDirty = false;
        const real = recoverRecalledCommand(tab, term);
        if (real) recordCommand(session.host, real);
      } else if (lineOnEnter) {
        recordCommand(session.host, lineOnEnter);
        // 学习提示符:提示符 = 缓冲区当前行去掉"刚输入的命令"
        try {
          const buf = term.buffer.active;
          const line = buf.getLine(buf.cursorY);
          const txt = line ? line.translateToString(true).trim() : '';
          if (txt.endsWith(lineOnEnter)) {
            tab.promptText = txt.slice(0, txt.length - lineOnEnter.length).trimEnd();
          }
        } catch { /* ignore */ }
      }
    }
    // 生产环境保护:危险命令先弹确认(分级:critical 严重 / high 危险,原因细化)
    if (lineOnEnter != null && (state.broadcast ? hasProdSession() : isSessionProd(session))) {
      const an = analyzeCommand(lineOnEnter);
      if (an.level !== 'safe') {
        const label = dangerousLabel(an.level);
        const reasons = an.findings.map((f) => `  · ${f.name}`).join('\n');
        const ok = confirm(
          `${label}!确定要在生产环境执行吗?\n\n${lineOnEnter}\n\n命中: \n${reasons}\n\n` +
          (state.broadcast ? '(广播模式:会发到所有已连接会话)' : `目标: ${session.host}`)
        );
        if (!ok) return; // 拒绝则吞掉(命令不执行)
      }
    }
    dlog('SEND', `${sessionId} ${JSON.stringify(String(data).slice(0, 80))}${data.length > 80 ? '…' : ''}`);
    sendInput(sessionId, data); // 普通输入照发(广播模式也走这里)
  });
  // 窗口尺寸变化 → 同步给服务器(否则 vim 全屏会错位)
  term.onResize(({ cols, rows }) => window.api.sshResize(sessionId, cols, rows));

  // ---- 复制 / 粘贴(第 5 课) ----
  // xterm 自带鼠标拖选;这里用 attachCustomKeyEventHandler 精确控制快捷键:
  //   复制: Cmd/Ctrl + C(有选中内容时)或 Cmd/Ctrl + Shift + C
  //   粘贴: Cmd/Ctrl + Shift + V(原生 Cmd/Ctrl+V 由 xterm 自己处理)
  // 关键点:终端里 Ctrl+C 是"中断信号",所以只有"有选中文字"才拦截做复制,
  //         没选中就放行给服务器当 ^C。
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const mod = isMac ? e.metaKey : e.ctrlKey; // Mac 用 Cmd,其他用 Ctrl

    // 搜索:Cmd/Ctrl + F 打开终端内搜索
    if (mod && (e.key === 'f' || e.key === 'F')) {
      openTermSearch();
      return false;
    }

    // 复制(有选中内容 或 Shift+C 时拦截)
    if (mod && (e.key === 'c' || e.key === 'C') && (e.shiftKey || term.getSelection())) {
      const sel = term.getSelection();
      if (sel) window.api.copyText(sel);
      return false; // 吃下这个按键,不发给服务器
    }
    // 粘贴
    if (mod && e.shiftKey && (e.key === 'v' || e.key === 'V')) {
      const text = window.api.readClipboard();
      if (text) term.paste(text);
      return false;
    }
    return true;
  });

  const tab = {
    sessionId, session, title, el: tabEl, paneEl, term, fit,
    titleSpan,               // 标签上的标题元素(重命名标签时改它)
    customTitle: null,       // 用户改的标签名(null=用会话名)
    status: 'connecting',
    sftpOpen: false,         // 该标签自己的 SFTP 开关(各标签独立,切换标签时恢复各自状态)
    sftpPath: '.',           // 该标签 SFTP 浏览到的目录
    shellCwd: null,          // 该标签交互 shell 的当前目录(跟踪 cd 命令;null=未知,SFTP 用默认)
    reconnectAttempts: 0,   // 已自动重连次数
    reconnectTimer: null,   // 重连定时器
    userClosed: false,      // 是否用户主动关闭(主动关闭不重连)
    decoder: new TextDecoder(), // 流式 UTF-8 解码(用于关键字高亮)
    inputBuf: '',           // 当前输入行缓冲(生产环境危险命令检测用)
    inputDirty: false,      // 行是否被服务器改写(方向键历史等)→ 本地镜像不可信
    promptText: '',         // 学习到的 shell 提示符(用于从缓冲区还原被历史回显的命令)
    searchAddon,            // 终端内搜索插件
  };
  state.tabs.set(sessionId, tab);
  tab.__imeReset = setupImeGuard(term); // 输入法组合状态看护(见 setupImeGuard)
  saveRestoreList(); // 记录打开列表,用于启动恢复
  recordRecent(sessionId); // 记入"最近连接"

  renderLayout();
  activateTab(sessionId);
  scheduleRefit(tab, 200); // 连接后延迟重适配:等布局/字体稳定,确保终端填满(防止只占上半部分)

  // ---- 等 xterm 量出字符尺寸,再按真实终端尺寸发起连接 ----
  // term.open 时 paneEl 还没挂进 DOM,渲染器量不到字符宽高,fit 会 bailed 保持默认 80x24;
  // 此时把 80x24 发给主进程,服务器 PTY 就按 80x24 创建 → 高窗口里 vim 只占上半屏。
  // 挂上 DOM 后要等 xterm 渲染器跑完一帧、量出 actualCellWidth 才肯 resize,于是逐帧重试 fit,
  // 直到拿到真实 cols/rows(探针实证:80x24 → 94x44)。
  await new Promise((resolve) => {
    let tries = 0;
    const settle = () => { try { tab.fit.fit(); } catch { /* ignore */ } resolve(); };
    const to = setTimeout(settle, 200); // 兜底:窗口后台化 rAF 不触发时也不卡住连接
    const attempt = () => {
      try { tab.fit.fit(); } catch { /* ignore */ }
      if (tab.term.cols > 80 || tab.term.rows > 24 || ++tries >= 6) { clearTimeout(to); return settle(); }
      requestAnimationFrame(attempt);
    };
    requestAnimationFrame(attempt);
  });

  // ---- 发起 SSH 直连 ----
  connectInto(tab, session);
}

// 延迟重新适配终端尺寸(连接/切换标签/字体加载后调用,避免终端只占容器上半部分)
function scheduleRefit(tab, delay) {
  setTimeout(() => {
    try {
      tab.fit.fit();
      window.api.sshResize(tab.sessionId, tab.term.cols, tab.term.rows);
      tab.term.refresh(0, tab.term.rows - 1); // 强制全量重绘:清掉布局切换后 canvas 残留的重影
    } catch { /* ignore */ }
  }, delay || 150);
}

// 把会话连进指定标签(首次连接 和 断线重连 共用)
function connectInto(tab, session, isReconnect) {
  // 守卫:发起连接前标签可能已被用户关闭(fit 等待期间点了 ✕)。
  // 此时 tab 已 dispose 且不在 state.tabs 里,继续连会产生无人监听的"幽灵连接",
  // 主进程连接池里永久挂一个 sessionId,数据没人收、日志持续写。
  // 正确做法:让主进程把还没建立的连接关掉,直接放弃本次连接。
  if (!state.tabs.has(tab.sessionId)) {
    window.api.sshClose(tab.sessionId);
    return;
  }
  setTabStatus(tab.sessionId, 'connecting');
  if (isReconnect) {
    try { tab.term.reset(); } catch { /* ignore */ } // 重连前清屏:避免新旧输出叠在一起(字符重影/重复)
    tab.term.write('\r\n\x1b[36m[正在尝试重连...]\x1b[0m\r\n');
  }
  tab.encoding = session.encoding || 'utf8'; // 终端编码(GBK 时主进程会转码)
  tab.decoder = new TextDecoder(); // 重置流式解码器:断线瞬间残留的多字节序列状态不能带到重连后首块(否则首字符偶发乱码)
  const fail = (res) => {
    dlog('CONN', `${tab.sessionId} 连接失败: ${res.error}`);
    // 连接失败:写入真实原因;若是重连失败,继续安排下一次
    setTabStatus(tab.sessionId, 'closed');
    tab.term.write(`\r\n\x1b[31m[连接失败] ${res.error}\x1b[0m\r\n`);
    setStatus('连接失败', 'var(--red)');
    // 堡垒机直连会话失败:记入诊断包(同步失败走这里,不经过 onSshStatus)
    if (session && session.bastionKey) bastionLog({ ev: 'ssh-error', sessionId: tab.sessionId, bastionKey: session.bastionKey, host: session.host, port: session.port, account: session.username, error: res.error });
    if (isReconnect) scheduleReconnect(tab);
  };
  const isTelnet = (session.protocol || 'ssh') === 'telnet';
  dlog('CONN', `${session.name} 发起连接 ${session.username || ''}@${session.host}:${session.port || (isTelnet ? 23 : 22)} (${isTelnet ? 'telnet' : 'ssh'}${session.jump && session.jump.host ? ' · 经跳板 ' + session.jump.host : ''})`);
  const p = isTelnet
    ? window.api.telnetConnect(tab.sessionId, {
        host: session.host,
        port: session.port || 23,
        username: session.username || '', // telnet 自动登录(可选):检测 login:/password: 提示自动发送
        password: session.password || '',
        cols: tab.term.cols,
        rows: tab.term.rows,
        timeoutMs: 15000,
        sessionName: session.name || '',
        sessionLog: state.settings.sessionLog !== false,
        encoding: tab.encoding,
      })
    : window.api.sshConnect(tab.sessionId, {
        host: session.host,
        port: session.port || 22,
        username: session.username,
        password: session.password,
        privateKey: session.private_key || '', // 密钥认证:私钥文件路径
        passphrase: session.passphrase || '',
        cols: tab.term.cols,
        rows: tab.term.rows,
        verifyHostKey: state.settings.verifyHostKey !== false, // 指纹校验开关
        autoTrustHostKey: state.settings.autoTrustHostKey === true, // 自动信任新主机(不弹窗,仍记录指纹)
        sessionName: session.name || '', // 会话日志文件名用它
        sessionLog: state.settings.sessionLog !== false, // 会话日志开关
        jump: session.jump && session.jump.host ? session.jump : null, // 跳板机(SSH 代理),直连则为 null
      });
  p.then((res) => { if (res && !res.ok) fail(res); })
   // 主进程 handler 抛异常(如 DB 锁、参数异常)时 invoke 会 reject:
   // 不 catch 的话标签永远停在 connecting、终端无任何提示、也不触发重连。
   .catch((e) => fail({ error: (e && e.message) || '连接异常' }));
}

// ---- 断线自动重连(参考 Netcatty 的长驻工作流) ----
// 意外断开后按 2/4/8/16/30 秒退避重连,最多 MAX_RECONNECT 次
const MAX_RECONNECT = 5;
function scheduleReconnect(t) {
  if (state.settings.autoReconnect === false) return; // 设置里关闭了自动重连
  if (t.userClosed || !state.tabs.has(t.sessionId)) return;
  clearTimeout(t.reconnectClearTimer); // 连接没能稳定(瞬连瞬断),挂起的"清零重连计数"作废
  if (t.reconnectTimer) return; // 已有定时器,不重复安排
  if (t.reconnectAttempts >= MAX_RECONNECT) {
    t.term.write(`\r\n\x1b[31m[自动重连 ${MAX_RECONNECT} 次仍失败,已停止;可关闭标签后重新连接]\x1b[0m\r\n`);
    setTabStatus(t.sessionId, 'closed');
    return;
  }
  const delay = Math.min(30, 2 * Math.pow(2, t.reconnectAttempts)); // 2,4,8,16,30
  t.reconnectAttempts++;
  t.term.write(`\r\n\x1b[33m[连接断开, ${delay} 秒后自动重连(第 ${t.reconnectAttempts} 次)]\x1b[0m\r\n`);
  setStatus(`自动重连中(${t.reconnectAttempts}/${MAX_RECONNECT})...`, 'var(--orange)');
  t.reconnectTimer = setTimeout(() => {
    t.reconnectTimer = null;
    if (t.userClosed || !state.tabs.has(t.sessionId)) return;
    connectInto(t, t.session, true);
  }, delay * 1000);
}

function activateTab(sessionId) {
  state.activeSessionId = sessionId;
  updateRecordBtn(); // 录制按钮跟随新标签的录制状态
  updateConnectBtn(); // 连接/断开按钮跟随新激活标签的状态

  // 标签高亮 + 聚焦
  for (const [id, t] of state.tabs) {
    t.el.classList.toggle('active', id === sessionId);
    if (id === sessionId) {
      try { t.fit.fit(); } catch { /* ignore */ }
      scheduleRefit(t, 150); // 切换后延迟重适配,确保填满
      t.term.focus();
    }
  }

  if (state.splitMode) {
    highlightActiveSlot(); // 分屏:所有面板都在,只更新高亮
  } else {
    renderLayout();        // 单面板:切换显示哪个连接
  }

  // SFTP 按标签各自的状态:每个标签记住自己是否开了 SFTP、浏览到哪个目录。
  // 选中"未打开 SFTP 的标签页"→ 面板收起、按钮不亮;切回开过的标签 → 恢复它的文件列表。
  applySftpForTab(state.tabs.get(sessionId));
}

// 应用某标签的 SFTP 状态(切换标签/关闭标签后调用):开了就展开面板并加载它的目录,没开就收起
function applySftpForTab(t) {
  if (!t) return;
  state.sftp.sessionId = t.sessionId;
  if (t.sftpOpen) {
    state.sftp.visible = true;
    state.sftp.path = t.sftpPath || '.';
    state.sftp.selected = null;
    els.sftpPanel.classList.remove('hidden');
    els.dividerH.classList.remove('hidden');
    setSftpConnLabel(t.sessionId);
    loadSftpList();
  } else {
    state.sftp.visible = false;
    els.sftpPanel.classList.add('hidden');
    els.dividerH.classList.add('hidden');
    setSftpConnLabel(null);
  }
  syncPanelButtons();
}

// 断开当前终端连接,但保留标签(显示"已断开",可右键重新连接);不像关闭标签那样移除
function disconnectTab(sessionId) {
  const t = state.tabs.get(sessionId);
  if (!t || !t.session) return;
  if (t.status !== 'connected' && t.status !== 'connecting') return; // 已断开则忽略
  t.manualDisconnect = true; // 防止断开后自动重连
  if (t.reconnectTimer) { clearTimeout(t.reconnectTimer); t.reconnectTimer = null; }
  state.recording.delete(sessionId); // 若在录制,主进程 ssh:close 会自动收尾保存
  updateRecordBtn();
  window.api.sshClose(sessionId); // 主进程结束连接 → 会广播 closed 状态,标签保留
}

// 重新连接已断开的标签:关掉旧标签,用同一会话开新标签
function reconnectTab(sessionId) {
  const t = state.tabs.get(sessionId);
  if (!t || !t.session) return;
  const s = t.session;
  closeTab(sessionId);
  connectToServer(s);
}

function closeTab(sessionId) {
  const t = state.tabs.get(sessionId);
  if (!t) return;
  t.userClosed = true; // 用户主动关闭 → 不触发自动重连
  if (t.reconnectTimer) { clearTimeout(t.reconnectTimer); t.reconnectTimer = null; }
  state.recording.delete(sessionId); // 若在录制,主进程 ssh:close 会自动收尾保存
  updateRecordBtn();
  window.api.sshClose(sessionId);
  kbdCancelSession(sessionId); // 关标签时取消该会话挂起的 keyboard-interactive 认证挑战
  // 批量/AI 面板里残留该标签的勾选与分屏尺寸,一并清掉,避免计数虚高/集合增长
  state.batchHosts.delete(sessionId);
  state.aiSelectedHosts.delete(sessionId);
  delete state.splitSizes[sessionId];
  t.el.remove();
  try { t.term.dispose(); } catch { /* ignore */ }
  t.paneEl.remove();
  state.tabs.delete(sessionId);
  saveRestoreList(); // 更新打开列表
  updateConnectBtn(); // 关闭标签 → 刷新"连接/中断"二合一按钮

  if (state.tabs.size === 0) {
    state.activeSessionId = null;
    state.splitMode = null;
    state.splitZoom = null;
    setStatus('就绪');
    // 没有标签了:SFTP 面板一并收起
    state.sftp.visible = false;
    state.sftp.sessionId = null;
    els.sftpPanel.classList.add('hidden');
    els.dividerH.classList.add('hidden');
    setSftpConnLabel(null);
    syncPanelButtons();
  } else if (state.activeSessionId === sessionId) {
    const keys = [...state.tabs.keys()];
    activateTab(keys[keys.length - 1]); // 会自动应用新标签自己的 SFTP 状态
  }
  renderLayout();
}

function setTabStatus(sessionId, status) {
  const t = state.tabs.get(sessionId);
  if (!t) return;
  t.status = status;
  updateConnectBtn(); // 连接状态变化 → 刷新工具栏"连接/中断"二合一按钮
  const dot = t.el.querySelector('.tab-status-dot');
  if (!dot) return; // 标签已精简为只显示名称,没有状态点了
  dot.className = `tab-status-dot ${status}`;
}

// =====================================================================
// 分屏(参考 Xshell)
//   splitMode=null → 单视图(只显示当前活动连接,点标签切换)
//   splitMode='v'  → 所有打开连接均分为等宽列
//   splitMode='h'  → 所有打开连接均分为等高行
// =====================================================================

// 渲染终端容器:
//   splitMode=null → 单视图(只显示当前活动连接,点标签切换)
//   splitMode='v'  → 所有连接均分为等宽列
//   splitMode='h'  → 所有连接均分为等高行
// 无打开的连接时隐藏整个终端区域,会话列表占满;有连接时恢复(#79)
function updateTerminalVisibility() {
  const noTerm = state.tabs.size === 0;
  document.querySelector('.main-body').classList.toggle('no-term', noTerm);
  els.welcomeHintSession.classList.toggle('hidden', !noTerm);
  applyPanelCollapsed(); // 无终端状态变化 → 重算左面板显隐(防"折叠+无终端"时右侧面板独占跑到最左)
}

function renderLayout() {
  updateTerminalVisibility();
  const container = els.terminalContainer;
  if (state.tabs.size === 0) {
    container.innerHTML = '';
    updateSplitButtons();
    return;
  }
  container.innerHTML = '';

  const list = [...state.tabs.values()]; // 所有打开连接
  // 放大中的面板被关掉时,自动还原网格(否则会渲染出空面板)
  if (state.splitZoom && !list.some((t) => t.sessionId === state.splitZoom)) state.splitZoom = null;
  if (state.splitMode === 'v' || state.splitMode === 'h') {
    const wrap = document.createElement('div');
    wrap.className = `split-${state.splitMode}`;
    // 放大态:只显示被放大的那一个面板(其余连接还开着,只是不占屏幕)
    const visible = state.splitZoom ? list.filter((t) => t.sessionId === state.splitZoom) : list;
    for (const t of visible) wrap.appendChild(makeSlot(t));
    // 正常网格:面板之间插可拖动分隔条(放大时单面板,不插)
    if (!state.splitZoom) addSplitDividers(wrap, state.splitMode);
    container.appendChild(wrap);
  } else {
    // 默认单视图:只显示当前活动连接
    const active = state.tabs.get(state.activeSessionId) || list[0];
    if (active) container.appendChild(active.paneEl);
  }

  renderTabs();
  refitAll();
  updateSplitButtons();
}

// 在分屏面板之间插入"可拖动分隔条",让用户把某个面板拖大拖小(不再全是均分)
function addSplitDividers(wrap, axis) {
  // axis:'v' = 左右列,分隔条竖直,拖它改"左边面板"的宽度
  //      'h' = 上下行,分隔条水平,拖它改"上面面板"的高度
  const slots = [...wrap.querySelectorAll('.pane-slot')];
  wrap.style.gap = '0'; // 有分隔条时不再用 gap 当分割线,由分隔条承担
  for (let i = 0; i < slots.length - 1; i++) {
    const div = document.createElement('div');
    div.className = `split-divider split-divider-${axis}`;
    div.title = '拖动调整面板大小(双击恢复均分)';
    slots[i].after(div); // 分隔条插在左右/上下两个面板之间
    makeSplitDivider(div, axis, slots[i], wrap);
    div.addEventListener('dblclick', () => {
      // 双击:恢复该面板为均分(清掉记住的大小)
      delete state.splitSizes[slots[i].dataset.sessionId];
      slots[i].style.flex = '';
      refitAll();
    });
  }
}

// 分隔条拖动:改"分隔条之前那个面板"的尺寸,其余面板均分剩余空间
function makeSplitDivider(divider, axis, slot, wrap) {
  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startPos = axis === 'x' || axis === 'v' ? e.clientX : e.clientY;
    const startSize = axis === 'x' || axis === 'v' ? slot.offsetWidth : slot.offsetHeight;
    const onMove = (ev) => {
      const pos = axis === 'x' || axis === 'v' ? ev.clientX : ev.clientY;
      const delta = pos - startPos; // 分隔条在面板"后面":往右/往下拉 = 面板变大
      const min = 80;
      const max = (axis === 'x' || axis === 'v' ? wrap.offsetWidth : wrap.offsetHeight) - 80;
      const size = Math.min(max, Math.max(min, startSize + delta));
      slot.style.flex = `0 0 ${size}px`; // 固定这个面板大小,其余均分
      // 记住大小:重新渲染(开面板/关标签)后不丢
      state.splitSizes[slot.dataset.sessionId] = state.splitSizes[slot.dataset.sessionId] || {};
      state.splitSizes[slot.dataset.sessionId][axis] = size;
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      refitAll(); // 拖完重新适配终端
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

// 工具栏自适应:先压缩按钮间距、压到底(4px)还放不下才换行。
// 间距默认 14px;窗口变窄时按"内容单行自然宽度"精确计算恰好放一行的 gap
// (上限 14px / 下限 4px),避免 clamp(1vw) 那种比例式 gap 在还能压缩时就提前换行。
function packToolbar() {
  const tb = document.querySelector('.toolbar');
  if (!tb) return;
  const items = tb.children.length;
  const MAXG = 4, MING = 2; // 间距上限 4px/下限 2px:工具栏按钮尽量靠近
  const prevWrap = tb.style.flexWrap, prevGap = tb.style.gap;
  const prevFlex = [];
  try {
    // 逐项置 flex 0 0 auto 量固有宽度(spacer 为 0,sep 为 1px,按钮为内容宽)
    tb.style.flexWrap = 'nowrap'; tb.style.gap = '0px';
    for (const ch of tb.children) { prevFlex.push(ch.style.flex); ch.style.flex = '0 0 auto'; }
    let natural = 0;
    for (const ch of tb.children) natural += ch.offsetWidth;
    // 内容盒宽度 = clientWidth 减水平 padding(否则算出的 gap 偏大、实际仍换行)
    const cs = getComputedStyle(tb);
    const avail = tb.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const fitGap = (avail - natural) / items; // 恰好放下整行时的间距
    tb.style.setProperty('--toolbar-gap', Math.max(MING, Math.min(MAXG, fitGap)) + 'px');
  } finally {
    for (let i = 0; i < tb.children.length; i++) tb.children[i].style.flex = prevFlex[i];
    tb.style.flexWrap = prevWrap; tb.style.gap = prevGap;
  }
}

// 重新适配所有终端的尺寸(面板开关/分隔条拖动后调用,避免输出超出边界)
function refitAll() {
  for (const t of state.tabs.values()) {
    try {
      t.fit.fit();
      window.api.sshResize(t.sessionId, t.term.cols, t.term.rows);
      t.term.refresh(0, t.term.rows - 1); // 强制全量重绘:清掉分屏/切换标签后 canvas 残留的重影
    } catch { /* ignore */ }
  }
}

// 构造一个分屏面板:顶部内嵌该连接的标签条(含放大按钮),下方是终端
function makeSlot(t) {
  const slot = document.createElement('div');
  slot.className = 'pane-slot';
  slot.dataset.sessionId = t.sessionId;
  const active = t.sessionId === state.activeSessionId;
  const zoomed = state.splitZoom === t.sessionId;
  slot.classList.toggle('active', active);

  // 用户拖过分隔条的话,恢复记住的面板大小(否则均分)。
  // 放大态下只有单个面板,必须撑满,所以不套用记住的大小。
  const saved = !state.splitZoom && state.splitSizes[t.sessionId] && state.splitSizes[t.sessionId][state.splitMode];
  if (saved) slot.style.flex = `0 0 ${saved}px`;

  // 面板自己的标签条(标签放在分屏后的终端里)
  const tabs = document.createElement('div');
  tabs.className = 'pane-tabs';
  tabs.appendChild(t.el);
  t.el.classList.toggle('active', active);

  // 放大/还原按钮(tmux 的 zoom-pane):放大当前面板占满终端区,再点还原
  const zoomBtn = document.createElement('button');
  zoomBtn.className = 'btn-mini pane-zoom-btn';
  zoomBtn.textContent = zoomed ? '⤡ 还原' : '⤢ 放大';
  zoomBtn.title = zoomed ? '还原到分屏网格' : '放大此面板(快捷键 Cmd+Enter)';
  zoomBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.splitZoom) {
      state.splitZoom = null; // 已放大 → 还原
    } else {
      activateTab(t.sessionId);
      state.splitZoom = t.sessionId; // 未放大 → 放大当前面板
    }
    renderLayout();
    setStatus(state.splitZoom ? `已放大:${t.title} (Cmd+Enter 还原)` : '已还原分屏', 'var(--green)');
  });
  tabs.appendChild(zoomBtn);

  slot.appendChild(tabs);
  slot.appendChild(t.paneEl);
  return slot;
}

// 分屏模式下切换标签时,高亮活动面板 + 面板内嵌标签
function highlightActiveSlot() {
  for (const slot of els.terminalContainer.querySelectorAll('.pane-slot')) {
    const active = slot.dataset.sessionId === state.activeSessionId;
    slot.classList.toggle('active', active);
    const tab = slot.querySelector('.pane-tabs .tab');
    if (tab) tab.classList.toggle('active', active);
  }
}

// 分屏按钮 = 布局开关:
//   点"垂直分屏" → 所有连接均分为等宽列
//   点"横向分屏" → 所有连接均分为等高行
//   再点当前模式 → 回到自动网格
function splitActivePane(dir) {
  if (state.tabs.size === 0) { alert('请先打开至少一个连接再分屏'); return; }
  state.splitMode = state.splitMode === dir ? null : dir;
  renderLayout();
  setStatus(
    state.splitMode === null
      ? '自动网格布局'
      : `${dir === 'v' ? '垂直' : '横向'}均分:${state.tabs.size} 个连接`,
    'var(--green)'
  );
}

// ---------- 分屏增强:面板切换快捷键 + 放大/还原 ----------
// 聚焦到第 n 个面板/标签(Cmd+数字)
function focusPaneByIndex(n) {
  const list = [...state.tabs.values()];
  if (n >= 1 && n <= list.length) activateTab(list[n - 1].sessionId);
}

// 前后切换面板焦点(Cmd+Alt+方向键);分屏时切面板,单视图时等同切标签
function focusPaneRelative(dir) {
  const list = [...state.tabs.values()];
  if (!list.length) return;
  const cur = list.findIndex((t) => t.sessionId === state.activeSessionId);
  const next = dir < 0 ? (cur - 1 + list.length) % list.length : (cur + 1) % list.length;
  activateTab(list[next].sessionId);
}

// 放大当前面板占满终端区 / 还原(tmux 的 zoom-pane)
function toggleSplitZoom() {
  if (!state.splitMode) return;
  const t = state.tabs.get(state.activeSessionId);
  if (!t) return;
  state.splitZoom = state.splitZoom ? null : t.sessionId;
  renderLayout();
  setStatus(state.splitZoom ? `已放大:${t.title} (Cmd+Enter 还原)` : '已还原分屏', 'var(--green)');
}

// 分屏快捷键:Cmd+Enter=放大/还原,Cmd+Alt+方向键=前后切面板,Cmd+数字=直达第 N 个
// 终端聚焦时 xterm 用隐藏 textarea 接收输入,它的 class 是 xterm-helper-textarea,
// 所以只有"真正的输入框"里才跳过快捷键,终端里照样生效。
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  const t = e.target;
  if (t && t.tagName === 'TEXTAREA' && !t.classList.contains('xterm-helper-textarea')) return;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT')) return;

  if (e.key === 'Enter' && !e.altKey && !e.shiftKey) {
    if (state.splitMode) { e.preventDefault(); toggleSplitZoom(); } // Cmd+Enter:放大/还原
    return;
  }
  if (e.altKey && ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(e.key)) {
    e.preventDefault();
    focusPaneRelative((e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 1);
    return;
  }
  if (!e.altKey && /^[1-9]$/.test(e.key)) {
    e.preventDefault();
    focusPaneByIndex(Number(e.key)); // Cmd+数字:直达第 N 个
  }
});

// 同步"视图"按钮和下拉菜单:只点亮"实际分屏方向"对应的项
function updateSplitButtons() {
  const onV = state.splitMode === 'v';
  const onH = state.splitMode === 'h';
  els.btnView.classList.toggle('active', !!state.splitMode);
  els.btnView.textContent = onV ? '垂直分屏' : onH ? '横向分屏' : '视图';
  els.btnView.title = onV ? '垂直分屏中(再点可取消)' : onH ? '横向分屏中(再点可取消)' : '视图:垂直/横向分屏';
  const vItem = els.viewMenu.querySelector('[data-split="v"]');
  const hItem = els.viewMenu.querySelector('[data-split="h"]');
  if (vItem) vItem.classList.toggle('active', onV);
  if (hItem) hItem.classList.toggle('active', onH);
}

// 视图下拉菜单:点按钮弹出(定位在按钮下方),选完或点外面收起
function toggleViewMenu() {
  if (!els.viewMenu.classList.contains('hidden')) { els.viewMenu.classList.add('hidden'); return; }
  const rect = els.btnView.getBoundingClientRect();
  els.viewMenu.style.left = `${rect.left}px`;
  els.viewMenu.style.top = `${rect.bottom + 4}px`;
  els.viewMenu.classList.remove('hidden');
}
function closeViewMenu() { els.viewMenu.classList.add('hidden'); }

// 下拉菜单点击:v=垂直分屏,h=横向分屏(再点同项=取消分屏)
function onViewMenuClick(e) {
  const item = e.target.closest('.ctx-item');
  if (!item) return;
  closeViewMenu();
  const dir = item.dataset.split;
  if (dir === 'v' || dir === 'h') splitActivePane(dir);
}

// ---------- 标签栏 ----------
// 单视图:全局标签栏平铺显示所有连接标签,点标签切换显示哪个
// 分屏:全局标签栏隐藏,每个面板顶部内嵌自己的标签(在终端里)
function renderTabs() {
  els.tabBar.innerHTML = '';
  if (state.splitMode) {
    els.tabBar.classList.add('hidden');
    updateTabScroll();
    return;
  }
  els.tabBar.classList.remove('hidden');
  for (const t of state.tabs.values()) {
    els.tabBar.appendChild(t.el);
    t.el.classList.toggle('active', t.sessionId === state.activeSessionId);
  }
  updateTabScroll();     // 标签增删/切换后刷新滚动按钮
  scrollActiveTabIntoView(); // 把当前标签滚进可视区
}

// 刷新 ◀▶ 滚动按钮:标签溢出时才显示;到头/到尾时禁用对应按钮
function updateTabScroll() {
  const bar = els.tabBar;
  const left = els.tabScrollLeft;
  const right = els.tabScrollRight;
  // 分屏模式标签栏隐藏,按钮也一起藏(否则会在空栏旁边出现)
  if (state.splitMode || bar.classList.contains('hidden')) {
    left.classList.add('hidden');
    right.classList.add('hidden');
    return;
  }
  const hasOverflow = bar.scrollWidth > bar.clientWidth + 2; // +2 容错
  left.classList.toggle('hidden', !hasOverflow);
  right.classList.toggle('hidden', !hasOverflow);
  if (hasOverflow) {
    // 没到最左时左边可用;没到最右时右边可用
    left.disabled = bar.scrollLeft <= 2;
    right.disabled = bar.scrollLeft + bar.clientWidth >= bar.scrollWidth - 2;
  }
}

// 点 ◀ ▶:把标签栏左右滚动一格(约一个标签宽度)
function scrollTabs(dir) {
  const bar = els.tabBar;
  const step = Math.max(120, Math.round(bar.clientWidth * 0.4)); // 一次滚 40% 或至少 120px
  bar.scrollBy({ left: dir * step, behavior: 'smooth' });
  // 滚动结束后再刷新一次按钮状态(平滑滚动完再判定)
  setTimeout(updateTabScroll, 150);
}

// 把当前激活标签滚动到可见区域(切换标签时用)
function scrollActiveTabIntoView() {
  if (state.splitMode) return;
  const bar = els.tabBar;
  const t = state.tabs.get(state.activeSessionId);
  if (!t) return;
  const el = t.el;
  const left = el.offsetLeft - 6;
  const right = left + el.offsetWidth + 6;
  if (left < bar.scrollLeft) bar.scrollLeft = left;
  else if (right > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = right - bar.clientWidth;
  updateTabScroll();
}

// =====================================================================
// SFTP 文件面板
// =====================================================================
// ---- 工具函数 ----

// 面板当前对应的会话 id(面板跟着活动标签走)
function sftpSession() {
  if (state.sftp.sessionId && state.tabs.has(state.sftp.sessionId)) return state.sftp.sessionId;
  return state.activeSessionId;
}

// 把路径规范化:合并 . / .. ,去掉结尾 / (根目录保留 /)
function normPath(p) {
  if (!p) return '/';
  const isAbs = p.startsWith('/');
  const segs = [];
  for (const s of String(p).split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') { if (segs.length) segs.pop(); }
    else segs.push(s);
  }
  const out = (isAbs ? '/' : '') + segs.join('/');
  return out || (isAbs ? '/' : '.');
}

// 跟踪交互 shell 的 cd 命令,更新 tab.shellCwd(终端当前目录)。
// SFTP 通道没有"当前目录"(每次操作都走绝对路径),它从登录目录开始;
// 而交互 shell 的 cd 只影响 shell 自己 → 打开 SFTP 面板时若不知道终端在哪,
// 路径就停在默认目录。这里监听 cd 命令维护每个标签的"当前目录",SFTP 打开时用它定位。
function trackShellCwd(tab, cmdLine) {
  try {
    if (!tab) return;
    const c = String(cmdLine || '').trim();
    // 只认纯 cd(前面无管道/变量赋值/分号等复杂形式,那些无法可靠解析)
    if (!/^cd(\s|$)/.test(c) || /[|;&<>]/.test(c)) return;
    const arg = c.slice(2).trim();
    if (!arg || arg === '~' || arg === '~/' ) {
      tab.shellCwd = null; // 回 home:具体路径未知,SFTP 用默认(登录目录)
      return;
    }
    if (arg.startsWith('/')) {
      tab.shellCwd = normPath(arg);
      return;
    }
    // 相对路径:基于当前已知目录拼接(未知时无法解析,保持 null)
    if (tab.shellCwd) tab.shellCwd = normPath(tab.shellCwd + '/' + arg);
  } catch { /* ignore */ }
}

// 把名字拼进当前目录,得到完整远程路径
function sftpJoin(name) {
  return state.sftp.path === '/' ? `/${name}` : `${state.sftp.path}/${name}`;
}

// 多选集合 → 当前目录里真正选中的条目列表(按 remotePath 匹配)
function sftpSelectedEntries() {
  return state.sftp.entries.filter((e) => state.sftp.selectedSet.has(sftpJoin(e.name)));
}

// 刷新选中高亮 + 底部"已选 N 项"提示(不重绘整列,快)
function updateSftpSelection() {
  for (const row of els.sftpList.querySelectorAll('.sftp-row')) {
    row.classList.toggle('selected', state.sftp.selectedSet.has(row.dataset.path));
  }
  const n = state.sftp.selectedSet.size;
  els.sftpFooter.classList.toggle('dim', n === 0);
  els.sftpFooter.textContent = n > 0
    ? `已选 ${n} 项(再点可取消) · 点「下载/删除」批量操作 · 点「全选」取消全选`
    : `双击进入目录 · 单击选中(可多选,再点取消) · 点「全选」一次选完后下载/删除`;
}

// 「全选」按钮:全部选中 ↔ 全部取消(开关)
function sftpToggleSelectAll() {
  if (state.sftp.entries.length === 0) return;
  const all = state.sftp.entries.map((e) => sftpJoin(e.name));
  const allSelected = all.every((p) => state.sftp.selectedSet.has(p));
  if (allSelected) state.sftp.selectedSet.clear();
  else all.forEach((p) => state.sftp.selectedSet.add(p));
  state.sftp.selected = null;
  renderSftpList(); // 重绘会顺带刷新高亮和底部提示
}

// 计算上一级路径:/a/b/c → /a ; /a → /
function sftpParent(p) {
  const clean = p.replace(/\/+$/, '');
  const idx = clean.lastIndexOf('/');
  if (idx <= 0) return '/';
  return clean.slice(0, idx);
}

// 字节数 → 人类可读(1024 → 1.0 KB)
function formatSize(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// 毫秒时间戳 → "YYYY-MM-DD HH:mm"
function formatTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 终端右键菜单粘贴后把焦点还回终端:ctx 菜单是 <div>,点击它会把 textarea 的焦点顶掉
// (落到 body),用户接着敲的字会全被吞掉直到再次点击终端 —— 表现就是"粘贴后打不出字/空格"。
function refocusTerminal(sessionId) {
  const ae = document.activeElement;
  if (ae && ae.tagName === 'BUTTON') { try { ae.blur(); } catch { /* ignore */ } }
  const t = state.tabs.get(sessionId);
  if (t) { try { t.term.focus(); } catch { /* ignore */ } }
}

// SFTP 工具栏按钮操作完,把焦点还给终端:原生 <button> 点击后一直占着焦点,
// 用户接着敲空格会被按钮当"激活键"吞掉(打不出空格 / 误触发按钮)。先 blur 按钮再聚焦终端。
function sftpRefocusTerminal() {
  const el = document.activeElement;
  if (el && el.tagName === 'BUTTON') el.blur();
  const t = state.tabs.get(state.activeSessionId);
  if (t) { try { t.term.focus(); } catch { /* ignore */ } }
}

// ---- 加载 & 渲染 ----
async function loadSftpList() {
  const sessionId = sftpSession();
  if (!sessionId) return;
  const reqPath = state.sftp.path; // 请求时的目录;响应回来若会话/路径已变 → 过期结果丢弃(防快速切换目录串台)
  const res = await window.api.sftpList(sessionId, reqPath);
  if (state.sftp.sessionId !== sessionId || state.sftp.path !== reqPath) return;
  if (!res.ok) {
    els.sftpList.innerHTML = `<div class="sftp-empty">读取失败: ${res.error}</div>`;
    return;
  }
  // 用 realpath 解析出的绝对路径替换路径栏 —— 仅当请求的是相对路径('.')时。
  // 请求绝对路径(如家目录探测结果 /root)时保留请求路径:某些堡垒机网关(SFTP 子系统
  // chroot)会把任意路径的 realpath 返回 '/'或默认目录,覆盖掉会显示错、上传也走错目录。
  state.sftp.path = (reqPath === '.' || reqPath === '') ? (res.cwd || state.sftp.path) : (reqPath || state.sftp.path);
  // 第一次拿到登录目录(绝对路径)→ 作为 shell 当前目录的初始值(cd 跟踪的起点)
  const t0 = state.tabs.get(state.sftp.sessionId);
  if (t0 && res.cwd && !t0.shellCwd) t0.shellCwd = res.cwd;
  state.sftp.entries = res.entries;
  state.sftp.selected = null;
  state.sftp.selectedSet.clear(); // 换了目录,之前的选中作废
  // 目录变化记回标签自己的状态(切换标签回来时恢复浏览位置)
  const t = state.tabs.get(state.sftp.sessionId);
  if (t) t.sftpPath = state.sftp.path;
  renderSftpList();
}

// 渲染路径栏为可点击面包屑:每段一个按钮,点击直接跳到该目录;
// 完整路径始终可见(横向滚动,不省略),悬停 title 显示完整路径。
function renderSftpPath(path) {
  const el = els.sftpPath;
  el.innerHTML = '';
  const segs = path.split('/').filter(Boolean); // 拆段;根目录 = 空
  const parts = segs.map((seg, i) => ({ name: seg, path: '/' + segs.slice(0, i + 1).join('/') }));
  if (parts.length === 0) {
    // 根目录:单个"／"段
    const root = document.createElement('button');
    root.className = 'sftp-path-seg root active';
    root.textContent = '/';
    root.title = '跳转到根目录';
    root.addEventListener('click', () => { if (state.sftp.path !== '/') { state.sftp.path = '/'; loadSftpList(); } });
    el.appendChild(root);
  } else {
    // 面包屑:根段显示 "/" 且不带前导分隔符,之后每段前加一个 "/" 分隔符。
    // 这样 /root 视觉上 = [根 /][root](分隔符 "/" 是段之间的路径拼接,
    // 不再额外渲染成 //root —— 根段自身就是路径的开头)。
    let first = true;
    for (const p of parts) {
      if (!first) {
        const sep = document.createElement('span');
        sep.className = 'sftp-path-sep';
        sep.textContent = '/';
        el.appendChild(sep);
      }
      const btn = document.createElement('button');
      btn.className = 'sftp-path-seg';
      btn.textContent = (first ? '/' : '') + p.name; // 首段前带根 "/",后续段由分隔符拼接
      btn.title = `跳转到 ${p.path}`;
      const target = p.path;
      btn.addEventListener('click', () => { if (state.sftp.path !== target) { state.sftp.path = target; loadSftpList(); } });
      el.appendChild(btn);
      first = false;
    }
    // 当前完整路径高亮最后一段
    const last = el.querySelector('.sftp-path-seg:last-of-type');
    if (last) last.classList.add('active');
  }
  el.title = `当前目录: ${path}\n(点路径段可直接跳转)`;
  el.scrollLeft = el.scrollWidth; // 滚动到末尾,总是看到当前所在目录
}

function renderSftpList() {
  renderSftpPath(state.sftp.path);
  els.sftpList.innerHTML = '';
  if (state.sftp.entries.length === 0) {
    els.sftpList.innerHTML = '<div class="sftp-empty">(空目录)</div>';
    return;
  }
  // 目录排在前面,各自按名称排序
  const sorted = [...state.sftp.entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const e of sorted) {
    const row = document.createElement('div');
    row.className = 'sftp-row';
    row.title = e.name;
    const remotePath = sftpJoin(e.name);
    row.dataset.path = remotePath; // 记住路径,多选高亮/查找都靠它
    if (state.sftp.selectedSet.has(remotePath)) row.classList.add('selected');
    // 刚上传成功的条目:高亮闪烁,让用户一眼看到"传到了哪"(上传目标是路径栏当前目录)
    if (state.sftpUploadFlash && state.sftpUploadFlash.has(e.name)) {
      row.classList.add('upload-flash');
      row.scrollIntoView({ block: 'nearest' });
    }

    const icon = document.createElement('span');
    icon.className = `sftp-icon ${e.isDir ? 'dir' : 'file'}`;
    icon.textContent = e.isDir ? '📁' : '📄';

    const name = document.createElement('span');
    name.className = 'sftp-name';
    name.textContent = e.isDir ? `${e.name}/` : e.name;

    const size = document.createElement('span');
    size.className = 'sftp-size';
    size.textContent = e.isDir ? '' : formatSize(e.size);

    const mtime = document.createElement('span');
    mtime.className = 'sftp-mtime';
    mtime.textContent = formatTime(e.mtime);

    row.append(icon, name, size, mtime);

    // 单击 = 选中/取消选中(多选:点几个选几个,再点一下取消)
    row.addEventListener('click', () => {
      const p = remotePath;
      if (state.sftp.selectedSet.has(p)) state.sftp.selectedSet.delete(p);
      else state.sftp.selectedSet.add(p);
      state.sftp.selected = { name: e.name, isDir: e.isDir, remotePath: p };
      updateSftpSelection(); // 只刷新高亮和底部提示,不用整列重绘
    });
    // 双击:目录 → 进入;文件 → 打开远程编辑器(直接改,保存即上传)
    row.addEventListener('dblclick', () => {
      if (e.isDir) {
        state.sftp.path = remotePath;
        loadSftpList();
      } else {
        openRemoteEditor(remotePath);
      }
    });

    // 右键:文件/目录操作菜单(下载、编辑、重命名、复制路径、删除等)
    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation(); // 别冒泡到窗口的 contextmenu/click 逻辑
      const items = [];
      if (e.isDir) {
        items.push({ label: `📂 进入「${e.name}」`, action: () => { state.sftp.path = remotePath; loadSftpList(); } });
        items.push({ separator: true });
      }
      items.push({ label: '⬇ 下载', action: () => downloadSftpEntry(remotePath, e.isDir) });
      if (!e.isDir) items.push({ label: '✏ 编辑', action: () => openRemoteEditor(remotePath) });
      items.push({ label: '✂ 重命名', action: () => renameSftpEntry(remotePath, e.name) });
      items.push({ separator: true });
      items.push({ label: '📋 复制路径', action: () => { window.api.copyText(remotePath); setStatus(`已复制路径: ${remotePath}`, 'var(--green)'); } });
      items.push({ label: '🗑 删除', danger: true, action: () => deleteSftpEntry(remotePath, e.name) });
      showCtxMenu(ev.clientX, ev.clientY, items);
    });

    els.sftpList.appendChild(row);
  }
  updateSftpSelection(); // 渲染完统一刷新选中高亮 + 底部已选数量提示
}

// ---- 传输记录(第 5 课)----
// 每次上传/下载/新建/删除都留一行记录,让用户看得见"刚才发生了什么"。
function addLog(text, isError) {
  const now = new Date();
  const p = (x) => String(x).padStart(2, '0');
  const time = `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
  state.sftp.log.push({ time, text, isError: !!isError });
  if (state.sftp.log.length > 50) state.sftp.log.shift(); // 最多留 50 条
  renderSftpLog();
}

// ---------- SFTP 远程文件编辑(双击文件 / 点"✏ 编辑") ----------
let editRemotePath = null; // 正在编辑的远程文件路径

// 打开远程文件到编辑弹窗(读内容 → 显示 → 保存写回)
async function openRemoteEditor(remotePath) {
  const sid = state.sftp.sessionId;
  if (!sid) return;
  const res = await window.api.sftpReadFile(sid, remotePath);
  if (!res || !res.ok) { alert(res && res.error ? res.error : '读取失败'); return; }
  editRemotePath = remotePath;
  els.editPath.textContent = remotePath;
  els.editContent.value = res.content;
  els.editModal.classList.remove('hidden');
  els.editContent.focus();
}

function closeEditor() {
  editRemotePath = null;
  els.editModal.classList.add('hidden');
}

// 保存:把编辑框内容写回远程文件 → 刷新 SFTP 列表
async function saveRemoteFile() {
  if (!editRemotePath) return;
  const sid = state.sftp.sessionId;
  if (!sid) return;
  const target = editRemotePath; // 先存下路径(closeEditor 会把 editRemotePath 清空,别让提示信息显示成 null)
  const res = await window.api.sftpWriteFile(sid, target, els.editContent.value);
  if (res && res.ok) {
    closeEditor();
    addLog(`已保存远程文件: ${target}`, false);
    loadSftpList(); // 文件大小/时间变了,刷新
    setStatus(`已保存: ${target}`, 'var(--green)');
  } else {
    alert(res && res.error ? `保存失败: ${res.error}` : '保存失败');
  }
}

// 工具栏"✏ 编辑"按钮:编辑当前选中的那个文件(选了目录/没选则提示)
function editSelectedFile() {
  const sel = state.sftp.selected;
  if (!sel || !sel.remotePath) { alert('先在文件列表里选中一个文件(单击)'); return; }
  if (sel.isDir) { alert('这是目录,只能编辑文件'); return; }
  openRemoteEditor(sel.remotePath);
}

function renderSftpLog() {
  if (state.sftp.log.length === 0) {
    els.sftpLog.classList.add('hidden');
    return;
  }
  els.sftpLog.classList.remove('hidden');
  els.sftpLog.innerHTML = state.sftp.log
    .map((l) => `<div class="sftp-log-item ${l.isError ? 'err' : ''}"><span class="sftp-log-time">${l.time}</span>${l.text}</div>`)
    .join('');
  els.sftpLog.scrollTop = els.sftpLog.scrollHeight; // 滚动到底,看最新一条
}

// SFTP 工具栏连接标签:显示当前连接的名称 + IP(无连接/面板清空时置空)
function setSftpConnLabel(sessionId) {
  const t = sessionId ? state.tabs.get(sessionId) : null;
  const s = t && t.session;
  els.sftpConn.textContent = t ? sftpSessionText(t) : '';
  els.sftpConn.title = s
    ? (s.displayHost
      ? `SFTP 浏览: ${s.name} · 经堡垒机 ${s.host}:${s.port} → 目标 ${s.displayHost}`
      : `SFTP 浏览: ${s.name} · ${s.host}:${s.port}`)
    : '点击切换浏览哪台已连接主机的文件';
}

// 会话在 SFTP 面板/下拉里的展示文本。
// 堡垒机会话的 host/port 是堡垒机网关地址,同堡垒机所有主机都一样 → 必须用真实目标主机(资产地址)区分。
// 真实目标优先取会话记录的 displayHost;老会话(记录缺失)从 jmsKey(serverId|资产地址|账号)
// 或 username(用户@协议@账号@资产地址)反推。
// 目标 IP 放最前:标签/下拉空间不足被截断时,丢掉的是主机名而不是区分用的 IP。
function sftpSessionText(t) {
  const s = t && t.session;
  if (!s) return '';
  let host = s.displayHost || '';
  let account = '';
  const kp = s.jmsKey ? String(s.jmsKey).split('|') : [];
  if (!host && kp[1]) host = kp[1]; // jmsKey = serverId|资产地址|账号
  if (kp[2]) account = kp[2];
  const up = String(s.username).split(/[@#]/).filter(Boolean);
  if (!account && up.length >= 3) account = up[up.length - 2];
  if (!host && up.length >= 4) host = up[up.length - 1];
  if (host) {
    // H3C 会话 username 就是账号(不含 @)
    if (!account && !String(s.username).includes('@') && !String(s.username).includes('#')) account = s.username;
    const port = s.displayPort || 22;
    return `${host} · ${s.name}${account ? '(' + account + ')' : ''}${port && port !== 22 ? ':' + port : ''}`;
  }
  return `${s.name} · ${s.host}:${s.port}`;
}

// 收起当前标签的 SFTP 面板(并记住它已关闭;别的标签的 SFTP 状态不受影响)
function closeSftpPanel() {
  const active = state.activeSessionId ? state.tabs.get(state.activeSessionId) : null;
  if (active) active.sftpOpen = false;
  state.sftp.visible = false;
  state.sftp.sessionId = null;
  els.sftpPanel.classList.add('hidden');
  els.dividerH.classList.add('hidden');
  els.btnSftpToggle.classList.remove('active');
  setSftpConnLabel(null);
  refitAll();
  syncPanelButtons();
}

// ---- 面板开关:只开关"当前激活标签"自己的 SFTP(各标签独立) ----
function toggleSftpPanel() {
  const active = state.activeSessionId ? state.tabs.get(state.activeSessionId) : null;
  // Telnet 会话没有 SFTP 通道(仅 SSH 协议能力):提醒后不开面板
  if (active && active.session && (active.session.protocol || 'ssh') === 'telnet') {
    addLog('📁 SFTP 仅支持 SSH 会话', true);
    return;
  }
  if (!active) {
    state.sftp.visible = false;
    els.sftpPanel.classList.add('hidden');
    els.dividerH.classList.add('hidden');
    syncPanelButtons();
    return;
  }
  if (active.sftpOpen) {
    // 关闭:只关当前标签的 SFTP(别的标签开没开互不影响)
    active.sftpOpen = false;
    state.sftp.visible = false;
    els.sftpPanel.classList.add('hidden');
    els.dividerH.classList.add('hidden');
    setSftpConnLabel(null);
  } else {
    // 打开:记录到当前标签,浏览它的目录
    active.sftpOpen = true;
    state.sftp.visible = true;
    state.sftp.sessionId = active.sessionId;
    // 优先定位到终端当前目录(跟踪 cd 的结果);终端目录未知时,探测默认家目录
    // (规则:当前用户家目录优先,无家目录则 /tmp),再退回上次浏览/默认
    const sid = active.sessionId;
    state.sftp.selected = null;
    els.sftpPanel.classList.remove('hidden');
    els.dividerH.classList.remove('hidden');
    setSftpConnLabel(sid);
    if (active.shellCwd) {
      state.sftp.path = active.shellCwd;
      loadSftpList();
    } else if (active.sftpPath && active.sftpPath !== '.') {
      state.sftp.path = active.sftpPath;
      loadSftpList();
    } else {
      // 探测默认家目录(主进程:realpath '.' 非根 → 用它;否则找 /root、/home/<user>,都没有 → /tmp)
      state.sftp.path = '.';
      window.api.sftpHome(sid).then((r) => {
        if (state.sftp.sessionId !== sid || !state.sftp.visible) return; // 已切换/关闭
        if (r && r.ok && r.home) state.sftp.path = r.home;
        loadSftpList();
      }).catch(() => loadSftpList());
    }
  }
  refitAll(); // 终端区域高度变了,重新适配
  syncPanelButtons();
}

// ---- SFTP 连接切换下拉:列出所有已连接的 SSH 会话,点选 = 切到该标签并打开它的 SFTP ----
function toggleSftpConnMenu() {
  const menu = els.sftpConnMenu;
  if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
  menu.textContent = '';
  const conns = [...state.tabs.values()]
    .filter((t) => t.status === 'connected' && (t.session.protocol || 'ssh') !== 'telnet')
    .sort((a, b) => (a.session.name || '').localeCompare(b.session.name || ''));
  if (!conns.length) {
    const empty = document.createElement('div');
    empty.className = 'ctx-item dim';
    empty.textContent = '没有已连接的 SSH 会话';
    menu.appendChild(empty);
  }
  for (const t of conns) {
    const item = document.createElement('div');
    item.className = 'ctx-item' + (t.sessionId === state.sftp.sessionId && state.sftp.visible ? ' active' : '');
    // 堡垒机会话显示真实目标主机(资产地址),避免同堡垒机的多台主机都显示网关地址分不清
    item.textContent = sftpSessionText(t);
    item.title = t.session.displayHost
      ? `堡垒机 ${t.session.host}:${t.session.port} → 目标 ${t.session.displayHost}`
      : `${t.session.username}@${t.session.host}:${t.session.port}`;
    item.addEventListener('click', () => {
      menu.classList.add('hidden');
      if (state.activeSessionId !== t.sessionId) activateTab(t.sessionId); // 应用该标签自己的 SFTP 状态
      if (!t.sftpOpen) toggleSftpPanel(); // 该标签还没开 SFTP → 顺手打开
      setStatus(`SFTP 已切换到「${t.session.name}」`, 'var(--green)');
    });
    menu.appendChild(item);
  }
  const rect = els.sftpConn.getBoundingClientRect();
  menu.style.left = `${Math.max(8, rect.left)}px`;
  menu.style.top = `${rect.bottom + 4}px`;
  menu.classList.remove('hidden');
}

// ---- 工具按钮 ----
async function sftpGoUp() {
  state.sftp.path = sftpParent(state.sftp.path);
  loadSftpList();
}

function sftpMakeDir() {
  // 用自定义输入弹窗代替 window.prompt(新版 Chromium 不支持 prompt)
  showPrompt({
    title: '新建目录',
    label: '目录名',
    value: 'new-folder',
    onOk: async (name) => {
      if (!name) return;
      const target = sftpJoin(name);
      const res = await window.api.sftpMkdir(sftpSession(), target);
      if (!res.ok) { addLog(`➕ 新建目录失败 ${target}: ${res.error}`, true); alert(`新建失败: ${res.error}`); return; }
      addLog(`➕ 新建目录 ${target} ✅`);
      loadSftpList();
      sftpRefocusTerminal(); // 弹窗确认按钮也别占焦点,还回终端(否则敲空格被吞)
    },
  });
}

// ---- 右键菜单操作:单条目下载 / 重命名 / 删除 ----
// 下载单个文件/目录:单文件走保存对话框(能看见目标路径),目录走"选文件夹"递归下载
async function downloadSftpEntry(remotePath, isDir) {
  const sid = sftpSession();
  if (!isDir) {
    const res = await window.api.sftpDownload(sid, remotePath);
    sftpTransferFinish(res.ok ? new Set() : new Set([remotePath]), res.error === '已取消');
    sftpRefocusTerminal();
    if (!res.ok) {
      if (res.error !== '已取消') { addLog(`⬇ 下载失败 ${remotePath}: ${res.error}`, true); alert(`下载失败: ${res.error}`); }
      return;
    }
    setStatus(`已下载 → ${res.localPath}`, 'var(--green)');
    return;
  }
  // 目录:复用"多条目下载"流程(只传它一个)
  const res = await window.api.sftpDownloadMany(sid, [{ remotePath, isDir: true }]);
  sftpTransferFinish(res.ok ? new Set(res.results.filter((r) => !r.ok).map((r) => r.remotePath)) : new Set([remotePath]), res.error === '已取消');
  sftpRefocusTerminal();
  if (!res.ok) {
    if (res.error !== '已取消') { addLog(`⬇ 下载失败 ${remotePath}: ${res.error}`, true); alert(`下载失败: ${res.error}`); }
    return;
  }
  const r = res.results[0];
  setStatus(r.ok ? `已下载 → ${r.localPath}` : `下载失败: ${r.error}`, r.ok ? 'var(--green)' : 'var(--orange)');
  if (!r.ok) addLog(`⬇ 下载失败 ${remotePath}: ${r.error}`, true);
}

// 重命名文件/目录:弹输入框,默认填原名;改名后刷新列表
function renameSftpEntry(remotePath, name) {
  showPrompt({
    title: '重命名',
    label: '新名称',
    value: name,
    onOk: async (newName) => {
      if (!newName || newName === name) return;
      const dir = remotePath.slice(0, remotePath.lastIndexOf('/'));
      const to = dir === '/' ? `/${newName}` : `${dir}/${newName}`;
      const res = await window.api.sftpRename(sftpSession(), remotePath, to);
      if (!res.ok) { alert(`重命名失败: ${res.error}`); addLog(`✂ 重命名失败 ${remotePath} → ${to}: ${res.error}`, true); return; }
      addLog(`✂ 重命名 ${remotePath} → ${to} ✅`);
      setStatus(`已重命名 → ${to}`, 'var(--green)');
      loadSftpList();
      sftpRefocusTerminal();
    },
  });
}

// 删除单个文件/目录(目录递归删空内容)
function deleteSftpEntry(remotePath, name) {
  const isDir = remotePath.endsWith('/') || state.sftp.entries.find((x) => sftpJoin(x.name) === remotePath)?.isDir;
  const tip = isDir ? '\n(目录会连同里面的所有文件/子目录一起删除)' : '';
  if (!confirm(`确定删除「${remotePath}」吗?${tip}`)) return;
  (async () => {
    const sid = sftpSession();
    const res = await window.api[isDir ? 'sftpRmdir' : 'sftpDelete'](sid, remotePath);
    if (!res.ok) { addLog(`🗑 删除失败 ${remotePath}: ${res.error}`, true); alert(`删除失败: ${res.error}`); return; }
    addLog(`🗑 删除 ${remotePath} ✅`);
    setStatus(`已删除 ${remotePath}`, 'var(--orange)');
    loadSftpList();
    sftpRefocusTerminal();
  })();
}

async function sftpDeleteSelected() {
  const list = sftpSelectedEntries();
  if (list.length === 0) { alert('先选中要删除的文件/目录(可点「全选」一次选完)'); return; }
  const hasDir = list.some((e) => e.isDir);
  const tip = hasDir ? '\n(目录会连同里面的所有文件/子目录一起删除)' : '';
  const names = list.map((e) => `${e.isDir ? '📁' : '📄'} ${sftpJoin(e.name)}`).join('\n');
  if (!confirm(`确定删除以下 ${list.length} 项吗?${tip}\n\n${names}`)) return;
  for (const e of list) {
    const path = sftpJoin(e.name); // 条目没有 remotePath,用 sftpJoin(name) 拼出完整路径
    const res = await window.api[e.isDir ? 'sftpRmdir' : 'sftpDelete'](sftpSession(), path);
    if (!res.ok) { addLog(`🗑 删除失败 ${path}: ${res.error}`, true); alert(`删除失败 ${path}: ${res.error}`); continue; }
    addLog(`🗑 删除 ${path} ✅`);
  }
  loadSftpList();
  sftpRefocusTerminal(); // 删除完焦点还给终端(按钮占焦点会吞空格)
}

async function sftpUpload() {
  const res = await window.api.sftpUpload(sftpSession(), state.sftp.path);
  sftpTransferFinish(res.ok ? new Set((res.failed || []).map((f) => f.rp)) : new Set(), res.error === '已取消'); // 行留在历史里
  sftpRefocusTerminal(); // 工具栏按钮别占着焦点,否则接着敲空格会被按钮吞掉
  if (!res.ok) {
    if (res.error !== '已取消') {
      addLog(`⬆ 上传失败: ${res.error}`, true);
      alert(`上传失败: ${res.error}`);
      // alert 是原生模态框,关闭后焦点/输入法状态可能被打乱(日志:上传失败后终端空格全吞、
      // 死键刷屏、只剩回车能发)。强制把焦点和 IME 状态还给终端,否则上传失败后终端没法打字。
      sftpRefocusTerminal();
      const tt = state.tabs.get(state.activeSessionId);
      if (tt && tt.__imeReset) try { tt.__imeReset(); } catch { /* ignore */ }
    }
    return;
  }
  // 明确告诉用户传到了哪个目录(路径栏当前目录),并记住名字用于列表高亮定位
  setStatus(`上传成功 → ${res.remotePath}(当前目录 ${state.sftp.path})`, 'var(--green)');
  state.sftpUploadFlash.add(String(res.remotePath || '').replace(/\/+$/, '').split('/').pop() || res.remotePath); // 无 Node path 模块,手写 basename
  if (res.failed && res.failed.length) {
    for (const f of res.failed) addLog(`⬆ 上传失败 ${f.rp}: ${f.error}`, true);
    alert(`有 ${res.failed.length} 个文件上传失败:\n${res.failed.map((f) => f.rp).join('\n')}`);
  }
  loadSftpList();
  // 3 秒后取消"刚上传"高亮(重新渲染一次去掉闪烁)
  setTimeout(() => {
    state.sftpUploadFlash.clear();
    if (state.sftp.visible) loadSftpList();
  }, 3000);
}

async function sftpDownload() {
  // 文件 + 目录都能选:目录递归下载到本地同名子文件夹
  const selected = sftpSelectedEntries();
  if (selected.length === 0) { alert('先选中要下载的文件/目录(可点「全选」一次选完)'); return; }

  // 只选了一个文件 → 沿用旧流程:弹"保存到哪"对话框
  if (selected.length === 1 && !selected[0].isDir) {
    const remote = sftpJoin(selected[0].name); // 条目没有 remotePath,拼出完整路径
    const res = await window.api.sftpDownload(sftpSession(), remote);
    sftpTransferFinish(res.ok ? new Set() : new Set([remote]), res.error === '已取消'); // 行留在历史里
    sftpRefocusTerminal(); // 工具栏按钮别占着焦点,否则接着敲空格会被按钮吞掉
    if (!res.ok) {
      if (res.error !== '已取消') {
        addLog(`⬇ 下载失败 ${remote}: ${res.error}`, true);
        dlog('SFTP', `⬇ 下载失败 ${remote}: ${res.error}`);
        const permTip = /EPERM|EACCES|operation not permitted|permission denied/i.test(res.error)
          ? '\n\n⚠️ 保存位置无写入权限(macOS 系统保护):换个普通文件夹,或在 系统设置→隐私与安全性→完全磁盘访问权限 里添加 Polaris(Electron)'
          : '';
        alert(`下载失败: ${res.error}${permTip}`);
      }
      return;
    }
    setStatus(`已下载 → ${res.localPath}`, 'var(--green)');
    // 单文件走保存对话框,没有 sftp:progress 事件 → 没记录行;补一条"已完成"记录,
    // 这样保存路径能一直看见,还能点 📂 打开所在文件夹
    let row = sftpTransfer.rows.get(remote);
    if (!row) {
      row = makeSftpTransferRow({ file: remote, op: 'download' });
      sftpTransfer.rows.set(remote, row);
      const list = document.getElementById('sftp-transfers-list');
      if (list) list.prepend(row.el);
      row.el.classList.remove('active');
      row.el.classList.add('done');
      row.meta.textContent = '✓';
      if (els.sftpProgress) els.sftpProgress.classList.remove('hidden');
    }
    if (row.setLocal) row.setLocal(res.localPath);
    return;
  }

  // 多个(或单个目录)→ 只弹一次"选文件夹";目录在 main 递归下载,进度统一走 sftp:progress
  const entries = selected.map((f) => ({ remotePath: sftpJoin(f.name), isDir: !!f.isDir }));
  const res = await window.api.sftpDownloadMany(sftpSession(), entries);
  sftpTransferFinish(res.ok ? new Set(res.results.filter((r) => !r.ok).map((r) => r.remotePath)) : new Set(), res.error === '已取消'); // 行留在历史里
  sftpRefocusTerminal(); // 工具栏按钮别占着焦点,否则接着敲空格会被按钮吞掉
  if (!res.ok) {
    if (res.error !== '已取消') { addLog(`⬇ 下载失败: ${res.error}`, true); alert(`下载失败: ${res.error}`); }
    return;
  }
  const ok = res.results.filter((r) => r.ok).length;
  const fail = res.results.filter((r) => !r.ok);
  setStatus(`已下载 ${ok} 个文件 → ${res.dir}`, 'var(--green)');
  // 把每个文件的本地保存路径盖到对应传输记录行上(行上有 📂 打开所在文件夹)
  res.results.filter((r) => r.ok).forEach((r) => {
    const row = sftpTransfer.rows.get(r.remotePath);
    if (row && row.setLocal) row.setLocal(r.localPath);
  });
  fail.forEach((r) => {
    addLog(`⬇ 下载失败 ${r.remotePath}: ${r.error}`, true);
    dlog('SFTP', `⬇ 下载失败 ${r.remotePath}: ${r.error}`); // 进调试面板,排查真实错误
  });
  if (fail.length) {
    // macOS TCC:桌面/文稿/下载目录受系统保护,未授权 app 写入会 EPERM/EACCES。
    // 给出明确指引,而不是让用户对着"operation not permitted"发懵。
    const permErr = fail.some((r) => /EPERM|EACCES|operation not permitted|permission denied/i.test(r.error || ''));
    const tip = permErr
      ? '\n\n⚠️ 保存位置无写入权限(macOS 系统保护):\n'
      + '· 方法1:换个普通文件夹(如 ~/Downloads/ 下的子目录需授权,建议用非受保护目录,如 ~/sftp)\n'
      + '· 方法2:系统设置 → 隐私与安全性 → 完全磁盘访问权限 → 添加 Polaris(Electron)\n'
      + '· 方法3:如果本目录不是系统保护目录,请检查磁盘剩余空间和写入权限'
      : '';
    alert(`${fail.length} 个文件下载失败:\n${fail.map((r) => `${r.remotePath}: ${r.error}`).join('\n')}${tip}`);
  }
}

// =====================================================================
// 窗口尺寸变化 → 所有终端重新适配
// =====================================================================
let resizeTimer = null;
window.addEventListener('resize', () => {
  packToolbar(); // 工具栏间距压缩/换行,不防抖(只一次布局读取,拖拽窗口时实时响应)
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const t of state.tabs.values()) {
      try {
        t.fit.fit();
        window.api.sshResize(t.sessionId, t.term.cols, t.term.rows);
      } catch { /* ignore */ }
    }
    updateTabScroll(); // 窗口变窄/变宽后刷新滚动按钮
  }, 120);
});

// ---- 标签栏滚动:◀▶ 按钮 + 滚轮横滚 ----
els.tabScrollLeft.addEventListener('click', () => scrollTabs(-1));
els.tabScrollRight.addEventListener('click', () => scrollTabs(1));
// 在标签栏上滚鼠标滚轮 → 水平滚动(不需要鼠标悬停在滚动条上)
els.tabBar.addEventListener('wheel', (e) => {
  if (e.deltaY !== 0) {
    e.preventDefault(); // 阻止垂直滚动(标签栏本来也不该垂直滚)
    els.tabBar.scrollLeft += e.deltaY;
    updateTabScroll();
  }
}, { passive: false });

// =====================================================================
// 可拖动分隔条(第 5 课)
// =====================================================================
// 通用"拖动改变尺寸"逻辑:
//   divider   分隔条元素
//   axis      'x' 横向拖动 / 'y' 纵向拖动
//   getSize   读取当前尺寸    setSize 设置新尺寸
//   min, max  允许的最小/最大尺寸
// 原理:mousedown 记下起点和当前尺寸 → mousemove 算差值 → setSize 更新 → mouseup 收工。
function makeResizer(divider, axis, getSize, setSize, min, max, reverse, onDone, onDown) {
  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (onDown) onDown();
    const startPos = axis === 'x' ? e.clientX : e.clientY;
    const startSize = getSize();
    const onMove = (ev) => {
      const pos = axis === 'x' ? ev.clientX : ev.clientY;
      // 默认:往拖拽方向 = 面板变大(面板在分隔条左侧);
      // reverse=true:面板在分隔条右侧,往拖拽反方向 = 变大(往左拖右面板变宽)
      let delta = axis === 'x' ? pos - startPos : startPos - pos;
      if (reverse) delta = -delta;
      setSize(Math.min(max, Math.max(min, startSize + delta)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      refitAll(); // 拖完重新适配终端,避免输出超出边界
      if (onDone) onDone();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

// 折叠/展开左侧会话列表(状态持久化)
function toggleSessionPanel() {
  state.settings.panelCollapsed = !state.settings.panelCollapsed;
  applyPanelCollapsed();
  saveSettings();
  refitAll(); // 终端宽度变了,重新适配
}
function applyPanelCollapsed() {
  const noTerm = state.tabs.size === 0;
  // 无终端时会话列表必须保留占位(占满窗口),不能折叠隐藏:否则 AI/命令/堡垒机等右侧面板
  // 会成为 .main-body flex 行唯一可见项被顶到最左侧(x=0)。有终端时才允许折叠隐藏左面板。
  const hidden = noTerm ? false : !!state.settings.panelCollapsed;
  els.sessionPanel.classList.toggle('hidden', hidden);
  els.dividerV.classList.toggle('hidden', hidden);
}

// 左右分隔条:调会话列表宽度(范围 160~500px),宽度持久化
makeResizer(els.dividerV, 'x',
  () => els.sessionPanel.offsetWidth,
  (w) => { els.sessionPanel.style.width = `${w}px`; },
  160, 500, false,
  () => { state.settings.sessionPanelWidth = els.sessionPanel.offsetWidth; saveSettings(); });

// 上下分隔条:调 SFTP 面板高度(范围 120~450px),高度持久化
makeResizer(els.dividerH, 'y',
  () => els.sftpPanel.offsetHeight,
  (h) => { els.sftpPanel.style.height = `${h}px`; },
  120, 450, false,
  () => { state.settings.sftpPanelHeight = els.sftpPanel.offsetHeight; saveSettings(); });

// 堡垒机 webview 的 guest view 会盖住相邻分隔条,并吞掉进入其矩形内的鼠标事件(宿主 CSS 无法干预):
// 拖拽期间临时 visibility:hidden(不重载画面),松开恢复 —— 否则横分隔条收不到 mousedown、拖动进入 webview 区域时 mousemove 断流。
const wvHideWhileDrag = () => { els.bastionWebview.style.visibility = 'hidden'; };
const wvShowAfterDrag = () => { els.bastionWebview.style.visibility = ''; };

// 堡垒机面板分隔条:拖动左右调面板宽度(范围 300~1200px),宽度持久化
// reverse=true:面板在分隔条右侧 → 往左拖 = 面板变宽(符合直觉)
applyBastionDefaultWidth();
applySessionPanelWidth(); // 会话列表宽度 / SFTP 面板高度持久化恢复
applySftpPanelHeight();
makeResizer(els.dividerBastion, 'x',
  () => els.bastionPanel.offsetWidth,
  (w) => { els.bastionPanel.style.width = `${w}px`; },
  300, 1200, true,
  () => { wvShowAfterDrag(); state.settings.bastionWidth = els.bastionPanel.offsetWidth; saveSettings(); },
  wvHideWhileDrag);

// 堡垒机面板高度:固定撑满整个区域(不再提供横分隔条上下拖动)

// =====================================================================
// 广播模式(第 5 课,参考 Xshell 的"发送到所有会话")
// =====================================================================
// 开启后:在任意一个终端里输入,会把按键同步转发给所有已连接的终端,
// 每台服务器各自实时响应。适合"给所有机器同时下发同一命令"。
function toggleBroadcast() {
  state.broadcast = !state.broadcast;
  els.btnBroadcast.classList.toggle('active', state.broadcast); // 高亮表示已开启
  if (state.broadcast) {
    const n = [...state.tabs.values()].filter((t) => t.status === 'connected').length;
    setStatus(`⚡ 广播模式:输入将同步到 ${n} 个已连接会话`, 'var(--orange)');
  } else {
    setStatus('就绪');
  }
}

// =====================================================================
// 自定义输入弹窗(替代 window.prompt,新版 Chromium 已不支持 prompt)
// =====================================================================
let promptCallback = null; // 点"确定"后要执行的回调

function showPrompt({ title, label, value, onOk, password }) {
  els.promptTitle.textContent = title || '输入';
  els.promptLabel.textContent = label || '内容';
  els.promptInput.value = value || '';
  els.promptInput.type = password ? 'password' : 'text'; // 快捷连接问密码时隐藏明文
  promptCallback = onOk;
  els.promptModal.classList.remove('hidden');
  els.promptInput.focus();
  els.promptInput.select();
}

function closePrompt() {
  promptCallback = null;
  els.promptModal.classList.add('hidden');
}

els.promptOk.addEventListener('click', () => {
  const v = els.promptInput.value.trim();
  const cb = promptCallback;
  closePrompt();
  if (cb) cb(v); // 把输入值交给调用方
});
els.promptCancel.addEventListener('click', closePrompt);
els.promptInput.addEventListener('keydown', (e) => { if (isEnterSubmit(e)) els.promptOk.click(); });

// =====================================================================
// 右键菜单:菜单项各自绑定 action;点别处 / 失焦 关闭
// =====================================================================
// 注意:右键(contextmenu)后部分平台/输入方式会紧跟一个 click 事件,若直接 closeCtxMenu,
// 菜单刚弹出就被立刻收起(表现:菜单一闪而过,反复右键重开,日志里 MENU open/close 刷屏)。
// 打开后 250ms 内的 click 视为"右键残留",忽略;真正点菜单项/点别处照常执行各自逻辑。
window.addEventListener('click', () => {
  if (Date.now() - ctxMenuOpenedAt < 250) return;
  closeCtxMenu('click');
});
window.addEventListener('blur', () => {
  // 诊断:菜单"一闪而过"全是 blur 关闭。记录失焦时刻的焦点状态,区分
  //   A) 窗口真失焦(document.hasFocus()=false,用户切走/点了别处)
  //   B) guest/webview 抢焦点(hasFocus()=true 但 window blur 仍触发——Chromium 行为)
  //   C) 焦点在 iframe/OOPIF 内(activeElement 是 webview 或 body)
  const wv = els.bastionWebview;
  const wvState = wv && wv.executeJavaScript
    ? `wv:${wv.src ? '有src' : '无src'}${wv.classList.contains('hidden') ? '/隐藏' : '/显示'}`
    : 'wv:不存在';
  const ae = document.activeElement;
  const aeDesc = ae ? (ae.tagName + (ae.id ? '#' + ae.id : '') + (ae.className && typeof ae.className === 'string' ? '.' + String(ae.className).slice(0, 40) : '')) : 'null';
  const menuOpen = els.ctxMenu && !els.ctxMenu.classList.contains('hidden');
  dlog('FOCUS', `window blur: hasFocus=${document.hasFocus()} active=${aeDesc} ${wvState} menuOpen=${menuOpen}`);
  closeCtxMenu('blur');
});

// =====================================================================
// 终端内搜索(Cmd/Ctrl+F)
// =====================================================================
let searchTarget = null; // 当前搜索的终端标签

function openTermSearch() {
  const t = state.tabs.get(state.activeSessionId);
  if (!t || !t.searchAddon) return;
  searchTarget = t;
  els.termSearch.classList.remove('hidden');
  els.termSearchInput.value = '';
  els.termSearchCount.textContent = '';
  try {
    // 实时显示 "第几个/总数";onDidChangeResults 返回 disposable,重复注册前先释放旧的
    // (旧版每次打开都注册新回调,同一标签反复搜索会累积回调重复写计数)
    if (t._searchDisposable) { try { t._searchDisposable.dispose(); } catch { /* ignore */ } }
    t._searchDisposable = t.searchAddon.onDidChangeResults(({ resultCount, resultIndex }) => {
      els.termSearchCount.textContent = resultCount ? `${resultIndex + 1}/${resultCount}` : '0/0';
    });
  } catch { /* 兼容旧版 */ }
  els.termSearchInput.focus();
}

// 把空格分隔的多个关键词转成"匹配任意一个"的正则: "error failed" → /(error|failed)/i
function buildBatchRegex(text) {
  const terms = text.trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return null;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(terms.map(esc).join('|'), 'i');
}

function doTermSearch(dir) {
  const t = searchTarget || state.tabs.get(state.activeSessionId);
  if (!t || !t.searchAddon) return;
  const text = els.termSearchInput.value;
  if (!text) { els.termSearchCount.textContent = ''; return; }
  const opts = { decorations: { matchBackground: '#264f78', activeMatchBackground: '#2d7dd2' } };
  const terms = text.trim().split(/\s+/).filter(Boolean);
  const query = terms.length > 1 ? buildBatchRegex(text) : text; // 多词 → 批量正则
  if (query === null) return;
  const options = terms.length > 1 ? { ...opts, regex: true } : opts;
  try {
    if (dir === 'prev') t.searchAddon.findPrevious(query, options);
    else t.searchAddon.findNext(query, options);
  } catch { /* 渲染时序问题偶发,忽略 */ }
}

function closeTermSearch() {
  els.termSearch.classList.add('hidden');
  if (searchTarget) {
    try { searchTarget.searchAddon.clearDecorations(); } catch { /* ignore */ }
  }
  searchTarget = null;
  const t = state.tabs.get(state.activeSessionId);
  if (t) t.term.focus();
}

// =====================================================================
// 应用菜单(文件/视图/帮助)触发的事件
// =====================================================================
window.api.onMenu((ch) => {
  if (ch === 'menu:new-session') openSessionModal(null);
  else if (ch === 'menu:new-group') newGroup();
  else if (ch === 'menu:import') openImportModal();
  else if (ch === 'menu:export') exportSessions();
  else if (ch === 'menu:toggle-panel') toggleSessionPanel();
  else if (ch === 'menu:settings') openSettingsModal();
  else if (ch === 'menu:split-v') splitActivePane('v');
  else if (ch === 'menu:split-h') splitActivePane('h');
  else if (ch === 'menu:sftp') toggleSftpPanel();
  else if (ch === 'menu:tunnel') openTunnelModal();
  else if (ch === 'menu:batch') toggleBatchPanel();
  else if (ch === 'menu:quick') openQuickModal();
  else if (ch === 'menu:cmd') toggleCmdPanel();
  else if (ch === 'menu:record-toggle') toggleRecord();
  else if (ch === 'menu:record-list') openRecordingsModal();
  else if (ch === 'menu:log-open') window.api.logOpenDir();
  else if (ch === 'menu:ai') toggleAiPanel();
  else if (ch === 'menu:connect') menuConnect();
  else if (ch === 'menu:disconnect') menuDisconnect();
  else if (ch === 'menu:lock') requestLock();
  else if (ch === 'menu:jms') openJmsModal();
  else if (ch === 'menu:about') {
    alert('Polaris\n类 Xshell 的 SSH/SFTP 终端\n\nElectron + xterm.js + ssh2 + SQLite\n纯本地,无服务器');
  }
});

// =====================================================================
// 事件绑定
// =====================================================================
els.btnNewSession.addEventListener('click', () => openSessionModal(null));
// ---- 快捷连接(临时直连,不保存会话) ----
function toggleQuickConnect() {
  const hidden = els.quickConnect.classList.toggle('hidden');
  if (!hidden) { els.qcInput.focus(); els.qcInput.select(); }
}
function quickConnect() {
  const raw = els.qcInput.value.trim();
  if (!raw) return;
  // 解析 user@host[:port];缺用户名默认 root(纯主机/域名也能直连)
  const m = raw.match(/^(?:([^@\s]+)@)?([^@:\s]+)(?::(\d+))?$/);
  if (!m || !m[2]) { setStatus('快捷连接格式: user@host[:port]', 'var(--red)'); return; }
  const user = m[1] || 'root';
  const host = m[2];
  const port = m[3] ? parseInt(m[3], 10) : 22;
  // 已保存会话里同 host+user 且带密码/密钥 → 直接复用凭证
  const hit = state.sessions.find((s) => s.host === host && s.username === user && (s.password || s.private_key));
  if (hit) doQuickConnect({ user, host, port, password: hit.password || '', privateKey: hit.private_key || '', passphrase: hit.passphrase || '' });
  else showPrompt({ title: '快捷连接', label: `${user}@${host}:${port} 的登录密码`, password: true, onOk: (pw) => doQuickConnect({ user, host, port, password: pw }) });
}
function doQuickConnect(s) {
  connectToServer({ name: `${s.user}@${s.host}`, host: s.host, port: s.port, username: s.user, password: s.password || '', privateKey: s.privateKey || '', passphrase: s.passphrase || '', encoding: 'utf8' });
  els.quickConnect.classList.add('hidden');
}
els.btnQuickConnect.addEventListener('click', toggleQuickConnect);
els.qcGo.addEventListener('click', quickConnect);
els.qcClose.addEventListener('click', () => els.quickConnect.classList.add('hidden'));
els.qcInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) quickConnect(); });

els.btnNewGroup.addEventListener('click', newGroup); // 新建分组
els.btnTogglePanel.addEventListener('click', toggleSessionPanel); // 折叠/展开会话列表
els.vsGrid.addEventListener('click', () => setSessionView('grid')); // 网格视图
els.vsList.addEventListener('click', () => setSessionView('list')); // 列表视图
els.vsTree.addEventListener('click', () => setSessionView('tree')); // 树形视图

// 批量操作
els.batchConnect.addEventListener('click', batchConnect);
els.batchClose.addEventListener('click', batchClose);
els.batchUpload.addEventListener('click', batchUpload);
els.batchDownload.addEventListener('click', batchDownload);
els.batchDelete.addEventListener('click', batchDelete);
els.batchClear.addEventListener('click', batchClear);

// 终端内搜索
els.termSearchInput.addEventListener('keydown', (e) => {
  if (isEnterSubmit(e)) { e.preventDefault(); doTermSearch(e.shiftKey ? 'prev' : 'next'); }
  else if (e.key === 'Escape') closeTermSearch();
});
els.termSearchInput.addEventListener('input', () => doTermSearch('next'));
els.termSearchNext.addEventListener('click', () => doTermSearch('next'));
els.termSearchPrev.addEventListener('click', () => doTermSearch('prev'));
els.termSearchClose.addEventListener('click', closeTermSearch);
els.modalSave.addEventListener('click', saveSession);
els.modalCancel.addEventListener('click', closeSessionModal);
// 协议切换:显示/隐藏 SSH 专属字段,端口/账号标签随协议变
els.fProtocol.addEventListener('change', () => {
  const v = els.fProtocol.value;
  // 新建会话切协议时把默认端口顺带改对(编辑已有会话不碰真实端口)
  const cur = parseInt(els.fPort.value, 10);
  if (v === 'telnet' && cur === 22) els.fPort.value = 23;
  else if (v === 'ssh' && cur === 23) els.fPort.value = 22;
  applySessionProtocol(v);
});
// 「浏览…」选私钥文件:弹原生文件对话框,把路径填进输入框
els.fPrivateKeyPick.addEventListener('click', async () => {
  const res = await window.api.pickKeyFile();
  if (res && res.ok) els.fPrivateKey.value = res.path;
});
// 测试连接:不登录;协议感知——SSH 必须收到 SSH banner、Telnet 等到数据才算真的可达(端口 accept 但无服务不误报成功)
els.fTestConn.addEventListener('click', async () => {
  const host = els.fHost.value.trim();
  const port = parseInt(els.fPort.value, 10) || (els.fProtocol.value === 'telnet' ? 23 : 22);
  const res = els.fTestConnResult;
  if (!host) { res.textContent = '先填写主机'; res.className = 'tcr tcr-bad'; return; }
  res.textContent = '⏳ 测试中…'; res.className = 'tcr tcr-run';
  try {
    const r = await window.api.testConnect({ host, port, protocol: els.fProtocol.value, timeoutMs: 2500 });
    if (r && r.ok) { res.textContent = `✅ ${host}:${port} ${r.message}`; res.className = 'tcr tcr-ok'; }
    else { res.textContent = `❌ ${host}:${port} ${(r && r.message) || '连接失败'}`; res.className = 'tcr tcr-bad'; }
  } catch (e) {
    res.textContent = '⚠ 测试失败: ' + ((e && e.message) || e); res.className = 'tcr tcr-bad';
  }
});
// 堡垒机浏览器入口:点击打开右侧浏览器(带标签页)
els.btnBastionBrowser.addEventListener('click', (e) => { e.stopPropagation(); openBastionPanel(); });
// 端口探测
els.btnPortProbe.addEventListener('click', (e) => { e.stopPropagation(); openProbeModal(); });
els.probeClose.addEventListener('click', closeProbeModal);
els.probeRun.addEventListener('click', runPortProbe);
els.probeHost.addEventListener('keydown', (e) => { if (isEnterSubmit(e)) { e.preventDefault(); runPortProbe(); } });
els.probePorts.addEventListener('keydown', (e) => { if (isEnterSubmit(e)) { e.preventDefault(); runPortProbe(); } });
// 导入/导出已移到"文件"菜单(menu:import / menu:export)
// 修改密码
els.setPwd.addEventListener('click', openPwdModal);
els.pwdSave.addEventListener('click', changePassword);
els.pwdCancel.addEventListener('click', closePwdModal);
els.ansiReset.addEventListener('click', resetAnsi);
// 密码确认弹窗(删除有主机的分组等危险操作)
els.confirmPwdOk.addEventListener('click', confirmPwdOk);
els.confirmPwdCancel.addEventListener('click', confirmPwdCancel);
els.importSave.addEventListener('click', doImport);
// 手动改了粘贴文本 → 之前选文件解析的"待导入"作废(导入按钮改走文本)
els.importText.addEventListener('input', () => { pendingImport = null; });
els.importCancel.addEventListener('click', closeImportModal);
els.importExcel.addEventListener('click', () => els.importFile.click()); // 按钮 → 触发隐藏的文件选择框
els.importFile.addEventListener('change', importFromExcel); // 选中文件后解析导入
// 从加密备份(.polaris)导入
els.importBackup.addEventListener('click', () => els.importBackupFile.click());
els.importBackupFile.addEventListener('change', importBackupSelected);
// 从 Xshell/iTerm2 导入
els.importExternal.addEventListener('click', () => els.importExternalFile.click());
els.importExternalFile.addEventListener('change', importExternalSelected);
// 备份文件密码弹窗
els.filePwdOk.addEventListener('click', confirmFilePwd);
els.filePwdCancel.addEventListener('click', closeFilePwd);
els.importTemplate.addEventListener('click', saveTemplate); // 下载导入模板
els.btnBroadcast.addEventListener('click', toggleBroadcast); // 广播模式开关
els.btnConnect.addEventListener('click', toggleConnectDisconnect); // 连接/中断二合一
els.btnLock.addEventListener('click', requestLock); // 锁定
els.bastionMini.addEventListener('click', restoreBastion);
els.bastionCfg.addEventListener('click', openBastionCfg);
// 🧹 清除历史:只清堡垒机浏览器的会话记录(浏览历史/登录态/表单/缓存),webview 回到空白页。
// 不动左侧已保存的连接与已捕获的资产——那些是 app 自己的数据(主机列表),不属于浏览历史,误删会让用户以为连接丢了。
els.bastionClear.addEventListener('click', async () => {
  if (!confirm('清除堡垒机浏览器的全部历史记录吗?\n将清除:浏览历史、登录态(cookie)、表单与缓存。所有堡垒机站点需重新登录。')) return;
  try {
    await window.api.bastionClearAll(); // 清 persist:bastion partition(webview 会话)
    // webview 回到空白页
    try { els.bastionWebview.src = 'about:blank'; } catch { /* ignore */ }
    els.bastionCurrent.textContent = '';
    els.bastionUrl.value = '';
    // 清持久化默认地址:否则重启后 restoreBastion 又自动打开并加载旧地址
    state.settings.bastionUrl = '';
    // 清掉已保存连接的登录态(token/user),保留连接配置与已缓存资产(名称/地址/账号/密码/主机列表)
    for (const s of bastionServers()) {
      s.token = null;
      s.user = null;
    }
    saveSettings();
    renderSessionList(els.inputSessionSearch.value);
    setStatus('堡垒机浏览器历史已清除,所有站点需重新登录', 'var(--green)');
  } catch (e) {
    setStatus('清除失败: ' + (e && e.message), 'var(--red)');
  }
});
els.bastionEmptyCfg.addEventListener('click', openBastionCfg);
els.bastionCfgClose.addEventListener('click', closeBastionCfg);
els.bastionCfgAdd.addEventListener('click', bastionCfgAdd);
els.bastionServerSelect.addEventListener('change', () => { if (els.bastionServerSelect.value) bastionSelectServer(els.bastionServerSelect.value); });
els.bastionGo.addEventListener('click', bastionLoadSelected); // 打开:优先用下拉选中的堡垒机(带账号密码自动填充),否则加载地址栏输入的地址
els.bastionMin.addEventListener('click', minimizeBastion);
els.bastionUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) loadBastion(els.bastionUrl.value.trim()); });
els.bastionBack.addEventListener('click', () => { try { els.bastionWebview.goBack(); } catch { /* ignore */ } });
els.bastionForward.addEventListener('click', () => { try { els.bastionWebview.goForward(); } catch { /* ignore */ } });
els.bastionReload.addEventListener('click', () => { try { els.bastionWebview.reload(); } catch { /* ignore */ } });
els.bastionClose.addEventListener('click', closeBastionPanel); // ✕ 彻底关闭(与 — 最小化区分)
// 画面缩放(支持 0.5~2.5,按住可连续缩放)
els.bastionZoomIn.addEventListener('click', () => setBastionZoom(0.1));
els.bastionZoomOut.addEventListener('click', () => setBastionZoom(-0.1));
applyBastionZoom(); // 应用持久化的缩放级别
initBastionWebview();
// 低频兜底:15s 才轮询一次 H3C 资产(用户操作页面时由 bastionFocusCheck 事件驱动快速同步;
// 闲置时资产不会变,4s 空转纯属浪费 → 降频,见 bastionFocusCheckPending)
setInterval(pollBastionAssets, 15000);

// 键盘焦点桥(宿主侧):click 进 webview guest 不会把宿主焦点移到 webview 元素上,
// 之后按键会被宿主当前焦点(地址框等)吞掉,guest 输入框"打不进去"。用 guest 注入的
// __bastionFocusTs(mousedown/pointerdown 时间戳)判断"用户最近操作在 guest",把焦点补回 webview。
window.__hostEditableTs = 0;
window.__hostAnyClickTs = 0; // 宿主侧任意 mousedown 时间戳:用户点主界面任何地方都记,
// 让焦点检查不抢回(否则只记 INPUT/可编辑会漏掉"点会话列表/工具栏/空白区"这些非输入区,
// guest ts 比它新 → 打开网页 SFTP 后焦点被 webview 反复抢走,点主界面无效 → "无法退回")。
document.addEventListener('mousedown', (e) => {
  window.__hostAnyClickTs = Date.now();
  // 宿主可编辑元素被点击 → 记时间,让焦点检查不抢回(用户在输地址/AI/搜索等)
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) window.__hostEditableTs = Date.now();
}, true);
// 用户最近是否操作过 guest(H3C 页面):读宿主侧镜像 __guestInteractTs
// (由 bastionFocusCheck 在检测到 guest 交互时更新),5 秒内有操作 → true。
// 避免每 4s 轮询:闲置时(用户没动 H3C 页面)资产不会变,轮询纯属浪费。
let __guestInteractTs = 0; // 宿主侧镜像:用户最近操作 guest 的时间(由 focus check 更新)
window.__guestInteractTs = 0;
let bastionPollScheduled = false; // 事件驱动轮询防抖:500ms 内只同步一次
let bastionFetchOkNotified = false; // "拉取完成"已提示过(重复成功不再刷状态栏)
let bastionFetchFailNotified = false; // "拉取失败/未完成"已提示过(重复失败不打扰用户)
function bastionFocusCheckPending() {
  return Date.now() - (window.__guestInteractTs || 0) < 5000;
}
function bastionFocusCheck() {
  const wv = els.bastionWebview;
  if (!wv || !wv.executeJavaScript) return;
  if (els.bastionSlot.classList.contains('hidden')) return; // 面板收起:不打扰
  if (!els.lockOverlay.classList.contains('hidden')) return; // 锁定中:webview 已 display:none
  // 右键菜单打开时不抢焦点:否则 guest 的 __bastionFocusTs 一更新,这里 wv.focus() 会
  // 触发 window blur → 菜单刚弹出就被关闭("一闪而过",日志 close:blur 刷屏)。
  if (els.ctxMenu && !els.ctxMenu.classList.contains('hidden')) return;
  if (document.activeElement === wv) return; // 键盘焦点已在 webview:无需轮询
  // 终端输入框正持有焦点 → 不轮询不抢焦点:用户正在终端打字/刚连上,任何抢焦点都会造成
  // 窗口假失焦、按键被吞(日志表现:连接后无按键、被迫重连)。用户点进 H3C 页面再接管。
  const hostAe = document.activeElement;
  if (hostAe && hostAe.classList && hostAe.classList.contains('xterm-helper-textarea')) return;
  try {
    wv.executeJavaScript('window.__bastionFocusTs || 0').then((ts) => {
      // 镜像 guest 交互时间到宿主:供 pollBastionAssets 判断"用户正在操作 H3C 页面"
      // → 立即同步资产(事件驱动);闲置时 poll 走 15s 低频兜底,不再每 4s 空转。
      if (ts) {
        window.__guestInteractTs = ts;
        // 用户刚操作过 H3C 页面 → 立即同步一次资产(事件驱动,不等 15s 兜底)
        // 防抖:500ms 内的连续操作只触发一次同步,避免操作期间重复 executeJavaScript
        if (!bastionPollScheduled) {
          bastionPollScheduled = true;
          setTimeout(() => { bastionPollScheduled = false; pollBastionAssets(); }, 400);
        }
      }
      // 只在"用户最近 3 秒内点过 guest"时才补焦点。旧逻辑只要 guest 里点过一次
      // (ts > __hostEditableTs,该条件几乎恒成立)就永远每 500ms 抢一次焦点:
      // webview 反复获得焦点 → window 触发"假 blur"(hasFocus 仍 true)刷屏,
      // 且焦点一直被抢,用户想点 ✕ 关闭面板 / 操作主界面都会被干扰。
      const recent = ts && (Date.now() - ts) < 3000;
      // 用户最近在宿主(主界面)点过(任意位置)→ 不抢焦点:焦点跟用户走,
      // 否则打开网页 SFTP 后 webview 一直抢焦点,点主界面无效,退不回来。
      const hostClickedLater = (window.__hostAnyClickTs || 0) >= (ts || 0);
      // 终端输入框正持有焦点 → 不抢(与开头早退一致,防 async .then 期间焦点刚落到终端):
      // 否则用户刚连上/正在打字,这里 wv.focus() 顶走焦点 → 窗口假失焦,按键全被吞。
      const termFocused = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('xterm-helper-textarea');
      if (recent && !hostClickedLater && !termFocused && ts > (window.__hostEditableTs || 0) && document.activeElement !== wv) wv.focus();
    }).catch(() => {});
  } catch { /* 导航中 executeJavaScript 可能短暂不可用,忽略 */ }
}
setInterval(bastionFocusCheck, 500); // 点进 guest 后 ~0.5s 内把键盘焦点补回 webview(150ms 太频,IPC 往返过多)
updateBastionMini();
els.jmsServerSelect.addEventListener('change', () => jmsSelectServer(els.jmsServerSelect.value));
els.jmsServerAdd.addEventListener('click', jmsAddServer);
els.jmsServerDel.addEventListener('click', jmsDeleteServer);
// 登录按钮:OTP 输入框可见时 = 提交双因素验证码;否则普通登录
// (注意:触发 MFA 时 display 被置空串恢复显示,空串是 falsy,不能再用 ! 判断隐藏态)
els.jmsLoginBtn.addEventListener('click', () => {
  if (els.jmsOtpWrap.style.display !== 'none') jmsDoMfa();
  else jmsDoLogin();
});
els.jmsSaveBtn.addEventListener('click', jmsDoSave);
els.jmsLogoutBtn.addEventListener('click', jmsLogout);
els.jmsRefreshBtn.addEventListener('click', jmsRefreshActive);
els.jmsClose.addEventListener('click', closeJmsModal);
els.jmsPass.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) jmsDoLogin(); });
els.jmsOtp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) jmsDoMfa(); });
// 高级设置区展开/收起
els.jmsAdvToggle.addEventListener('click', () => {
  const hidden = els.jmsAdvBody.style.display === 'none';
  els.jmsAdvBody.style.display = hidden ? '' : 'none';
  els.jmsAdvToggle.textContent = hidden ? '高级(SSH 网关留空自动检测) ▴' : '高级(SSH 网关留空自动检测) ▾';
});
els.loBtn.addEventListener('click', submitLock); // 锁定覆盖层:解锁按钮
els.loPw.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) submitLock(); });
// 视图下拉菜单:垂直/横向分屏
els.btnView.addEventListener('click', toggleViewMenu);
els.viewMenu.addEventListener('click', onViewMenuClick);
// 点菜单外任意处收起(和录制菜单同一个套路)
document.addEventListener('click', (e) => {
  if (!els.viewMenu.contains(e.target) && !els.btnView.contains(e.target)) els.viewMenu.classList.add('hidden');
});

// 设置
els.btnSettings.addEventListener('click', () => {
  // 打开按钮兼关闭:已打开再点一下收起
  if (els.settingsModal.classList.contains('hidden')) openSettingsModal();
  else closeSettingsModal();
});
// ---- 输出过滤:工具栏按钮 → 弹窗创建多个条件、复选框多选启用 ----
let outputFilterSeq = 0; // 条件 id 自增
function outputFilters() { return state.settings.outputFilters || (state.settings.outputFilters = []); }
// 生效的过滤词 = 勾选的条件(逗号连接),供 filterWrite 使用
function computeOutputFilter() {
  outputFilterKw = outputFilters().filter((f) => f.on).map((f) => f.kw).filter(Boolean).join(', ');
}
function renderFilterStatus() {
  const on = outputFilters().filter((f) => f.on);
  if (on.length) {
    els.filterStatus.textContent = `当前生效 ${on.length} 个: ${on.map((f) => f.kw).join('、')}`;
    els.filterStatus.classList.add('active');
    els.btnFilter.classList.add('active');
  } else {
    els.filterStatus.textContent = '未启用过滤条件(全部输出常亮)';
    els.filterStatus.classList.remove('active');
    els.btnFilter.classList.remove('active');
  }
}
function renderFilterList() {
  const list = outputFilters();
  els.filterList.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'filter-empty';
    empty.textContent = '还没有过滤条件,输入关键词点「＋ 添加」';
    els.filterList.appendChild(empty);
    return;
  }
  for (const f of list) {
    const row = document.createElement('div');
    row.className = 'filter-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!f.on;
    cb.title = '勾选则启用该条件';
    cb.addEventListener('change', () => { f.on = cb.checked; computeOutputFilter(); renderFilterStatus(); });
    const txt = document.createElement('span');
    txt.className = 'filter-kw-text';
    txt.textContent = f.kw;
    const del = document.createElement('button');
    del.className = 'filter-del';
    del.textContent = '✕';
    del.title = '删除该条件';
    del.addEventListener('click', () => {
      state.settings.outputFilters = outputFilters().filter((x) => x.id !== f.id);
      computeOutputFilter();
      renderFilterStatus();
      renderFilterList();
      saveSettings();
    });
    row.appendChild(cb);
    row.appendChild(txt);
    row.appendChild(del);
    els.filterList.appendChild(row);
  }
}
function openFilterModal() {
  renderFilterList();
  renderFilterStatus();
  els.filterModal.classList.remove('hidden');
  els.filterNewKw.focus();
}
function closeFilterModal() { els.filterModal.classList.add('hidden'); }
function addOutputFilter() {
  const kw = els.filterNewKw.value.trim();
  if (!kw) { els.filterNewKw.focus(); return; }
  outputFilters().push({ id: ++outputFilterSeq, kw, on: true });
  els.filterNewKw.value = '';
  computeOutputFilter();
  renderFilterList();
  renderFilterStatus();
  saveSettings();
  els.filterNewKw.focus();
}
els.btnFilter.addEventListener('click', openFilterModal);
els.filterAdd.addEventListener('click', addOutputFilter);
els.filterNewKw.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); addOutputFilter(); } });
els.filterApply.addEventListener('click', () => { closeFilterModal(); });
els.filterClear.addEventListener('click', () => {
  state.settings.outputFilters = [];
  computeOutputFilter();
  renderFilterList();
  renderFilterStatus();
  saveSettings();
});
els.filterCloseX.addEventListener('click', closeFilterModal);
// 终端调试日志面板
initDebugPanelDrag(); // 面板头部可拖动 + 位置记忆
els.btnDebug.addEventListener('click', toggleDebugPanel);
els.debugClose.addEventListener('click', () => { els.debugPanel.classList.add('hidden'); els.btnDebug.classList.remove('active'); });
els.debugClear.addEventListener('click', () => { termDebug.lines.length = 0; renderDebugBody(); });
els.debugCopy.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(termDebug.lines.join('\n')); setStatus('调试日志已复制到剪贴板'); }
  catch { setStatus('复制失败', 'var(--red)'); }
});
// 「⬇ 下载日志」:打包完整日志(主进程 console + 渲染层 console + dlog + 异常 + 系统信息)
// 到剪贴板/文件 —— 排障时一键导出全部记录发给开发者
els.debugDownload.addEventListener('click', async () => {
  try {
    const r = await window.api.appLogDump();
    if (!r || !r.ok || !r.content) { setStatus('日志导出失败', 'var(--red)'); return; }
    // 同时进剪贴板,方便直接粘贴给开发者
    try { await navigator.clipboard.writeText(r.content); } catch { /* ignore */ }
    // 下载为文件(带日期)
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const fname = `polaris-logs-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.log`;
    const blob = new Blob([r.content], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    setStatus(`完整日志已下载(${fname})并复制到剪贴板`, 'var(--green)');
  } catch (e) { setStatus('下载日志失败: ' + (e && e.message), 'var(--red)'); }
});
els.debugSave.addEventListener('click', async () => {
  const r = await window.api.debugSave(termDebug.lines.join('\n'));
  if (r && r.ok) setStatus(`调试日志已保存: ${r.path}`);
  else setStatus('保存调试日志失败', 'var(--red)');
});
els.setClose.addEventListener('click', closeSettingsModal);
els.setTheme.addEventListener('change', () => {
  state.settings.theme = els.setTheme.value;
  saveSettings();
  applyTheme();
});
els.setBootIntro.addEventListener('change', () => {
  state.settings.bootIntro = els.setBootIntro.value;
  saveSettings();
});
els.setHighlight.addEventListener('change', () => {
  state.settings.highlight = els.setHighlight.checked;
  saveSettings();
});
// 设置弹窗右上角 ✕ 关闭
els.setCloseX.addEventListener('click', closeSettingsModal);
els.setFontSize.addEventListener('change', () => {
  state.settings.fontSize = parseInt(els.setFontSize.value, 10) || 13;
  saveSettings();
  applyFontSettings();
});
els.setUiFontSize.addEventListener('change', () => {
  state.settings.uiFontSize = parseInt(els.setUiFontSize.value, 10) || 13;
  saveSettings();
  applyTheme(); // 应用新界面字号(--ui-font)
});
els.setFontFamily.addEventListener('change', () => {
  if (els.setFontFamily.value !== '__custom__') {
    state.settings.fontFamily = els.setFontFamily.value;
    saveSettings();
    applyFontSettings();
  }
  syncFontFamilyControls(); // 同步下拉与自定义输入框(选「自定义…」→ 显示并回填;选预设 → 隐藏)
});
els.setFontFamilyCustom.addEventListener('change', () => {
  const v = els.setFontFamilyCustom.value.trim();
  state.settings.fontFamily = v || '"SF Mono", Menlo, Consolas, "Courier New", monospace';
  saveSettings();
  applyFontSettings();
});
els.setAutoReconnect.addEventListener('change', () => {
  state.settings.autoReconnect = els.setAutoReconnect.checked;
  saveSettings();
});
els.setVerify.addEventListener('change', () => {
  state.settings.verifyHostKey = els.setVerify.checked;
  saveSettings();
});
els.setAutoTrust.addEventListener('change', () => {
  state.settings.autoTrustHostKey = els.setAutoTrust.checked;
  saveSettings();
});
els.setRestore.addEventListener('change', () => {
  state.settings.restoreOnStartup = els.setRestore.checked;
  saveSettings();
});
els.setCmdRecord.addEventListener('change', () => {
  state.settings.cmdRecord = els.setCmdRecord.checked;
  saveSettings();
  updateCmdRecordBtn();
});
els.setSessionLog.addEventListener('change', () => {
  state.settings.sessionLog = els.setSessionLog.checked;
  saveSettings();
});
els.setAutoFillPw.addEventListener('change', () => {
  state.settings.autoFillPassword = els.setAutoFillPw.checked;
  saveSettings();
});
els.setLockIdle.addEventListener('change', () => {
  state.settings.lockIdleMin = Math.max(0, parseInt(els.setLockIdle.value, 10) || 0);
  saveSettings();
  resetIdleLock(); // 改完立即按新间隔重新计时
});
// 字段 blur 自动保存 → 写进"当前厂商"的配置(每家独立)
els.aiKey.addEventListener('change', async () => {
  const v = activeAiVendor();
  if (v) { v.key = await encryptSecret(els.aiKey.value.trim()); saveSettings(); }
});
els.aiUrl.addEventListener('change', () => {
  const v = activeAiVendor();
  if (v) { v.url = els.aiUrl.value.trim(); saveSettings(); }
});
els.aiModel.addEventListener('change', () => {
  const v = activeAiVendor();
  if (v) { v.model = els.aiModel.value; saveSettings(); }
});
els.aiModelAdd.addEventListener('click', addAiModel); // ＋ 添加模型
els.aiModelDel.addEventListener('click', delAiModel); // 🗑 删除当前模型
els.aiFormat.addEventListener('change', () => {
  const v = activeAiVendor();
  if (v) { v.format = els.aiFormat.value; saveSettings(); }
});
// 头部厂商下拉框:切换激活厂商
els.aiVendorSelect.addEventListener('change', () => selectAiVendor(els.aiVendorSelect.value));

// 「保存配置」:编辑的是"当前激活厂商"。
// 改厂商名 = 给当前厂商改名(配置跟着走,不产生孤儿);新增用「＋ 新增厂商」。
els.aiConfigSave.addEventListener('click', async () => {
  const vendors = state.settings.aiVendors || (state.settings.aiVendors = {});
  const oldName = state.settings.aiActiveVendor;
  const name = els.aiVendor.value.trim();
  if (!name) { alert('厂商名称不能为空'); return; }
  const v = vendors[oldName] || {};
  if (name !== oldName) {
    if (vendors[name] && !confirm(`「${name}」已存在,要覆盖它的配置吗?`)) return;
    delete vendors[oldName]; // 改名:旧名字的配置挪到新名字
  }
  v.url = els.aiUrl.value.trim();
  v.key = await encryptSecret(els.aiKey.value.trim()); // safeStorage 加密落盘
  v.format = els.aiFormat.value;
  if (!Array.isArray(v.models)) v.models = [];
  const mdl = els.aiModel.value;
  if (mdl && !v.models.includes(mdl)) v.models.push(mdl);
  v.model = mdl || v.models[0] || '';
  vendors[name] = v;
  state.settings.aiActiveVendor = name;
  saveSettings();
  fillVendorSelect();
  fillAiConfig();
  const btn = els.aiConfigSave;
  btn.textContent = '已保存 ✓';
  btn.classList.add('active');
  setTimeout(() => { btn.textContent = '保存配置'; btn.classList.remove('active'); }, 1200);
});

// 「＋ 新增厂商」:先起个名字,立刻建一家空配置并切过去编辑
els.aiVendorNew.addEventListener('click', () => {
  showPrompt({
    title: '新增模型厂商',
    label: '厂商名称(如 OpenAI / 通义千问 / 智谱)', value: '',
    onOk: (name) => {
      name = (name || '').trim();
      if (!name) return;
      const vendors = state.settings.aiVendors || (state.settings.aiVendors = {});
      if (vendors[name]) { alert('该厂商已存在,直接编辑即可'); selectAiVendor(name); return; }
      vendors[name] = { url: '', key: '', format: 'anthropic', model: '', models: ['deepseek-v4-flash', 'deepseek-v4-pro'] };
      state.settings.aiActiveVendor = name;
      saveSettings();
      fillVendorSelect();
      fillAiConfig();
    },
  });
});

// 「🗑 删除厂商」:删掉当前厂商,切到剩下第一家
els.aiVendorDel.addEventListener('click', () => {
  const name = state.settings.aiActiveVendor;
  if (!name) return;
  if (!confirm(`删除厂商「${name}」的全部配置?`)) return;
  delete state.settings.aiVendors[name];
  const keys = Object.keys(state.settings.aiVendors || {});
  state.settings.aiActiveVendor = keys[0] || '';
  saveSettings();
  fillVendorSelect();
  fillAiConfig();
});

// AI 助手
els.btnAi.addEventListener('click', toggleAiPanel);
// 主机多选下拉:点按钮展开/收起,点外部收起
els.aiHostToggle.addEventListener('click', (e) => { e.stopPropagation(); els.aiHostPanel.classList.toggle('hidden'); });
document.addEventListener('click', (e) => {
  if (els.aiHostDrop && !els.aiHostDrop.contains(e.target)) els.aiHostPanel.classList.add('hidden');
});
els.aiClose.addEventListener('click', () => { hideWebviewDuringAiToggle(); els.aiPanel.classList.add('hidden'); syncPanelButtons(); });
// 命令记录面板:开关 / 清空 / 导出 / 关闭
els.btnCmd.addEventListener('click', toggleCmdPanel);
els.cmdClose.addEventListener('click', () => { els.cmdPanel.classList.add('hidden'); syncPanelButtons(); });
els.cmdClear.addEventListener('click', clearCmdHistory);
els.cmdArchive.addEventListener('click', archiveAndView);
els.cmdRecordToggle.addEventListener('click', toggleCmdRecord);
// 会话录制与回放(合并到一个按钮 + 下拉菜单)
els.btnRec.addEventListener('click', toggleRecMenu);
els.recMenu.addEventListener('click', onRecMenuClick);
// 点菜单外任意处收起(和 AI 主机下拉同一个套路)
document.addEventListener('click', (e) => {
  if (!els.recMenu.contains(e.target) && !els.btnRec.contains(e.target)) els.recMenu.classList.add('hidden');
});
// 智能命令推荐下拉:点按钮展开/收起,点外面收起
els.btnRecommend.addEventListener('click', toggleRecommendMenu);
document.addEventListener('click', (e) => {
  if (!els.recommendMenu.contains(e.target) && !els.btnRecommend.contains(e.target)) els.recommendMenu.classList.add('hidden');
});
els.recordingsClose.addEventListener('click', closeRecordingsModal);
els.recordingsOpenDir.addEventListener('click', () => window.api.recOpenDir());
els.replayPlay.addEventListener('click', replayPlayPause);
els.replaySpeed.addEventListener('click', replaySpeed);
els.replayAllsync.addEventListener('click', replayShowAll);
els.replayClose.addEventListener('click', closeReplay);
els.replaySideToggle.addEventListener('click', closeReplaySide);
// 进度条拖拽:按住时暂停、松手恢复(避免播放循环和拖动打架)
els.replayProgress.addEventListener('pointerdown', () => {
  const p = replay;
  if (!p) return;
  p.dragging = true;
  p.wasPlaying = p.playing;
  pauseReplay();
});
els.replayProgress.addEventListener('input', (e) => {
  if (replay) seekReplay(Number(e.target.value));
});
els.replayProgress.addEventListener('pointerup', () => {
  const p = replay;
  if (!p) return;
  p.dragging = false;
  if (p.wasPlaying) playReplay();
});
els.aiSend.addEventListener('click', aiSend);
// AI 输入是多行 textarea:
//   回车发送(含输入法判断)、Shift+回车换行、↑↓ 调出历史提问
els.aiInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && isEnterSubmit(e)) { e.preventDefault(); aiSend(); return; }
  // 输入法组合中不拦截方向键(否则拼音选字会乱)
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (!aiSentHistory.length) return;
    if (aiHistoryIndex === -1) aiHistoryIndex = aiSentHistory.length;
    aiHistoryIndex = Math.max(0, aiHistoryIndex - 1);
    els.aiInput.value = aiSentHistory[aiHistoryIndex];
    els.aiInput.setSelectionRange(els.aiInput.value.length, els.aiInput.value.length);
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (aiHistoryIndex === -1) return;
    aiHistoryIndex++;
    if (aiHistoryIndex >= aiSentHistory.length) {
      aiHistoryIndex = -1;
      els.aiInput.value = ''; // 到末尾 → 清空
    } else {
      els.aiInput.value = aiSentHistory[aiHistoryIndex];
      els.aiInput.setSelectionRange(els.aiInput.value.length, els.aiInput.value.length);
    }
  }
});
// ⚙ 展开/收起模型配置
els.aiConfigToggle.addEventListener('click', () => {
  const show = els.aiConfig.classList.contains('hidden');
  els.aiConfig.classList.toggle('hidden', !show);
  if (show) {
    fillAiConfig();
    refreshSkillsList(); // 展开配置时顺带刷新技能列表
    refreshKbList();    // 知识库文档列表
    syncKbToggle();     // AI 对话检索开关
  }
});

// =====================================================================
// Agent Skill 技能库(参考 Chaterm):AI 面板配置区里的技能管理
// 列表(启停/编辑/删除)+ 新建/编辑表单 + 打开技能目录
// =====================================================================
let skillsEditingName = null; // 正在编辑的技能名(null = 新建)

async function refreshSkillsList() {
  let res;
  try { res = await window.api.skillsList(); } catch { res = null; }
  const box = els.skillsList;
  if (!res || !res.ok) { box.textContent = ''; box.appendChild(mkEmpty('加载失败')); return; }
  const list = res.skills || [];
  box.textContent = '';
  if (!list.length) {
    box.appendChild(mkEmpty('还没有技能。点「＋ 新建」创建,或让 AI 用 summarize_to_skill 把对话沉淀成技能。'));
    return;
  }
  for (const s of list) {
    const item = document.createElement('div');
    item.className = 'skill-item' + (s.enabled ? '' : ' disabled');
    // 启停开关
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'skill-item-toggle';
    toggle.checked = !!s.enabled;
    toggle.title = s.enabled ? '已启用(AI 的 AVAILABLE SKILLS 清单可见)' : '已停用';
    toggle.addEventListener('change', async () => {
      const r = await window.api.skillsSetEnabled(s.name, toggle.checked);
      if (r && r.ok) refreshSkillsList();
      else alert((r && r.error) || '操作失败');
    });
    // 名称 + 描述
    const info = document.createElement('div');
    info.className = 'skill-item-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'skill-item-name';
    nameEl.textContent = s.name;
    const descEl = document.createElement('div');
    descEl.className = 'skill-item-desc';
    descEl.textContent = s.description;
    info.append(nameEl, descEl);
    // 编辑 / 删除
    const actions = document.createElement('div');
    actions.className = 'skill-item-actions';
    const editBtn = document.createElement('button');
    editBtn.className = 'btn-mini'; editBtn.textContent = '✏️'; editBtn.title = '编辑技能';
    editBtn.addEventListener('click', () => openSkillsEditor(s));
    const delBtn = document.createElement('button');
    delBtn.className = 'btn-mini danger'; delBtn.textContent = '🗑'; delBtn.title = '删除技能';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`删除技能「${s.name}」?`)) return;
      const r = await window.api.skillsDelete(s.name);
      if (r && r.ok) refreshSkillsList();
      else alert((r && r.error) || '删除失败');
    });
    actions.append(editBtn, delBtn);
    item.append(toggle, info, actions);
    box.appendChild(item);
  }
}

function mkEmpty(text) {
  const div = document.createElement('div');
  div.className = 'skills-empty';
  div.textContent = text;
  return div;
}

function openSkillsEditor(skill) {
  skillsEditingName = skill ? skill.name : null;
  els.skillsEditName.value = skill ? skill.name : '';
  els.skillsEditName.disabled = !!skill; // 编辑态技能名不可改(避免产生孤儿目录)
  els.skillsEditDesc.value = skill ? skill.description : '';
  els.skillsEditContent.value = skill ? skill.content : '';
  els.skillsEditEnabled.checked = skill ? !!skill.enabled : true;
  els.skillsEditor.classList.remove('hidden');
  els.skillsEditName.focus();
}

els.skillsNew.addEventListener('click', () => openSkillsEditor(null));
els.skillsOpenFolder.addEventListener('click', () => window.api.skillsOpenFolder());
els.skillsEditCancel.addEventListener('click', () => els.skillsEditor.classList.add('hidden'));
els.skillsEditSave.addEventListener('click', async () => {
  const name = els.skillsEditName.value.trim();
  const description = els.skillsEditDesc.value.trim();
  const content = els.skillsEditContent.value.trim();
  if (!name) { alert('请填写技能名(小写字母/数字/连字符)'); return; }
  if (!description) { alert('请填写技能描述'); return; }
  if (!content) { alert('技能正文不能为空'); return; }
  const r = await window.api.skillsSave({ name, description, enabled: els.skillsEditEnabled.checked, content });
  if (r && r.ok) {
    els.skillsEditor.classList.add('hidden');
    refreshSkillsList();
    setStatus(`技能「${name}」已保存`, 'var(--green)');
  } else {
    alert((r && r.error) || '保存失败');
  }
});
els.skillsEditContent.addEventListener('keydown', (e) => {
  // Ctrl+Enter / Cmd+Enter 快捷保存
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); els.skillsEditSave.click(); }
});

// =====================================================================
// 用户知识库(参考 Chaterm):导入运维文档,AI 对话时检索相关片段参考
// =====================================================================
async function refreshKbList() {
  let res;
  try { res = await window.api.kbList(); } catch { res = null; }
  const box = els.kbList;
  box.textContent = '';
  if (!res || !res.ok) { box.appendChild(mkEmpty('加载失败')); return; }
  const docs = res.docs || [];
  if (!docs.length) {
    box.appendChild(mkEmpty('还没有文档。点「＋ 导入」加入运维手册,AI 对话时会参考。'));
    return;
  }
  for (const d of docs) {
    const item = document.createElement('div');
    item.className = 'skill-item';
    const info = document.createElement('div');
    info.className = 'skill-item-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'skill-item-name';
    nameEl.textContent = d.name;
    const descEl = document.createElement('div');
    descEl.className = 'skill-item-desc';
    descEl.textContent = `${formatSize(d.size)} · ${new Date(d.mtimeMs).toLocaleString()}`;
    info.append(nameEl, descEl);
    const actions = document.createElement('div');
    actions.className = 'skill-item-actions';
    const delBtn = document.createElement('button');
    delBtn.className = 'btn-mini danger';
    delBtn.textContent = '🗑';
    delBtn.title = '从知识库删除该文档';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`从知识库删除「${d.name}」?`)) return;
      const r = await window.api.kbRemove(d.name);
      if (r && r.ok) { refreshKbList(); setStatus(`已删除文档 ${d.name}`, 'var(--green)'); }
      else alert((r && r.error) || '删除失败');
    });
    actions.appendChild(delBtn);
    item.append(info, actions);
    box.appendChild(item);
  }
}

// 搜索预览(防抖 300ms):输入即检索,展示命中片段
let kbSearchTimer = null;
function onKbSearchInput() {
  clearTimeout(kbSearchTimer);
  kbSearchTimer = setTimeout(async () => {
    const q = els.kbSearch.value.trim();
    const box = els.kbResults;
    if (!q) { box.textContent = ''; return; }
    let results = [];
    try {
      const r = await window.api.kbSearch(q, 5);
      if (r && r.ok) results = r.results || [];
    } catch { /* ignore */ }
    if (!results.length) { box.textContent = '无匹配文档'; return; }
    box.textContent = '';
    for (const h of results) {
      const row = document.createElement('div');
      row.className = 'kb-hit';
      const name = document.createElement('div');
      name.className = 'kb-hit-name';
      name.textContent = `📄 ${h.name} (相关度 ${h.score})`;
      const snip = document.createElement('div');
      snip.className = 'kb-hit-snippet';
      snip.textContent = h.snippet || '(无片段)';
      row.append(name, snip);
      box.appendChild(row);
    }
  }, 300);
}

els.kbImport.addEventListener('click', async () => {
  const r = await window.api.kbPickImport();
  if (r && r.canceled) return;
  if (r && r.ok) { refreshKbList(); setStatus(`已导入文档: ${r.doc.name}`, 'var(--green)'); }
  else alert((r && r.error) || '导入失败');
});
els.kbOpenFolder.addEventListener('click', () => window.api.kbOpenFolder());
els.kbSearch.addEventListener('input', onKbSearchInput);
// AI 对话是否检索知识库(设置持久化,aiSend 时随请求带上)
els.kbAiToggle.addEventListener('change', () => {
  state.settings.kbEnabled = els.kbAiToggle.checked;
  saveSettings();
});
function syncKbToggle() {
  els.kbAiToggle.checked = state.settings.kbEnabled !== false;
}
els.btnSftpToggle.addEventListener('click', toggleSftpPanel);
// SFTP 连接切换下拉:点连接名弹出/收起,点外面收起
els.sftpConn.addEventListener('click', (e) => { e.stopPropagation(); toggleSftpConnMenu(); });
document.addEventListener('click', (e) => {
  if (!els.sftpConnMenu.contains(e.target) && !els.sftpConn.contains(e.target)) els.sftpConnMenu.classList.add('hidden');
});
els.btnSftpUp.addEventListener('click', sftpGoUp);
// 刷新目录:重新读当前目录(编辑保存/外部改动后看最新);顺便清掉过期选中
els.btnSftpRefresh.addEventListener('click', () => { loadSftpList(); setStatus('已刷新目录', 'var(--green)'); });
els.btnSftpMkdir.addEventListener('click', sftpMakeDir);
els.btnSftpUpload.addEventListener('click', sftpUpload);
els.btnSftpDownload.addEventListener('click', sftpDownload);
els.btnSftpDelete.addEventListener('click', sftpDeleteSelected);
els.btnSftpSelectAll.addEventListener('click', sftpToggleSelectAll);
els.btnSftpTransfersClear.addEventListener('click', clearSftpTransfers); // 清空传输历史(本次会话)
// SFTP 远程编辑
els.btnSftpEdit.addEventListener('click', editSelectedFile);
els.editSave.addEventListener('click', saveRemoteFile);
els.editCancel.addEventListener('click', closeEditor);
// 批量执行面板
els.btnBatch.addEventListener('click', toggleBatchPanel);
els.batchPanelClose.addEventListener('click', () => { els.batchPanel.classList.add('hidden'); syncPanelButtons(); refitAll(); });
els.batchRun.addEventListener('click', runBatchExec);
els.batchPanelClear.addEventListener('click', () => { els.batchResults.innerHTML = ''; });
els.batchCmd.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && isEnterSubmit(e)) { e.preventDefault(); runBatchExec(); }
});
// 快速命令
els.btnQuick.addEventListener('click', openQuickModal);
els.quickClose.addEventListener('click', closeQuickModal);
els.quickAddBtn.addEventListener('click', addQuickCommand);
els.quickCancelBtn.addEventListener('click', cancelEditQuick);
els.quickName.addEventListener('keydown', (e) => { if (isEnterSubmit(e)) { e.preventDefault(); addQuickCommand(); } });
els.quickCommand.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && isEnterSubmit(e)) { e.preventDefault(); addQuickCommand(); }
});
// SSH 隧道
els.btnTunnel.addEventListener('click', openTunnelModal);
els.tunnelClose.addEventListener('click', () => els.tunnelModal.classList.add('hidden'));
els.tunnelNew.addEventListener('click', toggleTunnelForm);
els.tunnelFormCancel.addEventListener('click', () => els.tunnelForm.classList.add('hidden'));
els.tunnelType.addEventListener('change', updateTunnelTypeFields);
els.tunnelCreate.addEventListener('click', createTunnel);
// 搜索输入防抖:停顿 80ms 才重渲染列表,避免每敲一个字母就全量重建(性能优化)
let sessionSearchTimer = null;
els.inputSessionSearch.addEventListener('input', () => {
  state.activeGroupId = null; // 搜索时全选回到"按搜索结果",清掉分组选中
  clearTimeout(sessionSearchTimer);
  sessionSearchTimer = setTimeout(() => renderSessionList(els.inputSessionSearch.value), 80);
});
els.btnSelectAllFiltered.addEventListener('click', toggleSelectAllFiltered);
// 搜索范围:下拉选择 全部/主机/堡垒机(只显示对应顶级分组)
els.scopeSelect.addEventListener('change', () => { state.searchScope = els.scopeSelect.value || 'all'; renderSessionList(els.inputSessionSearch.value); });
// 点会话列表"空白处"(容器本身,不是分组头/会话行)→ 取消分组选中,之后全选=所有分组的主机
els.sessionTree.addEventListener('click', (e) => {
  if (e.target === els.sessionTree && state.activeGroupId != null) {
    state.activeGroupId = null;
    renderSessionList(els.inputSessionSearch.value);
  }
});
// SFTP 面板是浏览操作区,不该抢键盘焦点:点击面板任意处(文件行/空白/工具栏非输入框)
// 后把焦点还给当前活跃终端。否则点一下文件行 → 焦点落 BODY → 回终端敲 Cmd+A/普通键全被吞。
// 例外:点击地址/搜索等 INPUT 时保留焦点(用户在输文字);按钮点击由各操作完成后再归还。
els.sftpPanel.addEventListener('mousedown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const sid = state.activeSessionId;
  const tab = sid ? state.tabs.get(sid) : null;
  if (tab && tab.term) {
    // 让浏览器先完成本次点击的默认聚焦,再归还终端(否则 mousedown 立即 focus 会打断按钮 click)
    setTimeout(() => { try { tab.term.focus(); } catch { /* ignore */ } }, 0);
  }
});
// 密码/私钥口令 显示/隐藏切换(点眼睛按钮)
function togglePwdEye(inputId, btnId) {
  const inp = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if (inp.type === 'password') { inp.type = 'text'; btn.textContent = '🙈'; btn.title = '隐藏'; }
  else { inp.type = 'password'; btn.textContent = '👁'; btn.title = '显示'; }
}
els.fPasswordToggle.addEventListener('click', () => togglePwdEye('f-password', 'f-password-toggle'));
els.fPassphraseToggle.addEventListener('click', () => togglePwdEye('f-passphrase', 'f-passphrase-toggle'));
els.fJumpPasswordToggle.addEventListener('click', () => togglePwdEye('f-jump-password', 'f-jump-password-toggle'));
// 弹窗回车即保存
for (const f of [els.fName, els.fHost, els.fPassword]) {
  f.addEventListener('keydown', (e) => { if (isEnterSubmit(e)) saveSession(); });
}

// =====================================================================
// 主进程事件:终端数据 / 连接状态
// =====================================================================
// ---- OS 系统识别(参考 Netcatty):连接成功后探测,结果给 AI 助手用 ----
async function detectOsForTab(t) {
  const res = await window.api.detectOs({
    host: t.session.host,
    port: t.session.port || 22,
    username: t.session.username,
    password: t.session.password,
  });
  if (!res || !res.ok) return;
  // 只把系统类型记在标签对象里(给 AI 助手用),不再往标签上画徽标
  t.os = res.name;
}

// 主进程日志 → 调试面板(MAIN/MAIN·错误 前缀;主进程启动、SSH 连接、异常等)
window.api.onMainLog((level, msg) => dlog(level === 'error' ? 'MAIN·错误' : 'MAIN', msg));

// ---- 字符集自动探测:连接后发 OSC-0(标题)探针取服务器 $LANG,自动切编码 ----
// 只在会话是默认 utf8(用户没手动指定编码)时探测;SSH 会话才探(Telnet 网络设备多无 $LANG)。
// 探针输出经 OSC 标题携带,终端里不可见,回显只有一行 printf 命令(探测完成后清掉)。
function startEncodingProbe(t) {
  if (!t || !t.session || t.encProbe) return;
  if ((t.session.protocol || 'ssh') === 'telnet') return;
  if (t.session.encoding && t.session.encoding !== 'utf8') return; // 用户手动指定了编码,尊重
  t.encProbe = { buf: '', done: false };
  window.api.sshWrite(t.sessionId, `printf ']0;POLARISENC:%s' "\${LC_ALL:-\$LANG}"\r`);
  // 3s 兜底:探针没回音就放弃(服务器无 printf/shell 异常),不卡会话
  setTimeout(() => { if (t.encProbe && !t.encProbe.done) { t.encProbe.done = true; t.encProbe = null; } }, 3000);
}

// 服务器 locale(LANG/LC_ALL)→ 会话编码
function langToEncoding(lang) {
  const l = (lang || '').toLowerCase();
  if (!l) return 'utf8';
  if (l.includes('gb18030')) return 'gb18030';
  if (l.includes('gbk') || l.includes('gb2312') || l.includes('936')) return 'gbk';
  if (l.includes('big5') || l.includes('950')) return 'big5';
  if (l.includes('latin1') || l.includes('iso-8859-1')) return 'latin1';
  return 'utf8'; // utf8/C/POSIX/未知 → 默认 utf8(安全)
}

window.api.onSshData((sessionId, data) => {
  const t = state.tabs.get(sessionId);
  if (!t) return;
  // ---- 字符集自动探测:扫探针 OSC,拿到 locale 后切编码并清掉回显的探测命令 ----
  if (t.encProbe && !t.encProbe.done) {
    try {
      if (!t.encProbeDec) t.encProbeDec = new TextDecoder();
      const piece = typeof data === 'string' ? data : t.encProbeDec.decode(new Uint8Array(data), { stream: true });
      t.encProbe.buf = (t.encProbe.buf + piece).slice(-200);
      // 回显里是 POLARISENC:%s(以 % 开头,不匹配),探针输出才是真实 locale
      const m = t.encProbe.buf.match(/POLARISENC:([a-zA-Z_][a-zA-Z0-9_@.\-]*)/);
      if (m) {
        t.encProbe.done = true;
        const enc = langToEncoding(m[1]);
        t.encProbe = null;
        if (enc !== 'utf8') window.api.sshSetEncoding(t.sessionId, enc);
        // 等当前数据块写完后再清掉回显的 printf 行(上移一行清除,回到提示符行)
        setTimeout(() => { try { if (t.term && !t.term.isDisposed) t.term.write('\x1b[1A\x1b[2K\x1b[1B'); } catch { /* ignore */ } }, 60);
      }
    } catch { /* ignore */ }
  }
  // 接收数据只在面板打开时记(否则滚屏日志会瞬间刷爆环形缓冲,挤掉按键/焦点这些关键记录)
  if (els.debugPanel && !els.debugPanel.classList.contains('hidden')) {
    if (typeof data === 'string') dlog('RECV', `${sessionId} +${data.length}B ${JSON.stringify(data.slice(0, 60))}${data.length > 60 ? '…' : ''}`);
    else dlog('RECV', `${sessionId} +${data.length}B [${Array.from(data.slice(0, 12)).map((b) => b.toString(16).padStart(2, '0')).join(' ')}${data.length > 12 ? ' …' : ''}]`);
  }
  // ---- 自动填充密码:终端出现 Password:/password: 提示时,发送该会话保存的密码 ----
  // 只对 SSH 会话启用(Telnet 的 login:/password: 自动登录已在主进程处理,避免重复发密码);
  // 密码只发送、绝不写入调试日志/命令记录。
  if ((t.session.protocol || 'ssh') !== 'telnet' && t.session && t.session.password &&
      state.settings.autoFillPassword !== false) {
    const raw = typeof data === 'string' ? data : (t.autoPwDec || (t.autoPwDec = new TextDecoder())).decode(new Uint8Array(data), { stream: true });
    if (raw) {
      // 剥 ANSI 转义(颜色/光标)+ 回车,避免打断"以 password: 结尾"的匹配
      t.autoPwBuf = ((t.autoPwBuf || '') + raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '')).slice(-120);
      const promptEnd = /(?:^|[^\w])(?:[Pp]assword|[Pp]asswd)\s*(?:for\s+\S+)?\s*[:：]\s*$/.test(t.autoPwBuf);
      if (promptEnd && !t.autoPwSent) {
        t.autoPwSent = true; // 同一提示分块到达时只发一次
        dlog('AUTOFILL', `${sessionId} 检测到密码提示,自动发送(长度 ${t.session.password.length},不记明文)`);
        window.api.sshWrite(sessionId, t.session.password + '\r');
      } else if (!promptEnd) {
        t.autoPwSent = false; // 提示后收到其它输出(密码被接受/命令结果)→ 武装好等下一次提示
      }
    }
  }
  if (typeof data === 'string') {
    // 主进程已把 GBK/GB2312 转成 UTF-8 字符串
    let out = data;
    if (state.settings.highlight) out = highlightString(out);
    t.term.write(filterWrite(out));
  } else {
    // UTF-8 原始字节:统一走 t.decoder 流式解码(与 highlightText 同一解码器,流状态一致)→ 高亮 → 过滤
    let out = t.decoder.decode(new Uint8Array(data), { stream: true });
    if (state.settings.highlight) out = highlightString(out);
    t.term.write(filterWrite(out));
  }
});

// ---- 终端输出过滤(工具栏 🔍 框) ----
let outputFilterKw = ''; // 全局过滤关键词(空=不过滤)
// 支持多个预设条件:逗号/空格分隔,行包含其中任意一个即常亮。
// 用"变暗"而非"隐藏":隐藏会滤掉提示符/程序控制序列,交互式终端会错乱;变暗同样突出重点且不破坏终端。
function filterWrite(text) {
  if (!outputFilterKw) return text;
  const kws = outputFilterKw.split(/[,，\s]+/).map((s) => s.toLowerCase()).filter(Boolean);
  if (!kws.length) return text;
  const parts = String(text).split('\n');
  const last = parts.pop(); // 最后一段可能未完成(提示符/半行),原样通过,不延迟显示
  const filtered = parts.map((line) => {
    if (!line) return line;
    const plain = line.replace(/\x1b\[[0-9;]*m/g, '').toLowerCase(); // 去 ANSI 后判断
    return kws.some((k) => plain.includes(k)) ? line : '\x1b[2m' + line + '\x1b[0m';
  }).join('\n');
  return filtered + (filtered && last ? '\n' : '') + last;
}

// ---------- SFTP 传输进度(Xshell 式:每个文件一行+独立进度条) ----------
// 完成的行留在列表里当"本次会话的传输历史",可单条删除/一键清空;只存在内存里,关 app 即自动清除。
const sftpTransfer = { rows: new Map(), active: new Set() }; // path → { el, fill, meta, setLocal }; active = 当前批次里出现过的文件
function makeSftpTransferRow(p) {
  const el = document.createElement('div');
  el.className = 'sftp-transfer-row active';
  // 第一行:方向 / 远程名 / 进度条 / 进度 / 删除
  const main = document.createElement('div'); main.className = 'st-main';
  const dir = document.createElement('span'); dir.className = 'st-dir'; dir.textContent = p.op === 'upload' ? '⬆' : '⬇';
  const name = document.createElement('span'); name.className = 'st-name'; name.textContent = p.file.split('/').filter(Boolean).pop() || p.file; name.title = p.file;
  const track = document.createElement('div'); track.className = 'st-track';
  const fill = document.createElement('div'); fill.className = 'st-fill';
  track.appendChild(fill);
  const meta = document.createElement('span'); meta.className = 'st-meta'; meta.textContent = '0B';
  const del = document.createElement('button'); del.className = 'st-del'; del.title = '删除这条传输记录'; del.textContent = '×';
  del.addEventListener('click', () => { sftpTransfer.rows.delete(p.file); el.remove(); });
  main.append(dir, name, track, meta, del);
  // 第二行:本地保存路径 + 「📂 打开所在文件夹」(仅下载完成后盖上去,上传不显示)
  const localRow = document.createElement('div'); localRow.className = 'st-local-row hidden';
  const open = document.createElement('button'); open.className = 'st-open'; open.title = '在文件管理器中显示'; open.textContent = '📂';
  const local = document.createElement('span'); local.className = 'st-local'; local.textContent = ''; local.title = '';
  let _localPath = '';
  open.addEventListener('click', () => { if (_localPath) window.api.revealInFolder(_localPath); });
  localRow.append(open, local);
  el.append(main, localRow);
  const setLocal = (lp) => {
    _localPath = lp;
    local.textContent = lp;
    local.title = lp;
    localRow.classList.remove('hidden');
  };
  return { el, fill, meta, setLocal };
}
window.api.onSftpProgress((p) => {
  if (!p || !els.sftpProgress) return;
  const list = document.getElementById('sftp-transfers-list');
  if (!list) return;
  els.sftpProgress.classList.remove('hidden');
  let row = sftpTransfer.rows.get(p.file);
  if (!row) { row = makeSftpTransferRow(p); sftpTransfer.rows.set(p.file, row); list.prepend(row.el); } // 新的在最上面
  sftpTransfer.active.add(p.file);
  const fpct = p.fileTotal > 0 ? Math.min(100, Math.round((p.fileDone / p.fileTotal) * 100)) : 100;
  row.fill.style.width = fpct + '%';
  row.meta.textContent = `${formatSize(p.fileDone)}/${formatSize(p.fileTotal)} · ${fpct}%`;
  const bpct = p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 100;
  const dir = p.op === 'upload' ? '⬆ 上传' : '⬇ 下载';
  els.sftpProgressLabel.textContent = `${dir} ${p.filesDone}/${p.filesTotal} 个文件 · ${bpct}%`;
});
// 批次结束:把当前批次的行从"进行中"标成 完成/失败/已取消(行保留在历史里)
function sftpTransferFinish(failedPaths, cancelled) {
  for (const path of sftpTransfer.active) {
    const row = sftpTransfer.rows.get(path);
    if (!row) continue;
    row.el.classList.remove('active');
    if (cancelled) { row.el.classList.add('fail'); row.meta.textContent = '已取消'; }
    else if (failedPaths && failedPaths.has(path)) { row.el.classList.add('fail'); row.meta.textContent = '✗ 失败'; }
    else { row.el.classList.add('done'); row.meta.textContent = (row.meta.textContent || '') + ' ✓'; }
  }
  sftpTransfer.active.clear();
}
function clearSftpTransfers() {
  sftpTransfer.rows.clear();
  sftpTransfer.active.clear();
  const list = document.getElementById('sftp-transfers-list');
  if (list) list.innerHTML = '';
  if (els.sftpProgress) els.sftpProgress.classList.add('hidden');
}

window.api.onSshStatus((sessionId, status) => {
  const t = state.tabs.get(sessionId);
  if (!t) return;
  dlog('STATUS', `${sessionId} ${status.status}${status.error ? ' ' + status.error : ''}`);
  const dot = t.el.querySelector('.tab-status-dot');
  if (status.status === 'connected') {
    setTabStatus(sessionId, 'connected');
    t.manualDisconnect = false; // 已重新连接上,清掉手动断开标记
    // 连接成功 → 延迟 15s 清零重连计数:只有连接稳定才证明真的连上了。
    // 若"握手成功→立刻被服务端关闭"(瞬连瞬断),计数不归零 → MAX_RECONNECT 正常触发,
    // 否则每轮 connected 都清零,自动重连死循环(日志:每3秒连一次永不停)。
    clearTimeout(t.reconnectClearTimer);
    t.reconnectClearTimer = setTimeout(() => { t.reconnectAttempts = 0; }, 15000);
    t.autoPwBuf = ''; t.autoPwSent = false; // 重置自动填充密码状态,迎接新会话的提示
    if (t.reconnectTimer) { clearTimeout(t.reconnectTimer); t.reconnectTimer = null; }
    if (dot) dot.title = '已连接';
    setStatus(`已连接: ${t.title}`, 'var(--green)');
    detectOsForTab(t); // 探测系统类型(结果给 AI 助手用,标签上不显示徽标)
    startEncodingProbe(t); // 自动探测服务器字符集(仅默认 utf8 的 SSH 会话)
    updateAiHostList(); // AI 主机选择器刷新
    // 登录宏:连接成功后逐条发送会话里配置的 on_connect 命令(每行一条)
    if (t.session && t.session.on_connect) {
      const cmds = t.session.on_connect.split('\n').map((l) => l.trim()).filter(Boolean);
      cmds.forEach((cmd, i) => {
        setTimeout(() => {
          const tt = state.tabs.get(sessionId);
          if (tt && tt.status === 'connected') window.api.sshWrite(sessionId, cmd + '\r');
        }, 400 + i * 600);
      });
    }
  } else if (status.status === 'closed') {
    setTabStatus(sessionId, 'closed');
    t.term.write('\r\n\x1b[31m[连接已断开]\x1b[0m\r\n');
    setStatus('连接已断开', 'var(--red)');
    state.recording.delete(sessionId); // 断线 → 录制被主进程收尾,这里清本地标记
    updateRecordBtn();
    // 非用户主动关闭、非手动断开 → 自动重连
    if (!t.userClosed && !t.manualDisconnect && t.session) scheduleReconnect(t);
  } else if (status.status === 'error') {
    setTabStatus(sessionId, 'closed');
    t.term.write(`\r\n\x1b[31m[连接错误] ${status.error}\x1b[0m\r\n`);
    setStatus('连接错误', 'var(--red)');
    // 堡垒机直连会话(H3C token 解析出的 SSH 代理)连接失败 → 记入诊断包,定位"无法连接"根因
    if (t.session && t.session.bastionKey) bastionLog({ ev: 'ssh-error', sessionId, bastionKey: t.session.bastionKey, host: t.session.host, port: t.session.port, account: t.session.username, error: status.error });
    state.recording.delete(sessionId);
    updateRecordBtn();
    if (!t.userClosed && !t.manualDisconnect && t.session) scheduleReconnect(t);
  }
});

// =====================================================================
// keyboard-interactive 认证弹窗(域认证 / 双密码 / OTP 挑战)
// =====================================================================
// keyboard-interactive 认证:多个会话可能同时发起挑战(如批量连接域认证主机)。
// 用 Map<sessionId, {id}> 排队,弹窗一次只处理队首;应答/关标签后自动切下一个。
// 旧版用单例 kbdWaiter:后到的挑战覆盖先到,先到连接永久挂起。
const kbdWaiters = new Map();
function kbdShowNext() {
  const w = kbdWaiters.values().next().value;
  if (!w) { els.kbdModal.classList.add('hidden'); return; }
  els.kbdDesc.textContent = w.desc;
  els.kbdFields.innerHTML = '';
  for (const p of w.prompts || []) {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    const span = document.createElement('span');
    span.textContent = (p.prompt || '').trim() || `第 ${w.prompts.indexOf(p) + 1} 项验证信息`;
    const input = document.createElement('input');
    input.type = p.echo ? 'text' : 'password'; // echo=false → 密码框
    input.autocomplete = 'off';
    input.placeholder = p.echo ? '输入内容' : '输入密码';
    wrap.appendChild(span);
    wrap.appendChild(input);
    els.kbdFields.appendChild(wrap);
  }
  els.kbdModal.classList.remove('hidden');
  const first = els.kbdFields.querySelector('input');
  if (first) first.focus();
}
window.api.onSshKbd((sessionId, data) => {
  const t = state.tabs.get(sessionId);
  if (!t) { window.api.sshKbdRespond(data.id, [], true); return; } // 标签已关:直接取消挑战
  const desc = (data.instructions || '').trim() || (data.name || '服务器要求额外的验证信息');
  kbdWaiters.set(sessionId, { id: data.id, sessionId, desc, prompts: data.prompts || [] });
  if (els.kbdModal.classList.contains('hidden')) kbdShowNext(); // 弹窗空闲才显示;忙则排队
});
function kbdSubmit(cancelled) {
  const w = kbdWaiters.values().next().value;
  if (!w) return;
  kbdWaiters.delete(w.sessionId);
  const answers = cancelled ? [] : [...els.kbdFields.querySelectorAll('input')].map((i) => i.value);
  window.api.sshKbdRespond(w.id, answers, cancelled);
  kbdShowNext(); // 显示队列里下一个(没有则关弹窗)
}
// 关闭标签/断开时,取消该会话挂起的认证挑战(否则主进程侧一直等应答直到超时)
function kbdCancelSession(sessionId) {
  const w = kbdWaiters.get(sessionId);
  if (w) {
    kbdWaiters.delete(sessionId);
    window.api.sshKbdRespond(w.id, [], true);
  }
  if (kbdWaiters.size === 0) els.kbdModal.classList.add('hidden');
  else kbdShowNext();
}
els.kbdOk.addEventListener('click', () => kbdSubmit(false));
els.kbdCancel.addEventListener('click', () => kbdSubmit(true));
// 回车提交;取消时保持关闭(注意 isComposing:输入法选字回车不应提交)
els.kbdFields.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); kbdSubmit(false); }
});

// =====================================================================
// ⌘K 命令面板:输入即达(动作 / 会话),VS Code / Linear 风格
// =====================================================================
const COMMANDS = [
  { name: '使用说明', hint: '📖', run: () => openHelp() },
  { name: '新建会话', hint: '⌘N', run: () => openSessionModal(null) },
  { name: '快捷连接', hint: '', run: () => toggleQuickConnect() },
  { name: '新建分组', hint: '', run: () => newGroup() },
  { name: '连接/断开选中会话', hint: '⌘Enter', run: () => toggleConnectDisconnect() },
  { name: '广播模式', hint: '', run: () => toggleBroadcast() },
  { name: '分屏-垂直', hint: '', run: () => splitActivePane('v') },
  { name: '分屏-横向', hint: '', run: () => splitActivePane('h') },
  { name: 'SFTP 面板', hint: '⌘⇧S', run: () => toggleSftpPanel() },
  { name: 'SSH 隧道', hint: '⌘⇧T', run: () => openTunnelModal() },
  { name: '批量执行', hint: '⌘⇧B', run: () => toggleBatchPanel() },
  { name: '快速命令', hint: '', run: () => openQuickModal() },
  { name: '命令记录', hint: '⌘⇧M', run: () => toggleCmdPanel() },
  { name: '命令推荐', hint: '', run: () => toggleRecommendMenu() },
  { name: '录制/回放', hint: '', run: () => toggleRecMenu() },
  { name: '输出过滤', hint: '⌘⇧F', run: () => openFilterModal() },
  { name: '锁定', hint: '⌘L', run: () => requestLock() },
  { name: '设置', hint: '⌘,', run: () => openSettingsModal() },
  { name: '调试面板', hint: '⌘⇧D', run: () => toggleDebugPanel() },
  { name: 'AI 助手', hint: '⌘⇧A', run: () => toggleAiPanel() },
  { name: '端口探测', hint: '', run: () => openProbeModal() },
  { name: '导入主机', hint: '', run: () => openImportModal() },
  { name: '导出会话', hint: '', run: () => exportSessions() },
  { name: '堡垒机面板', hint: '', run: () => openBastionPanel() },
  { name: 'JumpServer 资产', hint: '', run: () => openJmsModal() },
  { name: '折叠会话列表', hint: '⌘⇧P', run: () => toggleSessionPanel() },
  { name: '视图-网格', hint: '', run: () => setSessionView('grid') },
  { name: '视图-列表', hint: '', run: () => setSessionView('list') },
  { name: '视图-树形', hint: '', run: () => setSessionView('tree') },
  { name: '清空命令记录', hint: '', run: () => clearCmdHistory() },
  { name: '打开会话日志目录', hint: '', run: () => window.api.logOpenDir() },
];
let paletteItems = []; // [{ el, run }]
function openPalette() {
  els.paletteInput.value = '';
  renderPalette('');
  els.palette.classList.remove('hidden');
  els.paletteInput.focus();
}
function closePalette() {
  els.palette.classList.add('hidden');
  // 焦点还给当前活跃终端
  const t = state.activeSessionId ? state.tabs.get(state.activeSessionId) : null;
  if (t && t.term) { try { t.term.focus(); } catch { /* ignore */ } }
}
function renderPalette(q) {
  const box = els.paletteResults;
  box.innerHTML = '';
  paletteItems = [];
  const text = (q || '').trim().toLowerCase();
  // 动作:名字/快捷键提示 子串匹配
  const cmds = COMMANDS.filter((c) => !text || c.name.toLowerCase().includes(text) || (c.hint || '').toLowerCase().includes(text));
  // 会话:空格分词,名字/主机/用户名/分组 全匹配(不耦合搜索框 scope)
  const words = text.split(/\s+/).filter(Boolean);
  const sessions = (state.sessions || []).filter((s) => {
    const hay = `${s.name || ''} ${s.host || ''} ${s.username || ''} ${s.group_name || ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  }).slice(0, 20);
  if (!cmds.length && !sessions.length) {
    box.innerHTML = '<div class="palette-empty">没有匹配的命令或会话</div>';
    return;
  }
  const add = (el, run) => { el.addEventListener('click', () => run()); paletteItems.push({ el, run }); box.appendChild(el); };
  for (const c of cmds) {
    const el = document.createElement('div');
    el.className = 'palette-item';
    el.innerHTML = `<span class="pi-name">${escHtml(c.name)}</span>${c.hint ? `<span class="pi-hint">${c.hint}</span>` : ''}`;
    add(el, c.run);
  }
  for (const s of sessions) {
    const open = !!findTabBySessionId(s.id);
    const el = document.createElement('div');
    el.className = 'palette-item';
    el.innerHTML = `<span class="pi-name">${escHtml(s.name)} · ${escHtml(s.host)}${s.username ? ' · ' + escHtml(s.username) : ''}${s.group_name ? ' · ' + escHtml(s.group_name) : ''}</span>${open ? '<span class="pi-connected">已连接</span>' : ''}`;
    add(el, () => { if (open) activateTab(findTabBySessionId(s.id)); else connectToServer(s); });
  }
  if (paletteItems.length) paletteItems[0].el.classList.add('selected');
}
function paletteMove(dir) {
  if (!paletteItems.length) return;
  const idx = paletteItems.findIndex((p) => p.el.classList.contains('selected'));
  const next = (idx + dir + paletteItems.length) % paletteItems.length;
  if (idx >= 0) paletteItems[idx].el.classList.remove('selected');
  paletteItems[next].el.classList.add('selected');
  paletteItems[next].el.scrollIntoView({ block: 'nearest' });
}
function paletteRun() {
  const sel = paletteItems.find((p) => p.el.classList.contains('selected'));
  if (sel) { closePalette(); sel.run(); }
}
els.paletteInput.addEventListener('input', () => renderPalette(els.paletteInput.value));
els.paletteInput.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); paletteMove(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); paletteMove(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); paletteRun(); }
  else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
});
els.palette.addEventListener('mousedown', (e) => { if (e.target === els.palette) closePalette(); });

// ---------- 使用说明弹窗 ----------
function openHelp() {
  els.helpModal.classList.remove('hidden');
  closeSettingsModal(); // 从设置弹窗进来时,顺手关掉设置,避免叠弹窗
}
function closeHelp() { els.helpModal.classList.add('hidden'); }
els.btnHelp.addEventListener('click', openHelp);
els.helpCloseX.addEventListener('click', closeHelp);
els.helpClose.addEventListener('click', closeHelp);
els.helpModal.addEventListener('mousedown', (e) => { if (e.target === els.helpModal) closeHelp(); });
els.helpModal.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeHelp(); });

// =====================================================================
// 启动:加载设置 + 会话列表
// =====================================================================
// 全局错误兜底:xterm 内部偶发异步报错,不打断 UI(记录但不影响使用)
window.addEventListener('error', (e) => console.warn('[渲染层]', e.message));

loadSettings();
computeOutputFilter(); // 启动时按持久化的过滤条件恢复生效关键词
resetIdleLock(); // 启动即开始闲置自动锁定计时
jmsRestore(); // 启动恢复 JumpServer 登录(静默重登已登录过的服务器;localStorage 丢失时回退 jms-servers.json 文件备份)
// 恢复堡垒机 web 标签页:保存过 bastionUrl(说明上次用了 web 堡垒机)→ 自动打开面板并加载。
// 用 setTimeout 而非 jmsRestore().then,避免重登未完成/抛异常时恢复被跳过。
setTimeout(() => { try { if (state.settings.bastionUrl) restoreBastion(); } catch { /* ignore */ } }, 600);
updateConnectBtn(); // 初始化"连接/中断"二合一按钮状态
applyTheme();
// auto 主题:系统明暗切换时即时跟随(仅 auto 模式下重应用,其他主题不受影响)
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (state.settings.theme === 'auto') applyTheme();
});
applyPanelCollapsed();
syncViewButtons();
fillVendorSelect(); // 填充 AI 厂商下拉框(启动时刷一次)
fillAiConfig();     // 把当前厂商配置填进 ⚙ 面板
updateCmdRecordBtn(); // 命令记录开关按钮状态
updateRecordBtn();    // 会话录制按钮状态(初始=未录制)
syncPanelButtons();   // 面板开关按钮激活态
// ---- 解锁后科幻开机过场(仅正式版 ?boot=1 播放;点击/按键可跳过) ----
// 简洁版:只保留一个能量环边框(去掉了数字雨/扫描线/logo/状态行),~1s 后淡出揭开主界面
(function bootIntro() {
  if (new URLSearchParams(location.search).get('boot') !== '1') return;
  const ov = document.getElementById('boot-overlay');
  if (!ov) return;
  // 过场动画设置:'full'完整1.6s | 'short'缩短0.7s | 'skip'跳过(设置 → 外观 → 启动过场动画)
  const mode = state.settings.bootIntro || 'short';
  if (mode === 'skip') {
    ov.remove();
    dlog('BOOT', `过场动画:设置已跳过 +${Math.round(performance.now() - __bootT0)}ms`);
    return;
  }
  const IS_FULL = mode === 'full';
  const PAUSE = IS_FULL ? 1100 : 700;      // 边框展示时长
  const FALLBACK = IS_FULL ? 1600 : 900;   // 兜底总时长
  ov.classList.remove('hidden'); // 揭开过场(正式版;dev 测试不播,overlay 保持 hidden 不挡界面)

  let done = false;
  function skip() {
    if (done) return;
    done = true;
    ov.classList.add('boot-done');
    dlog('BOOT', `过场动画结束(点击/按键可跳过) +${Math.round(performance.now() - __bootT0)}ms`);
    setTimeout(() => ov.remove(), 500);
  }
  ov.addEventListener('click', skip);
  window.addEventListener('keydown', skip, { once: true });
  setTimeout(skip, PAUSE);
  setTimeout(skip, FALLBACK); // 兜底:到点必结束
})();
loadCmdHistory();   // 加载持久化的命令记录
loadRecent();       // 加载最近连接
dlog('BOOT', `脚本初始化完成(设置/最近/命令已加载) +${Math.round(performance.now() - __bootT0)}ms`);
// 终端字体(如 SF Mono)加载完后再重适配一次,避免字体未就绪时算错行高、终端只占一半
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { refitAll(); packToolbar(); dlog('BOOT', `字体就绪,终端重排完成 +${Math.round(performance.now() - __bootT0)}ms`); });
packToolbar(); // 初始按当前窗口宽度算好工具栏间距(字体就绪后再算一次)
loadSessions();
updateTerminalVisibility();
setStatus('就绪');
dlog('BOOT', `主界面就绪(会话列表渲染完成) +${Math.round(performance.now() - __bootT0)}ms`);
