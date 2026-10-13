import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getDbPath } from './paths.js';

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

-- 全局静态配置（key-value 单表，原 <dataDir>/settings.json 文件——配置
-- 统一落库）。配置项以约定 key 落行（如 terminal.preset / locale /
-- hooks.enabled / events.retentionDays），新增配置零表结构迁移；
-- 值为文本，读时经 mergeDefaults 归一化，坏值自愈回落默认。
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Open (creating + migrating if needed) the weave database. */
export function openDatabase(dbPath: string = getDbPath()): DatabaseSync {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  // WAL 允许跨连接并发读写，但写写仍互斥：inbox 消费线程持有第二个连接，
  // 默认 busy_timeout=0 会让瞬时争用直接抛 SQLITE_BUSY。
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  migrateHookRulesColumns(db);
  migrateProjectsColumns(db);
  return db;
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
