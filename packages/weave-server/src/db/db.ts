import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
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
-- 会话列表（listWithCounts）的那几个相关子查询：MAX(id) WHERE session_id=? AND
-- event_type IN (…)。只有 (session_id) 时每个子查询都要扫该会话全部事件（最大的
-- 会话几万条），实测 63 个会话 3.9s；带上 event_type 后每个类型一次定位，2.6ms。
CREATE INDEX IF NOT EXISTS idx_hook_events_session_type ON hook_events(session_id, event_type, id);
-- 全局搜索（GET /search）的聊天记录路：event_type 先收窄到对话类（约占 2%），
-- 再对 payload 做 json_extract + LIKE——没有这把索引就是 20 万行全表扫。
CREATE INDEX IF NOT EXISTS idx_hook_events_type ON hook_events(event_type);

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

-- 跨会话编排：一份 = 节点集（session / webhook）+ 有向边集（边带消息正文）。
-- 节点是对象数组：session 节点 id = sessionId，webhook 节点 id = w:<uuid>
-- （入口带 webhookToken，出口带 url/secret）；入口 = 无入边，出口 = 无出边。
-- project_id = 入口 session 节点所属项目（webhook-only 由创建方显式给）。
-- cron 为 5 字段表达式（NULL = 无定时）；enabled = 停用闸（cron/自然回合都不跑）。
-- 线性链 session_sequences 与旧单起点表已由本模型取代（旧形状行不迁移，
-- 由 rebuildOrchestrations 判形状后一次性重建）。
DROP TABLE IF EXISTS session_sequences;
CREATE TABLE IF NOT EXISTS orchestrations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  project_id   INTEGER NOT NULL,
  start_text   TEXT NOT NULL DEFAULT '',
  nodes        TEXT NOT NULL,
  edges        TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  cron         TEXT,
  last_cron_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- 编排运行日志：一次触发一行，手动 / webhook / cron 同表（统一视图的数据源）。
-- 编排名与 project_id 去规范化——删编排不删日志（保留「当时跑了什么」）。
-- 状态机在引擎内存，行随每次转场落盘；重启即 interrupted。
CREATE TABLE IF NOT EXISTS orchestration_runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  orchestration_id   INTEGER NOT NULL,
  orchestration_name TEXT NOT NULL,
  project_id         INTEGER NOT NULL,
  trigger            TEXT NOT NULL,
  status             TEXT NOT NULL,
  deliveries         INTEGER NOT NULL DEFAULT 0,
  state              TEXT NOT NULL,
  error              TEXT,
  created_at         TEXT NOT NULL,
  finished_at        TEXT,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orch_runs_orch ON orchestration_runs(orchestration_id, id);
CREATE INDEX IF NOT EXISTS idx_orch_runs_project ON orchestration_runs(project_id, id);

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

