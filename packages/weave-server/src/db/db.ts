import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getDbPath } from './paths.js';
import { projectKey } from '../repositories/projects.js';

/**
 * Idempotent schema.
 *
 * Persistence boundary: registry tables (`projects`, `libraries`), the
 * append-only event log (`hook_events`), and the D3 hooks system
 * (`hook_rules` 配置 / `hook_dispatches` 运行态 / `sessions` 会话标题).
 * Skill/MCP *state* is NEVER persisted — it is always read live from the
 * filesystem.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  path          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  token         TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'init',
  registered_at TEXT NOT NULL,
  last_seen_at  TEXT,
  meta          TEXT,
  sort_order    INTEGER,
  archived_at   TEXT
);

CREATE TABLE IF NOT EXISTS hook_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source     TEXT NOT NULL,
  event_type TEXT NOT NULL,
  session_id TEXT,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hook_events_project ON hook_events(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_hook_events_session ON hook_events(session_id);

CREATE TABLE IF NOT EXISTS libraries (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  path     TEXT NOT NULL UNIQUE,
  kind     TEXT NOT NULL DEFAULT 'skill',
  added_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hook_rules (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  priority   INTEGER NOT NULL DEFAULT 0,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  source     TEXT NOT NULL,
  filter     TEXT NOT NULL DEFAULT '{}',
  handler    TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL DEFAULT 10000,
  record     INTEGER NOT NULL DEFAULT 1,
  origin     TEXT NOT NULL DEFAULT 'user',
  plugin_id  TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hook_rules_project ON hook_rules(project_id);

CREATE TABLE IF NOT EXISTS plugin_states (
  id         TEXT PRIMARY KEY,
  enabled    INTEGER NOT NULL DEFAULT 1,
  config     TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hook_dispatches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id     TEXT NOT NULL REFERENCES hook_rules(id) ON DELETE CASCADE,
  event_id    INTEGER REFERENCES hook_events(id) ON DELETE SET NULL,
  session_id  TEXT,
  prompt      TEXT NOT NULL,
  status      TEXT NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'manual',
  output      TEXT,
  error       TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_hook_dispatches_rule ON hook_dispatches(rule_id, started_at);
CREATE INDEX IF NOT EXISTS idx_hook_dispatches_status ON hook_dispatches(status);

CREATE TABLE IF NOT EXISTS sessions (
  session_id    TEXT PRIMARY KEY,
  project_id    INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  title         TEXT,
  pending_title TEXT,
  last_seen_at  TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, last_seen_at);

-- 跨会话编排（session-orchestration）：会话订阅 + 序列表保留。点对点消息域
-- 已重塑为纯递送管道（本地文件 + 内存态，不落库）——session_messages 表退役。
-- on_events = 触发类型集 JSON（['idle'] 缺省 | 'turnEnd' | 'messageFailed' 的组合）；
-- remaining = 剩余提醒次数（**所有已选类型共用一个计数**），NULL = 持久化（不失效）。
CREATE TABLE IF NOT EXISTS session_watches (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  watcher_session_id TEXT,
  target_session_id  TEXT NOT NULL,
  notify             TEXT,
  on_events          TEXT,
  remaining          INTEGER,
  fired_at           TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_watches_target ON session_watches(target_session_id, fired_at);

-- 旁路会话（claude = /btw）：宿主侧问的问题与回答**都不落任何文件**（侧问查询开着
-- skipTranscript，面板历史只在宿主内存里），故 weave 自己发出去的问题只能记在这；
-- 回答由采集事件认领（answer_event_id 指回那条 SubagentStop，answer 存原文——
-- 事件会按保留策略清掉，而这条问答是用户的历史）。
-- status: pending（已打出、等回答）| answered（认领到）| timeout（超窗没等到）。
CREATE TABLE IF NOT EXISTS side_questions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  project_id      INTEGER,
  question        TEXT NOT NULL,
  answer          TEXT,
  answer_event_id INTEGER,
  status          TEXT NOT NULL,
  asked_at        TEXT NOT NULL,
  answered_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_side_questions_session ON side_questions(session_id, id);

-- 跨会话序列（批 3）：手工编排的多步链。steps JSON = [{to,text,mode,
-- messageId?}]，messageId 为步触发后回填的管道发号（内存关联）；
-- cursor = 正在等待完成的步下标。引擎无内存权威态，全部状态在行。
-- 消息域重塑（消息域退役）：上表 session_messages 随管道化 DROP。
CREATE TABLE IF NOT EXISTS session_sequences (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL DEFAULT '',
  steps      TEXT NOT NULL,
  status     TEXT NOT NULL,
  cursor     INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 全局静态配置（key-value 单表，原 <dataDir>/settings.json 文件——配置
-- 统一落库）。配置项以约定 key 落行（如 terminal.preset / locale /
-- hooks.enabled / events.retentionDays），新增配置零表结构迁移；
-- 值为文本，读时经 mergeDefaults 归一化，坏值自愈回落默认。
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Web Push 订阅（每个浏览器安装一份；endpoint 是推送服务的绝对 URL，
-- 天然唯一键）。推送服务回 404/410 = 订阅已被浏览器端撤销 → 发送侧删除。
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL
);

-- 会话图片上传：内容寻址 id = sha256（天然去重），文件落 <dataDir>/uploads/。
-- 上传 ≠ 投递（资源三层里的「装到目标位」）；与会话的关系经 event_images。
CREATE TABLE IF NOT EXISTS uploads (
  id         TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  name       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- 消息随附的图（对话气泡的缩略图）：挂在**开轮事件**上——消息域不落库，
-- 图的归宿是会话自己的转录事件，这里只存指针。随 hook_events 级联删。
CREATE TABLE IF NOT EXISTS event_images (
  event_id  INTEGER NOT NULL REFERENCES hook_events(id) ON DELETE CASCADE,
  upload_id TEXT NOT NULL,
  PRIMARY KEY (event_id, upload_id)
);
`;

/** Open (creating + migrating if needed) the weave database. */
export function openDatabase(dbPath: string = getDbPath()): DatabaseSync {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  // WAL 允许跨连接并发读写，但写写仍互斥：inbox 消费线程持有第二个连接，
  // 默认 busy_timeout=0 会让瞬时争用直接抛 SQLITE_BUSY。必须先于下面那条
  // WAL pragma——后者是改写头部的独占写，daemon 正在启动（跑 SCHEMA/迁移）
  // 时另起的 CLI 撞上它就是无重试的 SQLITE_IOERR（Windows 上报 disk I/O error）。
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  // 消息域重塑：session_messages 退役（消息 = 纯递送管道，本地文件 + 内存态）。
  // 存量行均为测试数据，随表删；DROP 幂等。
  db.exec('DROP TABLE IF EXISTS session_messages');
  migrateHookRulesColumns(db);
  migrateProjectsColumns(db);
  migrateProjectPaths(db);
  migrateSessionWatchesColumns(db);
  return db;
}

