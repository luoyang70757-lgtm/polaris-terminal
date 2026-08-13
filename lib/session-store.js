'use strict';
/**
 * session-store.js — 用 SQLite 保存 SSH 会话配置(服务器列表)
 *
 * SQLite 是什么?
 *   - 一个"嵌入式数据库":数据存成单个文件,不需要单独安装数据库服务器
 *   - Node.js 22.5+ 内置了 node:sqlite 模块,所以本项目零额外依赖
 *
 * 会话 = 一条"服务器连接配置",存这些字段:
 *   name     给这台服务器起的名字(如 "我的网站服务器")
 *   host     IP 或域名
 *   port     SSH 端口(默认 22)
 *   username 登录用户名
 *   password 密码(教学先明文存;真实产品要用系统钥匙串加密,后面讲)
 *   group    分组(以后可以按组管理,现在先放默认分组)
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * 创建会话存储
 * @param {string} dbPath — .db 文件路径(不传就用 ~/.jms-terminal/sessions.db)
 * @returns 一组增删改查函数
 */
function createStore(initialBytes) {
  // 数据库改为全内存运行(配合 App 密码锁:启动时解密 data.bin → deserialize,
  // 每次变更 serialize() → 加密 → 落盘)。不再直接读写磁盘明文库。
  // 1. 打开内存库(不存在会自动创建空库)
  const db = new DatabaseSync(':memory:');
  if (initialBytes) {
    try { db.deserialize(initialBytes); } catch (err) {
      throw new Error('数据库解密/解析失败: ' + err.message);
    }
  }

  // 2. 建表(IF NOT EXISTS = 已存在则跳过,重复启动不报错)
  //    分组表:每个分组像一个文件夹;parent_id 预留以后支持"分组套分组"
  db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      parent_id  INTEGER DEFAULT NULL,
      is_prod    INTEGER DEFAULT 0,                  -- 1=生产环境分组(红色高亮+危险命令确认)
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增主键
      name        TEXT NOT NULL,                      -- 会话名(必填)
      host        TEXT NOT NULL,                      -- 服务器地址(必填)
      port        INTEGER DEFAULT 22,                 -- SSH 端口
      username    TEXT NOT NULL,                      -- 登录用户(必填;telnet 时可空,自动登录用)
      password    TEXT DEFAULT '',                    -- 密码
      private_key TEXT DEFAULT '',                    -- 私钥文件路径(密钥认证用)
      passphrase  TEXT DEFAULT '',                    -- 私钥口令
      encoding    TEXT DEFAULT 'utf8',                -- 终端编码: utf8 / gbk / gb2312
      protocol    TEXT DEFAULT 'ssh',                 -- 连接协议: ssh / telnet
      group_id    INTEGER DEFAULT NULL,               -- 所属分组(groups.id)
      created_at  TEXT DEFAULT (datetime('now')),     -- 创建时间(自动填)
      updated_at  TEXT DEFAULT (datetime('now'))      -- 更新时间(自动填)
    )
  `);

  // ---- 迁移:老库补新列(加列是幂等的,已存在就跳过)----
  const ensureCol = (table, col, sql) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${sql}`);
  };
  // 注意:SQLite 的 ALTER TABLE ADD COLUMN 只允许常量默认值,
  // 所以只补"真正新增"的列(created_at/updated_at 等老库一直有,不用补)。
  ensureCol('sessions', 'group_id', 'group_id INTEGER DEFAULT NULL');
  ensureCol('sessions', 'private_key', "private_key TEXT DEFAULT ''");
  ensureCol('sessions', 'passphrase', "passphrase TEXT DEFAULT ''");
  ensureCol('sessions', 'encoding', "encoding TEXT DEFAULT 'utf8'");
  ensureCol('sessions', 'tag_color', "tag_color TEXT DEFAULT ''"); // 标签颜色标记:'' 无 / red green yellow blue
  ensureCol('sessions', 'on_connect', "on_connect TEXT DEFAULT ''"); // 登录宏:连接后自动发送的命令
  ensureCol('sessions', 'jump', "jump TEXT DEFAULT ''"); // 跳板机(SSH 代理):JSON 字符串,见 main.js packJump
  ensureCol('sessions', 'protocol', "protocol TEXT DEFAULT 'ssh'"); // 连接协议: ssh / telnet
  ensureCol('groups', 'is_prod', 'is_prod INTEGER DEFAULT 0');

  // 老库的 sessions 用 group_name 文本列,转成 groups 表 + group_id
  const sessionCols = db.prepare('PRAGMA table_info(sessions)').all();
  const stmtGroupByName = db.prepare('SELECT id FROM groups WHERE name = ?');
  if (!stmtGroupByName.get('默认分组')) {
    db.prepare('INSERT INTO groups (name) VALUES (?)').run('默认分组');
  }
  // 归一化:把"没有分组(group_id 为空)或分组已删除(孤儿)"的会话一律归到"默认分组"。
  // 这样不再存在"未分组"状态,所有连接都挂在某个真实分组下。
  {
    let def = stmtGroupByName.get('默认分组');
    if (!def) {
      db.prepare('INSERT INTO groups (name, parent_id) VALUES (?, ?)').run('默认分组', null);
      def = stmtGroupByName.get('默认分组');
    }
    db.prepare('UPDATE sessions SET group_id = ? WHERE group_id IS NULL OR group_id NOT IN (SELECT id FROM groups)').run(def.id);
  }
  // 老数据:把 group_name 文本转成对应的 group_id
  // 注意:只处理"还没分组"(group_id IS NULL)的会话 —— 否则每次启动都会用
  // 过期的 group_name 覆盖用户手动设好的分组,把主机全挪回"默认分组"。
  if (sessionCols.some((c) => c.name === 'group_name')) {
    const stmtInsertGroup = db.prepare('INSERT INTO groups (name) VALUES (?)');
    const stmtSetGroup = db.prepare('UPDATE sessions SET group_id = ? WHERE id = ?');
    for (const r of db.prepare('SELECT id, group_name FROM sessions WHERE group_id IS NULL').all()) {
      const gname = r.group_name || '默认分组';
      let g = stmtGroupByName.get(gname);
      if (!g) { stmtInsertGroup.run(gname); g = stmtGroupByName.get(gname); }
      stmtSetGroup.run(g.id, r.id);
    }
  }
  // 迁移完就把过时的 group_name 列删掉,以后彻底不再走这条迁移(防止再覆盖分组)
  if (sessionCols.some((c) => c.name === 'group_name')) {
    try { db.exec('ALTER TABLE sessions DROP COLUMN group_name'); } catch { /* 不支持则忽略,有 IS NULL 守卫兜底 */ }
  }

  // ---- 4. 准备 SQL 语句(预编译,比直接拼字符串安全,防注入) ----
  const stmtList = db.prepare(`
    SELECT s.*, g.name AS group_name
    FROM sessions s LEFT JOIN groups g ON s.group_id = g.id
    ORDER BY g.name, s.name
  `);
  const stmtGet = db.prepare('SELECT * FROM sessions WHERE id = ?');
  const stmtInsert = db.prepare(`
    INSERT INTO sessions (name, host, port, username, password, private_key, passphrase, encoding, protocol, group_id, tag_color, on_connect, jump)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtUpdate = db.prepare(`
    UPDATE sessions
    SET name = ?, host = ?, port = ?, username = ?, password = ?,
        private_key = ?, passphrase = ?, encoding = ?, protocol = ?, group_id = ?, tag_color = ?,
        on_connect = ?, jump = ?, updated_at = datetime('now')
    WHERE id = ?
  `);
  const stmtDelete = db.prepare('DELETE FROM sessions WHERE id = ?');
  const stmtSearch = db.prepare(`
    SELECT s.*, g.name AS group_name
    FROM sessions s LEFT JOIN groups g ON s.group_id = g.id
    WHERE s.name LIKE ? OR s.host LIKE ?
    ORDER BY g.name, s.name
  `);

  // ---- 命令历史表(持久保存每台主机执行过的命令,重启不丢) ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS cmd_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      host       TEXT NOT NULL,
      command    TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_cmd_host ON cmd_history(host)');

  // 归档记录表:每次归档把 cmd_history 搬过来,按批次(archive_id)保存
  db.exec(`
    CREATE TABLE IF NOT EXISTS cmd_archive (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      archive_id TEXT NOT NULL,
      host       TEXT NOT NULL,
      command    TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_arch ON cmd_archive(archive_id)');

  // 归档批次表:每次归档一条记录,标明归属主机和对应文件(按主机查看归档)
  db.exec(`
    CREATE TABLE IF NOT EXISTS cmd_archives (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      archive_id TEXT NOT NULL UNIQUE,
      host       TEXT NOT NULL,
      file       TEXT DEFAULT '',
      count      INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  // ---- 会话录制表:每条录制的元数据(大体积的输出字节存在磁盘 JSONL 文件里)----
  // 注意:这里只存"元数据",不存输出内容。输出文件放 ~/.jms-terminal/recordings/,
  // 与 archives/ 目录同模式。这样 data.bin 加密库不会因为录制内容变大而膨胀。
  db.exec(`
    CREATE TABLE IF NOT EXISTS recordings (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_name TEXT NOT NULL,                 -- 会话名(连接时的名称)
      host         TEXT NOT NULL,                 -- 服务器地址
      port         INTEGER DEFAULT 22,
      username     TEXT DEFAULT '',
      encoding     TEXT DEFAULT 'utf8',           -- 输出编码(回放时按它解码)
      cols         INTEGER DEFAULT 120,           -- 终端列数(回放窗口用)
      rows         INTEGER DEFAULT 32,            -- 终端行数
      file         TEXT NOT NULL,                 -- JSONL 录制文件绝对路径
      started_at   TEXT,                          -- 录制开始时间
      duration_ms  INTEGER DEFAULT 0,             -- 录制时长(毫秒)
      size         INTEGER DEFAULT 0,             -- 文件大小(字节)
      created_at   TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  const stmtRecInsert = db.prepare(`
    INSERT INTO recordings
      (session_name, host, port, username, encoding, cols, rows, file, started_at, duration_ms, size)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtRecList = db.prepare('SELECT * FROM recordings ORDER BY id DESC');
  const stmtRecGet = db.prepare('SELECT * FROM recordings WHERE id = ?');
  const stmtRecDelete = db.prepare('DELETE FROM recordings WHERE id = ?');

  // ---- 快速命令表:保存常用命令,一键发送到当前终端或批量执行 ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS quick_cmds (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      command    TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);
  const stmtQuickInsert = db.prepare('INSERT INTO quick_cmds (name, command) VALUES (?, ?)');
  const stmtQuickUpdate = db.prepare('UPDATE quick_cmds SET name = ?, command = ? WHERE id = ?');
  const stmtQuickList = db.prepare('SELECT * FROM quick_cmds ORDER BY id');
  const stmtQuickDelete = db.prepare('DELETE FROM quick_cmds WHERE id = ?');

  // 默认快捷命令:按名称补全"缺失"的默认项(幂等);并清理"已被服务器体检覆盖"的旧默认。
  // 注意:默认命令若被删除会按名称补回;想彻底去掉,改名字即可。
  const stmtQuickGet = db.prepare('SELECT command FROM quick_cmds WHERE name = ?');
  const stmtQuickDelByName = db.prepare('DELETE FROM quick_cmds WHERE name = ?');

  // 新"服务器体检":单行、紧凑"键:值"输出(系统/运行时长/CPU/内存/磁盘/用户),Linux+macOS 自动降级;
  // 磁盘只显示真实分区(/dev 开头),过滤 tmpfs 等伪文件系统,避免整块 df 刷屏
  const NEW_HEALTH =
    'printf "系统: %s%s\\n" "$(uname -srm)" "$(. /etc/os-release 2>/dev/null && printf \' · %s\' "$PRETTY_NAME")"; ' +
    'printf "运行: %s\\n" "$(uptime -p 2>/dev/null || uptime)"; ' +
    'printf "CPU: %s\\n" "$(command -v lscpu >/dev/null 2>&1 && lscpu 2>/dev/null | grep -m1 \'Model name\' | cut -d: -f2 | xargs || sysctl -n machdep.cpu.brand_string 2>/dev/null || echo 未知)"; ' +
    'printf "内存: %s\\n" "$(command -v free >/dev/null 2>&1 && free -h 2>/dev/null | awk \'NR==2{print "共"$2",已用"$3",余"$4}\' || echo 未知)"; ' +
    'printf "磁盘: %s\\n" "$(df -h 2>/dev/null | awk \'$1 ~ /^\\/dev/ {printf "%s:%s(%s) ", $NF, $2, $5}\' | sed \'s/ *$//\')"; ' +
    'printf "用户: %s · 在线 %s 人\\n" "$(whoami)" "$(who 2>/dev/null | wc -l | tr -d \' \')"';

  // 旧"服务器体检"有两种历史格式(多行 == 分节 / 上一版整块 df)→ 识别到就删,换成最新版(宽松判断,防白差异)
  const oldHealth = stmtQuickGet.get('服务器体检');
  if (oldHealth && (oldHealth.command.includes('== 系统 ==') || oldHealth.command.includes('echo "磁盘:"; df -h'))) {
    stmtQuickDelByName.run('服务器体检');
  }

  // 旧默认单条命令(已被"服务器体检"覆盖)→ 只有内容完全等于旧默认才删,避免误删用户自定义
  const LEGACY_REMOVE = {
    '查看磁盘空间': 'df -h',
    '查看内存': 'free -m',
    '查看系统负载': 'uptime',
    '系统信息': 'uname -a',
    '操作系统版本': 'cat /etc/os-release',
    '登录用户': 'who',
  };
  for (const [name, cmd] of Object.entries(LEGACY_REMOVE)) {
    const row = stmtQuickGet.get(name);
    if (row && row.command === cmd) stmtQuickDelByName.run(name);
  }

  // 精简后的默认集:不再与"服务器体检"重复
  const DEFAULTS = [
    ['服务器体检', NEW_HEALTH],
    ['进程占用 TOP', 'ps aux | sort -rk4 | head -15'],
    ['端口监听', 'ss -tlnp'],
    ['最近系统日志', 'journalctl -n 50 --no-pager'],
    ['网络连通性', 'ping -c 4 8.8.8.8'],
  ];
  for (const [name, command] of DEFAULTS) {
    if (!stmtQuickGet.get(name)) stmtQuickInsert.run(name, command);
  }

  const stmtCmdInsert = db.prepare('INSERT INTO cmd_history (host, command) VALUES (?, ?)');
  const stmtCmdCount = db.prepare('SELECT COUNT(*) c FROM cmd_history WHERE host = ?');
  const stmtCmdDeleteOldest = db.prepare('DELETE FROM cmd_history WHERE id IN (SELECT id FROM cmd_history WHERE host = ? ORDER BY id LIMIT ?)');

  // 分组操作语句(支持嵌套:parent_id 指向父分组)
  const stmtGroupInsert = db.prepare('INSERT INTO groups (name, parent_id) VALUES (?, ?)');
  const stmtGroupRename = db.prepare('UPDATE groups SET name = ? WHERE id = ?');
  const stmtGroupDelete = db.prepare('DELETE FROM groups WHERE id = ?');
  const stmtGroupProd = db.prepare('UPDATE groups SET is_prod = ? WHERE id = ?');
  const stmtListGroups = db.prepare('SELECT id, name, parent_id, is_prod FROM groups ORDER BY name');

  // 递归收集某分组及其全部后代分组的 id(删组时连后代 + 后代里的会话一起删)
  function collectGroupIds(rootId) {
    const out = [rootId];
    for (const r of db.prepare('SELECT id FROM groups WHERE parent_id = ?').all(rootId)) {
      out.push(...collectGroupIds(r.id));
    }
    return out;
  }

  // 把"分组"解析成分组 id:传了 groupId 直接用;传了 group(名称)则查/建
  function resolveGroupId(s) {
    if (s.groupId != null) return s.groupId;
    const name = s.group || '默认分组';
    let g = stmtGroupByName.get(name);
    if (!g) { stmtGroupInsert.run(name, null); g = stmtGroupByName.get(name); }
    return g.id;
  }

  return {
    /** 列出全部会话 */
    list() {
      return stmtList.all();
    },

    /** 按 id 查单个会话 */
    get(id) {
      return stmtGet.get(id);
    },

    /** 新建会话,返回新记录的 id */
    create(s) {
      const r = stmtInsert.run(s.name, s.host, s.port || 22, s.username, s.password || '',
        s.privateKey || '', s.passphrase || '', s.encoding || 'utf8', s.protocol || 'ssh', resolveGroupId(s), s.tagColor || '', s.onConnect || '', s.jump || '');
      return Number(r.lastInsertRowid);
    },

    /** 更新会话 */
    update(id, s) {
      stmtUpdate.run(s.name, s.host, s.port || 22, s.username, s.password || '',
        s.privateKey || '', s.passphrase || '', s.encoding || 'utf8', s.protocol || 'ssh', resolveGroupId(s), s.tagColor || '', s.onConnect || '', s.jump || '', id);
    },

    /** 列出全部分组 */
    listGroups() {
      return stmtListGroups.all();
    },

    /** 新建分组,返回新分组 id;parentId 传了就建为它的子分组 */
    createGroup(name, parentId) {
      if (!name || !name.trim()) throw new Error('分组名不能为空');
      const r = stmtGroupInsert.run(name.trim(), parentId || null);
      return Number(r.lastInsertRowid);
    },

    /** 重命名分组 */
    renameGroup(id, name) {
      if (!name || !name.trim()) throw new Error('分组名不能为空');
      stmtGroupRename.run(name.trim(), id);
    },

    /** 标记分组是否为"生产环境"(1=生产,红色高亮+危险命令确认) */
    setGroupProd(id, flag) {
      stmtGroupProd.run(flag ? 1 : 0, id);
    },

    /** 删除分组:递归删掉它及全部后代分组,以及它们下面的所有会话(不可恢复)。
     *  数据层硬性安全门槛:默认分组不可删;一次最多涉及 1 个顶级分组(防任何路径误删一片) */
    deleteGroup(id) {
      const ids = collectGroupIds(id);
      // ① 默认分组是系统保留,任何调用方都不能删
      const target = db.prepare('SELECT name FROM groups WHERE id = ?').get(id);
      if (target && target.name === '默认分组') throw new Error('默认分组是系统保留分组,不能删除');
      // ② 本次涉及的分组里,顶级分组只能有 1 个
      let topLevel = 0;
      for (const gid of ids) {
        const row = db.prepare('SELECT parent_id FROM groups WHERE id = ?').get(gid);
        if (!row) continue;
        const pid = row.parent_id;
        const hasParent = pid != null && db.prepare('SELECT 1 FROM groups WHERE id = ?').get(pid);
        if (!hasParent) topLevel++;
      }
      if (topLevel > 1) throw new Error('一次只能删除一个顶级分组,请逐个删除');
      const marks = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM sessions WHERE group_id IN (${marks})`).run(...ids);
      db.prepare(`DELETE FROM groups WHERE id IN (${marks})`).run(...ids);
    },

    /** 删除会话 */
    remove(id) {
      stmtDelete.run(id);
    },

    /** 搜索(按名称或 IP 模糊匹配,支持中文) */
    search(keyword) {
      const like = `%${keyword}%`;
      return stmtSearch.all(like, like);
    },

    /**
     * 批量导入(事务):一次插入多条会话配置。
     * 为什么用事务? 几十上百条插入时,如果中途出错,
     * BEGIN/ROLLBACK 保证"要么全部成功、要么全部回滚",不会留下半截数据。
     * @param {Array} list — [{ name, host, port, username, password, group }]
     * @returns {Array} 逐条结果 [{ ok, id?, name?, error? }]
     */
    importMany(list) {
      const results = [];
      db.exec('BEGIN');
      try {
        for (const item of list) {
          try {
            const r = stmtInsert.run(
              item.name, item.host, item.port || 22,
              item.username, item.password || '', item.privateKey || '', item.passphrase || '',
              item.encoding || 'utf8', item.protocol || 'ssh', resolveGroupId(item)
            );
            results.push({ ok: true, id: Number(r.lastInsertRowid), name: item.name });
          } catch (err) {
            // 单条失败:记下来,继续导其他的(不中断整个批次)
            results.push({ ok: false, name: item.name, error: err.message });
          }
        }
        db.exec('COMMIT'); // 全部跑完,提交
      } catch (err) {
        db.exec('ROLLBACK'); // 出大问题,整体回滚
        throw err;
      }
      return results;
    },

    /** 记录一条命令(持久保存);单主机最多保留 1000 条,超出删最旧 */
    addCmd(host, command) {
      const h = String(host || '').trim() || '未知主机';
      const cmd = String(command || '').trim();
      if (!cmd) return;
      stmtCmdInsert.run(h, cmd);
      const { c } = stmtCmdCount.get(h);
      if (c > 1000) stmtCmdDeleteOldest.run(h, c - 1000); // 只删超出部分的最旧记录
    },

    /** 列出全部命令记录(按插入顺序) */
    listCmds() {
      return db.prepare('SELECT host, command, created_at FROM cmd_history ORDER BY id').all();
    },

    /** 清空全部命令记录 */
    clearCmds() {
      db.exec('DELETE FROM cmd_history');
    },

    /** 归档某台主机的命令:把该主机的 cmd_history 搬进 cmd_archive,并登记归档批次 */
    archiveCmds(archiveId, host, file) {
      const rows = db.prepare('SELECT host, command, created_at FROM cmd_history WHERE host = ? ORDER BY id').all(host);
      if (!rows.length) return 0;
      const ins = db.prepare('INSERT INTO cmd_archive (archive_id, host, command, created_at) VALUES (?, ?, ?, ?)');
      const insBatch = db.prepare('INSERT INTO cmd_archives (archive_id, host, file, count) VALUES (?, ?, ?, ?)');
      db.exec('BEGIN');
      try {
        for (const r of rows) ins.run(archiveId, r.host, r.command, r.created_at || new Date().toISOString().slice(0, 19).replace('T', ' '));
        db.prepare('DELETE FROM cmd_history WHERE host = ?').run(host);
        insBatch.run(archiveId, host, file || '', rows.length);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return rows.length;
    },

    /** 列出某台主机的归档批次(时间倒序) */
    listArchives(host) {
      return db.prepare('SELECT archive_id, host, file, count, created_at FROM cmd_archives WHERE host = ? ORDER BY id DESC').all(host);
    },

    /** 补写某批归档的文件路径(生成文件后再填) */
    setArchiveFile(archiveId, file) {
      db.prepare('UPDATE cmd_archives SET file = ? WHERE archive_id = ?').run(file, archiveId);
    },

    /** 查看某批归档的明细命令 */
    archiveDetail(archiveId) {
      return db.prepare('SELECT host, command, created_at FROM cmd_archive WHERE archive_id = ? ORDER BY id').all(archiveId);
    },

    /** 删除某批归档(明细表 + 批次表) */
    deleteArchive(archiveId) {
      db.prepare('DELETE FROM cmd_archive WHERE archive_id = ?').run(archiveId);
      db.prepare('DELETE FROM cmd_archives WHERE archive_id = ?').run(archiveId);
    },

    /** 新增一条快速命令,返回 id */
    addQuickCmd(name, command) {
      const r = stmtQuickInsert.run(String(name || '').trim() || '未命名', String(command || '').trim());
      return Number(r.lastInsertRowid);
    },

    /** 列出全部快速命令("服务器体检"固定排第一,其余按 id) */
    listQuickCmds() {
      return db.prepare("SELECT * FROM quick_cmds ORDER BY CASE WHEN name = '服务器体检' THEN 0 ELSE id END").all();
    },

    /** 更新一条快速命令 */
    updateQuickCmd(id, name, command) {
      stmtQuickUpdate.run(String(name || '').trim() || '未命名', String(command || '').trim(), Number(id));
    },

    /** 删除一条快速命令 */
    deleteQuickCmd(id) {
      stmtQuickDelete.run(Number(id));
    },

    /** 登记一条录制元数据,返回新 id(录制文件已写好之后调用) */
    addRecording(meta) {
      const r = stmtRecInsert.run(
        meta.sessionName || '未知会话', meta.host || '', meta.port || 22,
        meta.username || '', meta.encoding || 'utf8', meta.cols || 120, meta.rows || 32,
        meta.file, meta.startedAt || '', meta.durationMs || 0, meta.size || 0
      );
      return Number(r.lastInsertRowid);
    },

    /** 列出全部录制(新的在前) */
    listRecordings() {
      return stmtRecList.all();
    },

    /** 按 id 查单个录制 */
    getRecording(id) {
      return stmtRecGet.get(id);
    },

    /** 删除一条录制元数据;返回被删的那行(供主进程顺手删磁盘文件) */
    deleteRecording(id) {
      const row = stmtRecGet.get(id);
      if (row) stmtRecDelete.run(id);
      return row;
    },

    /** 序列化整个库为字节(主进程加密后落盘) */
    serialize() {
      return db.serialize();
    },

    /** 关闭数据库(程序退出时调用) */
    close() {
      db.close();
    },
  };
}

module.exports = { createStore };