-- 外发提醒通道（企微/飞书/钉钉/邮件/Server酱/PushPlus）：config 是 JSON，
-- 含平台凭据（与编排 webhook 节点的 secret 同口径——dashboard 在认证门后，
-- 管理面要能回显重验）。enabled = 参与提醒扇出与可被编排选用。
CREATE TABLE IF NOT EXISTS notify_channels (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  name       TEXT NOT NULL,
  config     TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- 会话图片上传：内容寻址 id = sha256（天然去重），文件落 <dataDir>/uploads/。
-- 上传 ≠ 投递（资源三层里的「装到目标位」）；与会话的关系经 event_images。
-- dir = 项目自定义存储目录（NULL = 全局默认 <dataDir>/uploads/）；存量行
-- 保持 NULL 留在原处，新上传按项目配置落新路径，零迁移。
CREATE TABLE IF NOT EXISTS uploads (
  id         TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  name       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  dir        TEXT
);

-- 会话扩展点（L1 绑定域）：绑定 = 「哪个作用域的哪个扩展点 → 什么决策 →
-- 扇出到哪些端点」的常驻接线。session_id NULL = 项目级（对全部会话生效）、
-- 非空 = 会话级（叠加求值：项目级与会话级各自独立、互不抑制）。endpoints 是
-- JSON [{kind:'session'|'webhook', ...}]（扁平列表、并行扇出、无屏障）。
CREATE TABLE IF NOT EXISTS extension_bindings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id     TEXT,
  point          TEXT NOT NULL,
  when_text      TEXT,
  condition_text TEXT,
  summarize      TEXT,
  endpoints      TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_extension_bindings_project ON extension_bindings(project_id);

-- 执行日志：一拍一行（按端点展开则一拍多行），激进修剪（每绑定 200 条 + 7 天）。
-- 幂等去重靠 partial 唯一索引（只盖 delivered 行）：执行日志含 when-blocked 等
-- 非投递 stage，全行唯一索引会让回放期的同事件 blocked 行插不进去。
CREATE TABLE IF NOT EXISTS extension_executions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  binding_id      INTEGER NOT NULL REFERENCES extension_bindings(id) ON DELETE CASCADE,
  session_id      TEXT,
  event_id        INTEGER,
  trigger         TEXT NOT NULL DEFAULT 'event',
  stage           TEXT NOT NULL,
  endpoint_kind   TEXT,
  endpoint_target TEXT,
  ok              INTEGER,
  error           TEXT,
  source          TEXT,
  detail          TEXT,
  at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_extension_exec_binding ON extension_executions(binding_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_extension_exec_delivered
  ON extension_executions(binding_id, event_id, endpoint_kind, endpoint_target)
  WHERE stage = 'delivered' AND event_id IS NOT NULL;

-- 消息随附的图（对话气泡的缩略图）：挂在**开轮事件**上——消息域不落库，
-- 图的归宿是会话自己的转录事件，这里只存指针。随 hook_events 级联删。
CREATE TABLE IF NOT EXISTS event_images (
  event_id  INTEGER NOT NULL REFERENCES hook_events(id) ON DELETE CASCADE,
  upload_id TEXT NOT NULL,
  PRIMARY KEY (event_id, upload_id)
);

-- RPG 域（RPG-1 最小 DDL，RPG 稿 §5.3.6 + §三）：角色 = 项目（角色仓库）的登记行，
-- 团队/剧本 = 协调者仓库文件的登记行——**这里只存游戏自己的事实，观察态零冗余**
-- （角色状态/模型/事件统计仍从既有表派生）。仓库落盘是文件层（rpg/roles/），本表
-- 只做「项目 id → 角色」的映射与元数据。
CREATE TABLE IF NOT EXISTS rpg_roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  archetype   TEXT,                      -- 七型模板（能量/思考/创造/连接/审核/执行/适配；NULL = 自定义）
  persona     TEXT,                      -- 提示词人设（角色插件 manifest 素材实例化时的快照）
  hexagon     TEXT,                      -- JSON 六维基线 {力量:5,...}
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rpg_teams (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  goal        TEXT,
  roles       TEXT NOT NULL DEFAULT '[]', -- JSON [{role: <角色仓库名>, module?}]
  playbook    TEXT,                       -- playbook://<name>（渲染后建编排）
  project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL, -- 协调者项目（NULL = 未建）
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
-- 修炼/成长记录（行动态：动词门面写入；观察态与游戏态的唯一分界）
CREATE TABLE IF NOT EXISTS rpg_growth (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  role   INTEGER NOT NULL REFERENCES rpg_roles(id) ON DELETE CASCADE,
  verb   TEXT NOT NULL,                  -- cultivate | equip | ...
  target TEXT NOT NULL,                  -- skill / plugin 名
  detail TEXT,
  at     TEXT NOT NULL
);
-- 六维快照（修炼/修正后落，历史可回放成长曲线）
CREATE TABLE IF NOT EXISTS rpg_hexagram (
  role  INTEGER NOT NULL REFERENCES rpg_roles(id) ON DELETE CASCADE,
  dims  TEXT NOT NULL,                   -- JSON {力量:5, 智慧:2, ...}
  reason TEXT,                           -- 触发来源（哪次修炼/修正）
  at    TEXT NOT NULL,
  PRIMARY KEY (role, at)
);
-- 技巧维度评分（修炼产出，RPG 稿 §5.2）：角色 → 当前技巧分 + 派生依据；一行一角色
CREATE TABLE IF NOT EXISTS rpg_scores (
  role  INTEGER PRIMARY KEY REFERENCES rpg_roles(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,                -- 0..100
  basis TEXT,                            -- 派生依据说明（基线/实战）
  at    TEXT NOT NULL
);
-- 成就解锁事实（RPG-3 派生落定）：一行 = 一枚成就的首次解锁；派生面重扫
-- hook_events 统计，这里只记事实（哪枚、依据什么计数、何时解锁），重扫幂等。
CREATE TABLE IF NOT EXISTS rpg_achievements (
  role       INTEGER NOT NULL REFERENCES rpg_roles(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,              -- 成就词表键（封闭枚举，见 rpg/progress.ts）
  stats      TEXT,                       -- 解锁依据摘要（触发口径的计数快照）
  at         TEXT NOT NULL,
  PRIMARY KEY (role, key)
);
-- XP 快照（RPG-3 派生落定）：一行 = 一次派生重算的总量快照（含分项）；读面
-- 直接由 hook_events + growth 现算，本表只留历史曲线。
CREATE TABLE IF NOT EXISTS rpg_xp (
  role      INTEGER NOT NULL REFERENCES rpg_roles(id) ON DELETE CASCADE,
  total     INTEGER NOT NULL,
  breakdown TEXT,                        -- JSON {quest, turns, cultivation}
  at        TEXT NOT NULL,
  PRIMARY KEY (role, at)
);

-- 联邦 peer 注册表（E3，RPG 稿 §六 + D8 预留）：手动 host:port 是基础、mDNS 自动
-- 发现是增强。per-peer token 不落本表——落 <local>/peer-tokens/（0600，同 localToken
-- 纪律）；last_seen_at 是心跳事实，online/offline 由 peerLiveness 派生不存列。
CREATE TABLE IF NOT EXISTS peers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  host         TEXT NOT NULL,
  port         INTEGER NOT NULL,
  fingerprint  TEXT,                     -- 对端证书指纹（TOFU 首见记录）
  source       TEXT NOT NULL DEFAULT 'manual', -- manual | mdns | pairing
  last_seen_at TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL
);
`;

/** schema 版本（写进 PRAGMA user_version）：结构有变就递增，迁移前据此备份。 */
const SCHEMA_VERSION = 1;
/** 迁移备份保留份数（`<dataDir>/backups/`，每份按库大小计）。 */
const BACKUP_KEEP = 3;

/**
 * 损坏类错误：SQLite 在解析 schema / 读页时给出的那几条。只有这一类才走
 * 「隔离 + 重建」——权限、锁之类的错误重建只会把用户数据白扔掉。
 */
function isCorruptionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /malformed database schema|database disk image is malformed|file is not a database|SQLITE_CORRUPT/i.test(
    msg,
  );
}

function userVersionOf(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return typeof row?.user_version === 'number' ? row.user_version : 0;
}

/**
 * 迁移前备份：库的 user_version 落后于当前代码时才做（升级到带版本号的版本、
 * 以及以后每次结构变更）。走 `VACUUM INTO`——WAL 模式下直接复制主库会漏掉还在
 * `-wal` 里的已提交页，VACUUM INTO 在同一连接上取一致性快照。备份失败只记日志：
 * 盘满/没权限不该挡住启动。
 */
function backupIfMigrating(db: DatabaseSync, dbPath: string): void {
  if (dbPath === ':memory:') return;
  const current = userVersionOf(db);
  if (current >= SCHEMA_VERSION) return;
  // 要动结构了才做全库体检：quick_check 是逐页扫描，1GB 级的库要几十秒，放在
  // 每次启动上等于把冷启动拖成分钟级。schema 本身坏掉的情况 SQLite 自己会在
  // 解析时抛（正是用户遇到的那条 malformed database schema），走隔离重建。
  const check = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
  if (check?.quick_check !== undefined && check.quick_check !== 'ok') {
    throw new Error(`malformed database schema (${check.quick_check})`);
  }
  const objects = db.prepare('SELECT count(*) AS n FROM sqlite_master').get() as
    | { n: number }
    | undefined;
  if (!objects || objects.n === 0) return; // 新库，没有可备份的东西
  const dir = path.join(path.dirname(dbPath), 'backups');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `weave-v${current}-${stamp}.db`);
  try {
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    console.log(`[weave] database backup before migration: ${dest}`);
    pruneBackups(dir);
  } catch (err) {
    console.error(
      `[weave] database backup failed (continuing): ${err instanceof Error ? err.message : err}`,
    );
  }
}

function pruneBackups(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter((n) => n.startsWith('weave-v') && n.endsWith('.db'))
      .sort();
    for (const stale of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) {
      try {
        unlinkSync(path.join(dir, stale));
      } catch {
        /* 删不掉就留着，下次再试 */
      }
    }
  } catch {
    /* 目录读不到：备份已写成功与否由 VACUUM 那步决定 */
  }
}

/**
 * 损坏的库隔离到旁边、重建空库继续启动。dashboard 起不来等于全部功能消失；
 * 坏文件留在 `.corrupt-<时间戳>` 里（连 -wal/-shm 一起），事后可抢救。
 */
function quarantineAndRebuild(dbPath: string, err: unknown): DatabaseSync {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const quarantine = `${dbPath}.corrupt-${stamp}`;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      if (existsSync(dbPath + suffix)) renameSync(dbPath + suffix, quarantine + suffix);
    } catch {
      /* 占着搬不动：下面重建会失败，错误照常上抛 */
    }
  }
  const note = err instanceof Error ? err.message : String(err);
  console.error(
    `[weave] database is corrupt (${note}); moved to ${quarantine} and starting with a fresh one. ` +
      `Recover the old data with: sqlite3 "${quarantine}" ".recover" | sqlite3 "${dbPath}"`,
  );
  return openAndMigrate(dbPath);
}

/**
 * Open (creating + migrating if needed) the weave database. 损坏类错误在隔离
 * 重建后继续启动（见 quarantineAndRebuild），其余错误原样上抛。
 */
export function openDatabase(dbPath: string = getDbPath()): DatabaseSync {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  try {
    return openAndMigrate(dbPath);
  } catch (err) {
    if (!isCorruptionError(err)) throw err;
    return quarantineAndRebuild(dbPath, err);
  }
}

function openAndMigrate(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  try {
    // WAL 允许跨连接并发读写，但写写仍互斥：inbox 消费线程持有第二个连接，
    // 默认 busy_timeout=0 会让瞬时争用直接抛 SQLITE_BUSY。必须先于下面那条
    // WAL pragma——后者是改写头部的独占写，daemon 正在启动（跑 SCHEMA/迁移）
    // 时另起的 CLI 撞上它就是无重试的 SQLITE_IOERR（Windows 上报 disk I/O error）。
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    // 注意：这里不做全库 quick_check——见 backupIfMigrating 里的说明（1GB 级
    // 的库每次启动逐页扫要几十秒）。schema 坏掉由 SQLite 解析时自己抛。
    backupIfMigrating(db, dbPath);
    rebuildOrchestrations(db);
    db.exec(SCHEMA);
    // 消息域重塑：session_messages 退役（消息 = 纯递送管道，本地文件 + 内存态）。
    // 存量行均为测试数据，随表删；DROP 幂等。
    db.exec('DROP TABLE IF EXISTS session_messages');
    migrateHookRulesColumns(db);
    migrateProjectsColumns(db);
    migrateProjectPaths(db);
    migrateSessionWatchesColumns(db);
    migrateUploadsColumns(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return db;
  } catch (err) {
    // 抛错时连接还开着：Windows 上文件被占会让隔离改名失败，必须先关
    try {
      db.close();
    } catch {
      /* 已关或底层坏透：上层按原错误处理 */
    }
    throw err;
  }
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
 * 与 migrateProjectsColumns 同款的列级兜底：给既有库补 uploads.dir
 * （项目自定义存储目录，NULL = 全局默认）。幂等：列已存在则跳过。
 */
function migrateUploadsColumns(db: DatabaseSync): void {
  const cols = new Set(
    db
      .prepare('PRAGMA table_info(uploads)')
      .all()
      .map((row) => String((row as { name: string }).name)),
  );
  if (cols.size === 0) return; // 表尚不存在（SCHEMA 已含新列），无须迁移
  if (!cols.has('dir')) {
    db.exec('ALTER TABLE uploads ADD COLUMN dir TEXT');
  }
}

/**
 * 编排表形状重建：多入口/节点对象化的新模型不带旧列（start_session_id /
 * handoff_prompt / webhook_token）。判据 = 表在但缺 `enabled` 列（旧形状唯一
 * 稳定特征）→ 整表删掉，交给随后的 SCHEMA 按新形状重建；新表（有 enabled）
 * 永不动。定义不迁移（用户裁决：不考虑旧编排兼容），运行日志行保留。
 */
function rebuildOrchestrations(db: DatabaseSync): void {
  const cols = db
    .prepare('PRAGMA table_info(orchestrations)')
    .all() as Array<{ name: string }>;
  if (cols.length === 0 || cols.some((c) => c.name === 'enabled')) return;
  db.exec('DROP TABLE orchestrations');
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
