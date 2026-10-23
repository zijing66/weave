import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../db/db.js';
import { getDbPath } from '../db/paths.js';
import { DEFAULT_BIND_HOST } from './port.js';

/**
 * Daemon-level settings (as opposed to per-project or harness settings):
 * machine-local preferences for the dashboard itself.
 *
 * Stored in the daemon database — a generic `settings` key-value table
 * (config unified into the DB; no config files are written or read).
 * Values are text; reads run mergeDefaults so missing/corrupt entries
 * heal to the defaults. Keys are declared in KEYS and written as a full set.
 */

/** Which terminal "open in terminal" launches. `auto` probes per platform. */
export type TerminalPreset =
  | 'auto'
  // Windows
  | 'wt' // Windows Terminal
  | 'powershell'
  | 'cmd'
  // macOS
  | 'terminal' // Terminal.app
  | 'iterm' // iTerm2
  // Linux
  | 'gnome' // gnome-terminal
  | 'konsole'
  // Windows / macOS / Linux
  | 'wezterm'
  // macOS / Linux only — Ghostty has no Windows build
  | 'ghostty'
  // Arbitrary command template
  | 'custom';

export interface TerminalSettings {
  preset: TerminalPreset;
  /** Template for `custom`; `{path}` is replaced with the quoted directory. */
  customCommand: string;
}

/**
 * UI/CLI language. Machine-level and stored in the daemon settings table so
 * the dashboard and the `weave` CLI read the same value.
 *
 * Extending: add the tag here and to SUPPORTED_LOCALES, then provide the
 * matching web/CLI dictionaries — both are `Record<Locale, …>`, so a new
 * locale without dictionaries fails to compile (by design).
 */
export type Locale = 'zh-CN' | 'en';

/** Registration point for future locales (ja, ko, …). */
export const SUPPORTED_LOCALES: readonly Locale[] = ['zh-CN', 'en'];

export const DEFAULT_LOCALE: Locale = 'zh-CN';

export interface DaemonSettings {
  terminal: TerminalSettings;
  locale: Locale;
  /** D3 hooks 系统总开关（规则级 enabled 另控；关掉后 dispatcher 全量短路）。 */
  hooks: HooksSettings;
  /** 事件日志（hook_events）保留策略——缺省走默认值（读时归一化）。 */
  events?: EventsSettings;
  /** 会话闲置移除策略（无操作 n 天后自动移除）——缺省走默认值（读时归一化）。 */
  sessions?: SessionsSettings;
  /** 开机自启动 daemon（系统级自启动项；缺省关闭——读时归一化）。 */
  startup?: StartupSettings;
  /** 监听面（绑定地址；缺省放开 0.0.0.0——读时归一化）。 */
  server?: ServerSettings;
  /** AI 助手（地址/模型；缺省空 = 未配置——读时归一化）。 */
  ai?: AiSettings;
  /** 决策模型（编排条件边判断；缺省空 = 未配置，判断回落 fork——读时归一化）。 */
  decision?: DecisionSettings;
  /** 对话导出 HTML 的自定义头（多份保存、一份在用——读时归一化）。 */
  htmlExport?: HtmlExportSettings;
}

export interface HooksSettings {
  enabled: boolean;
}

/** hook_events 被动清理保留天数（跨天首条写入时删除更早日志）。 */
export interface EventsSettings {
  retentionDays: number;
}

/** 会话闲置移除保留天数（= lastSeenAt 起算的无操作窗，到期自动移除会话行）。 */
export interface SessionsSettings {
  idleDays: number;
}

/** daemon 是否随系统登录自启（默认关）。 */
export interface StartupSettings {
  launchOnLogin: boolean;
}

/** 监听面设置：绑定地址（默认放开 0.0.0.0，由 dashboard 密码认证兜底；可改回 127.0.0.1）+ HTTPS 端口。 */
export interface ServerSettings {
  bindHost: string;
  /** 局域网 HTTPS 监听端口（自签证书，手机浏览器通知的前提）；0 = 关闭。 */
  tlsPort: number;
}

/**
 * AI 助手（OpenAI 兼容端点）的非密配置。**api key 不在这里**——它落
 * `<dataDir>/ai.json`（0600，见 daemon/ai-config.ts），本表是 UI 可读面。
 */
export interface AiSettings {
  baseUrl: string;
  model: string;
}

