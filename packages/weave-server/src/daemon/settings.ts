import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { getDataDir } from '../db/paths.js';

/**
 * Daemon-level settings (as opposed to per-project or harness settings):
 * machine-local preferences for the dashboard itself. Currently only the
 * terminal used by "open in terminal" lives here.
 *
 * Stored as `<configDir>/weave/settings.json` next to the daemon database —
 * plain JSON, read-modify-write, defaults merged on read (same pattern as the
 * statusline config).
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
 * UI/CLI language. Machine-level and stored in daemon settings.json so the
 * dashboard and the `weave` CLI read the same value.
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
}

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  preset: 'auto',
  customCommand: '',
};

export const DEFAULT_DAEMON_SETTINGS: DaemonSettings = {
  terminal: DEFAULT_TERMINAL_SETTINGS,
  locale: DEFAULT_LOCALE,
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
  return {
    terminal: {
      preset: ALL_TERMINAL_PRESETS.includes(term.preset as TerminalPreset)
        ? (term.preset as TerminalPreset)
        : DEFAULT_TERMINAL_SETTINGS.preset,
      customCommand: typeof term.customCommand === 'string' ? term.customCommand : '',
    },
    locale: resolveLocale(obj.locale),
  };
}

/** Settings directory; overridable for tests (defaults to the weave data dir). */
let settingsDir: string | null = null;

/** Point the settings file elsewhere (tests use a temp dir). */
export function setDaemonSettingsDir(dir: string | null): void {
  settingsDir = dir;
}

/** Settings file path (`<configDir>/weave/settings.json`). */
function settingsPath(): string {
  return path.join(settingsDir ?? getDataDir(), 'settings.json');
}

/** Read daemon settings; missing/corrupt file falls back to defaults. */
export async function readDaemonSettings(): Promise<DaemonSettings> {
  try {
    const raw = await readFile(settingsPath(), 'utf-8');
    return mergeDefaults(JSON.parse(raw));
  } catch {
    return DEFAULT_DAEMON_SETTINGS;
  }
}

/** Persist daemon settings (defaults merged over the input). */
export async function writeDaemonSettings(settings: DaemonSettings): Promise<DaemonSettings> {
  const normalized = mergeDefaults(settings);
  await mkdir(getDataDir(), { recursive: true });
  await writeFile(settingsPath(), `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
  return normalized;
}