/**
 * 注册键归一：存量 `projects.path` 一律重写成 `projectKey` 形态（幂等）——
 * 旧库里同一目录的两种分隔符写法不归一就查不中。归一后若与已有行撞键，那两行
 * 本来就是重复登记——跳过不动，合并留给人工（撞键即抛会把 daemon 开不起来）。
 */
function migrateProjectPaths(db: DatabaseSync): void {
  const rows = db.prepare('SELECT id, path FROM projects ORDER BY id').all() as Array<{
    id: number;
    path: string;
  }>;
  const taken = new Set(rows.map((r) => r.path));
  const upd = db.prepare('UPDATE projects SET path = ? WHERE id = ?');
  for (const r of rows) {
    const key = projectKey(r.path);
    if (key === r.path || taken.has(key)) continue;
    taken.delete(r.path);
    taken.add(key);
    upd.run(key, r.id);
  }
}

/**
 * 会话订阅的列级兜底：存量库补 on_events（触发类型集，NULL = 老行 → 读侧
 * parseOn 归一为缺省 idle）与 remaining（剩余次数；老行按 1 回填——批 2 的
 * 订阅是 one-shot，不能因为 NULL 被读成「持久化」）。
 */
function migrateSessionWatchesColumns(db: DatabaseSync): void {
  const cols = new Set(
    db
      .prepare('PRAGMA table_info(session_watches)')
      .all()
      .map((row) => String((row as { name: string }).name)),
  );
  if (cols.size === 0) return; // 表尚不存在（SCHEMA 已含新列），无须迁移
  if (!cols.has('on_events')) db.exec('ALTER TABLE session_watches ADD COLUMN on_events TEXT');
  if (!cols.has('remaining')) {
    db.exec('ALTER TABLE session_watches ADD COLUMN remaining INTEGER');
    db.exec('UPDATE session_watches SET remaining = 1');
  }
}

/**
 * 与 migrateHookRulesColumns 同款的列级兜底：给既有库补 projects.sort_order
 * （dashboard 拖动排序）与 projects.archived_at（归档标记，NULL = 活跃）。
 * 幂等：列已存在则跳过。
 */
function migrateProjectsColumns(db: DatabaseSync): void {
  const cols = new Set(
    db
      .prepare('PRAGMA table_info(projects)')
      .all()
      .map((row) => String((row as { name: string }).name)),
  );
  if (cols.size === 0) return; // 表尚不存在（SCHEMA 已含新列），无须迁移
  if (!cols.has('sort_order')) {
    db.exec('ALTER TABLE projects ADD COLUMN sort_order INTEGER');
  }
  if (!cols.has('archived_at')) {
    db.exec('ALTER TABLE projects ADD COLUMN archived_at TEXT');
  }
}

/**
 * 无迁移基建下的列级兜底：`CREATE TABLE IF NOT EXISTS` 不会给既有库补列，
 * hook_rules 的 origin/plugin_id（D3 插件来源标记）对旧库用
 * `PRAGMA table_info` 探测 + `ALTER TABLE ADD COLUMN` 补上。
 * 幂等：列已存在则跳过。
 *
 * 注意必须先于 `idx_hook_rules_plugin` 建索引执行——SCHEMA 里的
 * `CREATE INDEX ... ON hook_rules(plugin_id)` 遇到缺列旧库会直接报
 * `no such column`，故该索引也在此处、列补齐后创建。
 */
function migrateHookRulesColumns(db: DatabaseSync): void {
  const cols = new Set(
    db
      .prepare('PRAGMA table_info(hook_rules)')
      .all()
      .map((row) => String((row as { name: string }).name)),
  );
  if (cols.size === 0) return; // 表尚不存在（SCHEMA 已含新列），无须迁移
  if (!cols.has('origin')) {
    db.exec("ALTER TABLE hook_rules ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'");
  }
  if (!cols.has('plugin_id')) {
    db.exec('ALTER TABLE hook_rules ADD COLUMN plugin_id TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_hook_rules_plugin ON hook_rules(plugin_id)');
}