/**
 * 决策模型（Jev 兼容 / System One 接口）的非密配置。**api key 不在这里**——
 * 它落 `<dataDir>/decision.json`（0600，见 daemon/decision-config.ts）。
 */
export interface DecisionSettings {
  baseUrl: string;
  model: string;
}

/** 一份「自定义头」：导出 HTML 时里原样注入 `</head>` 之前（内联 style/script/片段）。 */
export interface HtmlExportProfile {
  id: string;
  name: string;
  head: string;
}

/** 对话导出 HTML 的头配置：多份保存、一份在用（activeId 为空 = 不带自定义头）。 */
export interface HtmlExportSettings {
  activeId: string | null;
  profiles: HtmlExportProfile[];
}

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  preset: 'auto',
  customCommand: '',
};

export const DEFAULT_HOOKS_SETTINGS: HooksSettings = { enabled: true };

/** 保留 90 天：与总览「大于30天」档兼容，留足回溯窗口。 */
export const DEFAULT_EVENT_RETENTION_DAYS = 90;

export const DEFAULT_EVENTS_SETTINGS: EventsSettings = {
  retentionDays: DEFAULT_EVENT_RETENTION_DAYS,
};

/** 闲置 90 天移除：与事件日志同界（会话行连同其事件一起走），总览「大于30天」
 *  档仍留有 30-90 天窗口可看；新会话随首个事件即建档，不会被快清误伤。 */
export const DEFAULT_SESSION_IDLE_DAYS = 90;

export const DEFAULT_SESSIONS_SETTINGS: SessionsSettings = {
  idleDays: DEFAULT_SESSION_IDLE_DAYS,
};

export const DEFAULT_STARTUP_SETTINGS: StartupSettings = { launchOnLogin: false };

/** 默认放开绑定（局域网可达）：dashboard 密码认证是这层的兜底。HTTPS 与 HTTP 并存（见 daemon/tls.ts）。 */
export const DEFAULT_SERVER_SETTINGS: ServerSettings = { bindHost: DEFAULT_BIND_HOST, tlsPort: 6443 };

/** 缺省未配置（地址/模型皆空）——助手按钮此时不显示。 */
export const DEFAULT_AI_SETTINGS: AiSettings = { baseUrl: '', model: '' };

/** 缺省未配置——条件边判断此时回落 fork 子 Agent。 */
export const DEFAULT_DECISION_SETTINGS: DecisionSettings = { baseUrl: '', model: '' };

/** 缺省没有头配置（导出不带自定义头）。 */
export const DEFAULT_HTML_EXPORT_SETTINGS: HtmlExportSettings = { activeId: null, profiles: [] };

export const DEFAULT_DAEMON_SETTINGS: DaemonSettings = {
  terminal: DEFAULT_TERMINAL_SETTINGS,
  locale: DEFAULT_LOCALE,
  hooks: DEFAULT_HOOKS_SETTINGS,
  events: DEFAULT_EVENTS_SETTINGS,
  sessions: DEFAULT_SESSIONS_SETTINGS,
  startup: DEFAULT_STARTUP_SETTINGS,
  server: DEFAULT_SERVER_SETTINGS,
  ai: DEFAULT_AI_SETTINGS,
  htmlExport: DEFAULT_HTML_EXPORT_SETTINGS,
};

/** Coerce a stored locale to a supported one (whitelist, never throws). */
export function resolveLocale(raw: unknown): Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(raw as string)
    ? (raw as Locale)
    : DEFAULT_LOCALE;
}

export const ALL_TERMINAL_PRESETS: TerminalPreset[] = [
  'auto',
  'wt',
  'powershell',
  'cmd',
  'terminal',
  'iterm',
  'gnome',
  'konsole',
  'wezterm',
  'ghostty',
  'custom',
];

/** Dropdown entry for the settings modal; only the current platform's
 * presets are offered, so `terminal`/`iterm` never appear on Windows. */
export interface TerminalPresetMeta {
  id: TerminalPreset;
  label: string;
}

const PRESET_LABELS: Record<TerminalPreset, string> = {
  auto: '自动（探测可用终端）',
  wt: 'Windows Terminal',
  powershell: 'PowerShell',
  cmd: '命令提示符 (cmd)',
  terminal: 'Terminal.app',
  iterm: 'iTerm2',
  gnome: 'gnome-terminal',
  konsole: 'Konsole',
  wezterm: 'WezTerm',
  ghostty: 'Ghostty',
  custom: '自定义命令',
};

