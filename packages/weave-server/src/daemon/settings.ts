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
  /** 开机自启动 daemon（系统级自启动项；缺省关闭——读时归一化）。 */
  startup?: StartupSettings;
  /** 监听面（绑定地址；缺省放开 0.0.0.0——读时归一化）。 */
  server?: ServerSettings;
}

export interface HooksSettings {
  enabled: boolean;
}

/** hook_events 被动清理保留天数（跨天首条写入时删除更早日志）。 */
export interface EventsSettings {
  retentionDays: number;
}

/** daemon 是否随系统登录自启（默认关）。 */
export interface StartupSettings {
  launchOnLogin: boolean;
}

/** 监听面设置：绑定地址（默认放开 0.0.0.0，由 dashboard 密码认证兜底；可改回 127.0.0.1）。 */
export interface ServerSettings {
  bindHost: string;
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

export const DEFAULT_STARTUP_SETTINGS: StartupSettings = { launchOnLogin: false };

/** 默认放开绑定（局域网可达）：dashboard 密码认证是这层的兜底。 */
export const DEFAULT_SERVER_SETTINGS: ServerSettings = { bindHost: DEFAULT_BIND_HOST };

export const DEFAULT_DAEMON_SETTINGS: DaemonSettings = {
  terminal: DEFAULT_TERMINAL_SETTINGS,
  locale: DEFAULT_LOCALE,
  hooks: DEFAULT_HOOKS_SETTINGS,
  events: DEFAULT_EVENTS_SETTINGS,
  startup: DEFAULT_STARTUP_SETTINGS,
  server: DEFAULT_SERVER_SETTINGS,
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

function mergeDefaults(raw: unknown): DaemonSettings {
  const obj = (raw ?? {}) as Partial<DaemonSettings>;
  const term = (obj.terminal ?? {}) as Partial<TerminalSettings>;
  const hooks = (obj.hooks ?? {}) as Partial<HooksSettings>;
  const events = (obj.events ?? {}) as Partial<EventsSettings>;
  const startup = (obj.startup ?? {}) as Partial<StartupSettings>;
  const server = (obj.server ?? {}) as Partial<ServerSettings>;
  const retention =
    Number.isInteger(events.retentionDays) && (events.retentionDays as number) >= 1
      ? (events.retentionDays as number)
      : DEFAULT_EVENTS_SETTINGS.retentionDays;
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
    },
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
  startupLaunchOnLogin: 'startup.launchOnLogin',
  serverBindHost: 'server.bindHost',
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
    ...(map.has(KEYS.startupLaunchOnLogin)
      ? { startup: { launchOnLogin: map.get(KEYS.startupLaunchOnLogin) === 'true' } }
      : {}),
    ...(map.has(KEYS.serverBindHost) ? { server: { bindHost: map.get(KEYS.serverBindHost)! } } : {}),
  });
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
    [KEYS.startupLaunchOnLogin, String(settings.startup?.launchOnLogin ?? false)],
    [KEYS.serverBindHost, settings.server?.bindHost ?? DEFAULT_BIND_HOST],
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