/** Presets selectable on the given platform (ordered for the dropdown).
 *
 * The list is a superset of what is installed — a preset is offered whenever
 * the terminal *can* run on that platform, since the machine running the
 * dashboard is not necessarily the one the choice is for. Ghostty is macOS and
 * Linux only (no official Windows build), so it is omitted on win32. */
export function terminalPresetsFor(platform: NodeJS.Platform): TerminalPresetMeta[] {
  const ids: TerminalPreset[] =
    platform === 'win32'
      ? ['auto', 'wt', 'wezterm', 'powershell', 'cmd', 'custom']
      : platform === 'darwin'
        ? ['auto', 'terminal', 'iterm', 'wezterm', 'ghostty', 'custom']
        : ['auto', 'gnome', 'konsole', 'wezterm', 'ghostty', 'custom'];
  return ids.map((id) => ({ id, label: PRESET_LABELS[id] }));
}

/** tlsPort 归一：0-65535 的整数（0 = 关闭 HTTPS）；其余（缺省/坏值）回落默认端口。 */
function normalizeTlsPort(raw: unknown): number {
  return Number.isInteger(raw) && (raw as number) >= 0 && (raw as number) <= 65535
    ? (raw as number)
    : DEFAULT_SERVER_SETTINGS.tlsPort;
}

/** 头配置条数/单份 head 的上限（这是「用户填的一段 HTML」，不是无界存储）。 */
const HTML_EXPORT_MAX_PROFILES = 50;
const HTML_EXPORT_MAX_HEAD = 200_000;

/**
 * 头配置归一：只留三字段皆字符串的项、id 去重、名称空则给序号；`activeId` 认不回
 * 任何一项就归 null（导出不带自定义头）。**内容原样保留**——它只在导出文件里注入，
 * 从不进 dashboard 的渲染面。
 */
function normalizeHtmlExport(raw: unknown): HtmlExportSettings {
  const obj = (raw ?? {}) as Partial<HtmlExportSettings>;
  const seen = new Set<string>();
  const profiles: HtmlExportProfile[] = [];
  for (const item of Array.isArray(obj.profiles) ? obj.profiles : []) {
    const p = (item ?? {}) as Partial<HtmlExportProfile>;
    if (typeof p.id !== 'string' || p.id === '' || seen.has(p.id)) continue;
    if (typeof p.name !== 'string' || typeof p.head !== 'string') continue;
    seen.add(p.id);
    profiles.push({
      id: p.id,
      name: p.name.trim() || `profile-${profiles.length + 1}`,
      head: p.head.slice(0, HTML_EXPORT_MAX_HEAD),
    });
    if (profiles.length >= HTML_EXPORT_MAX_PROFILES) break;
  }
  const activeId =
    typeof obj.activeId === 'string' && seen.has(obj.activeId) ? obj.activeId : null;
  return { activeId, profiles };
}

function mergeDefaults(raw: unknown): DaemonSettings {
  const obj = (raw ?? {}) as Partial<DaemonSettings>;
  const term = (obj.terminal ?? {}) as Partial<TerminalSettings>;
  const hooks = (obj.hooks ?? {}) as Partial<HooksSettings>;
  const events = (obj.events ?? {}) as Partial<EventsSettings>;
  const sessions = (obj.sessions ?? {}) as Partial<SessionsSettings>;
  const startup = (obj.startup ?? {}) as Partial<StartupSettings>;
  const server = (obj.server ?? {}) as Partial<ServerSettings>;
  const ai = (obj.ai ?? {}) as Partial<AiSettings>;
  const decision = (obj.decision ?? {}) as Partial<DecisionSettings>;
  const htmlExport = normalizeHtmlExport(obj.htmlExport);
  const retention =
    Number.isInteger(events.retentionDays) && (events.retentionDays as number) >= 1
      ? (events.retentionDays as number)
      : DEFAULT_EVENTS_SETTINGS.retentionDays;
  const idleDays =
    Number.isInteger(sessions.idleDays) && (sessions.idleDays as number) >= 1
      ? (sessions.idleDays as number)
      : DEFAULT_SESSIONS_SETTINGS.idleDays;
  return {
    terminal: {
      preset: ALL_TERMINAL_PRESETS.includes(term.preset as TerminalPreset)
        ? (term.preset as TerminalPreset)
        : DEFAULT_TERMINAL_SETTINGS.preset,
      customCommand: typeof term.customCommand === 'string' ? term.customCommand : '',
    },
    locale: resolveLocale(obj.locale),
    hooks: {
      enabled: typeof hooks.enabled === 'boolean' ? hooks.enabled : DEFAULT_HOOKS_SETTINGS.enabled,
    },
    events: { retentionDays: retention },
    sessions: { idleDays },
    startup: {
      launchOnLogin:
        typeof startup.launchOnLogin === 'boolean'
          ? startup.launchOnLogin
          : DEFAULT_STARTUP_SETTINGS.launchOnLogin,
    },
    server: {
      bindHost:
        typeof server.bindHost === 'string' && server.bindHost.trim() !== ''
          ? server.bindHost.trim()
          : DEFAULT_SERVER_SETTINGS.bindHost,
      tlsPort: normalizeTlsPort(server.tlsPort),
    },
    ai: {
      baseUrl: typeof ai.baseUrl === 'string' ? ai.baseUrl.trim() : '',
      model: typeof ai.model === 'string' ? ai.model.trim() : '',
    },
    decision: {
      baseUrl: typeof decision.baseUrl === 'string' ? decision.baseUrl.trim() : '',
      model: typeof decision.model === 'string' ? decision.model.trim() : '',
    },
    htmlExport,
  };
}

// ---------------------------------------------------------------------------
// 存储：daemon 数据库 settings key-value 表（不写任何配置文件）
// ---------------------------------------------------------------------------

/** 配置 key 约定（读写单点，避免字面量散落）。 */
const KEYS = {
  terminalPreset: 'terminal.preset',
  terminalCustomCommand: 'terminal.customCommand',
  locale: 'locale',
  hooksEnabled: 'hooks.enabled',
  eventRetentionDays: 'events.retentionDays',
  sessionIdleDays: 'sessions.idleDays',
  startupLaunchOnLogin: 'startup.launchOnLogin',
  serverBindHost: 'server.bindHost',
  serverTlsPort: 'server.tlsPort',
  aiBaseUrl: 'ai.baseUrl',
  aiModel: 'ai.model',
  /** 整段 JSON（首个非标量键）：头配置是一组对象，不为它单开表。 */
  htmlExport: 'htmlExport',
} as const;

/** 测试注入（内存库）；null = 未注入。 */
let settingsDb: DatabaseSync | null = null;

/** hooks.enabled 热路径缓存（ingest 每事件读）：键 = 注入库实例，写入即失效。 */
let hooksEnabledCache: { db: DatabaseSync | null; value: boolean } | null = null;

export function setDaemonSettingsDb(db: DatabaseSync | null): void {
  settingsDb = db;
  hooksEnabledCache = null;
}

/**
 * 取库执行：注入库直用（生命周期归注入方）；未注入（CLI/隔离 e2e）开
 * 短连接用完即关——不缓存句柄，避免 Windows 上文件句柄占用阻断清理。
 */
function withDb<T>(fn: (db: DatabaseSync) => T): T {
  if (settingsDb) return fn(settingsDb);
  const db = openDatabase(getDbPath());
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** 全表读为 map（配置体量小，整读即可）。 */
function readMap(db: DatabaseSync): Map<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as {
    key: string;
    value: string;
  }[];
  return new Map(rows.map((r) => [r.key, r.value]));
}

/** map → DaemonSettings：缺 key 不传该段（mergeDefaults 落默认），坏值自愈。 */
function fromMap(map: Map<string, string>): DaemonSettings {
  return mergeDefaults({
    terminal: {
      preset: map.get(KEYS.terminalPreset),
      customCommand: map.get(KEYS.terminalCustomCommand),
    },
    locale: map.get(KEYS.locale),
    ...(map.has(KEYS.hooksEnabled)
      ? { hooks: { enabled: map.get(KEYS.hooksEnabled) === 'true' } }
      : {}),
    ...(map.has(KEYS.eventRetentionDays)
      ? { events: { retentionDays: Number(map.get(KEYS.eventRetentionDays)) } }
      : {}),
    ...(map.has(KEYS.sessionIdleDays)
      ? { sessions: { idleDays: Number(map.get(KEYS.sessionIdleDays)) } }
      : {}),
    ...(map.has(KEYS.startupLaunchOnLogin)
      ? { startup: { launchOnLogin: map.get(KEYS.startupLaunchOnLogin) === 'true' } }
      : {}),
    ...(map.has(KEYS.serverBindHost) || map.has(KEYS.serverTlsPort)
      ? {
          server: {
            ...(map.has(KEYS.serverBindHost) ? { bindHost: map.get(KEYS.serverBindHost)! } : {}),
            ...(map.has(KEYS.serverTlsPort) ? { tlsPort: Number(map.get(KEYS.serverTlsPort)) } : {}),
          },
        }
      : {}),
    ...(map.has(KEYS.aiBaseUrl) || map.has(KEYS.aiModel)
      ? { ai: { baseUrl: map.get(KEYS.aiBaseUrl) ?? '', model: map.get(KEYS.aiModel) ?? '' } }
      : {}),
    // 整段 JSON：坏 JSON 当没有这一段（mergeDefaults 落默认），不让一行脏数据废掉全部设置
    ...(jsonOf(map.get(KEYS.htmlExport)) != null
      ? { htmlExport: jsonOf(map.get(KEYS.htmlExport)) as Partial<HtmlExportSettings> }
      : {}),
  });
}

/** 设置表里的 JSON blob：解析不出（或不是对象）即 null。 */
function jsonOf(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed != null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** DaemonSettings → 全量 key 条目（写入是整体覆盖）。 */
function toEntries(settings: DaemonSettings): [string, string][] {
  return [
    [KEYS.terminalPreset, settings.terminal.preset],
    [KEYS.terminalCustomCommand, settings.terminal.customCommand],
    [KEYS.locale, settings.locale],
    [KEYS.hooksEnabled, String(settings.hooks.enabled)],
    [
      KEYS.eventRetentionDays,
      String(settings.events?.retentionDays ?? DEFAULT_EVENT_RETENTION_DAYS),
    ],
    [
      KEYS.sessionIdleDays,
      String(settings.sessions?.idleDays ?? DEFAULT_SESSION_IDLE_DAYS),
    ],
    [KEYS.startupLaunchOnLogin, String(settings.startup?.launchOnLogin ?? false)],
    [KEYS.serverBindHost, settings.server?.bindHost ?? DEFAULT_BIND_HOST],
    [KEYS.serverTlsPort, String(settings.server?.tlsPort ?? DEFAULT_SERVER_SETTINGS.tlsPort)],
    [KEYS.aiBaseUrl, settings.ai?.baseUrl ?? ''],
    [KEYS.aiModel, settings.ai?.model ?? ''],
    [
      KEYS.htmlExport,
      JSON.stringify(settings.htmlExport ?? DEFAULT_HTML_EXPORT_SETTINGS),
    ],
  ];
}

/** 事务全量 upsert（整体覆盖，避免半套配置）。 */
function writeMap(db: DatabaseSync, entries: [string, string][]): void {
  const stmt = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  db.exec('BEGIN');
  try {
    for (const [key, value] of entries) stmt.run(key, value);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function read(): DaemonSettings {
  try {
    return withDb((db) => fromMap(readMap(db)));
  } catch {
    return DEFAULT_DAEMON_SETTINGS; // 库不可用/表缺行：回默认，绝不抛
  }
}

/** Read daemon settings; missing/corrupt entries fall back to defaults. */
export async function readDaemonSettings(): Promise<DaemonSettings> {
  return read();
}

/**
 * 同步读（hook_events 被动清理用：insert 是同步写路径，且仅跨天首条
 * 写入时读一次）。语义与 readDaemonSettings 一致。
 */
export function readDaemonSettingsSync(): DaemonSettings {
  return read();
}

/**
 * hooks.enabled 快速读（POST /hooks 每事件调用）：进程内唯一写点是
 * writeDaemonSettings（写即失效），故缓存与全量读等值，省一次 SELECT+merge。
 */
export function readHooksEnabled(): boolean {
  const cached = hooksEnabledCache;
  if (cached && cached.db === settingsDb) return cached.value;
  const value = read().hooks.enabled;
  hooksEnabledCache = { db: settingsDb, value };
  return value;
}

/** Persist daemon settings (defaults merged over the input). */
export async function writeDaemonSettings(settings: DaemonSettings): Promise<DaemonSettings> {
  const normalized = mergeDefaults(settings);
  withDb((db) => writeMap(db, toEntries(normalized)));
  hooksEnabledCache = null;
  return normalized;
}
