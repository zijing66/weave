import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_STATUSLINE_CONFIG,
  LEGACY_IDENTITY_LINE,
  LEGACY_METRICS_LINE,
  NAMED_COLORS,
  SEGMENT_ORDER,
  type StatuslineConfig,
  type StatuslineColor,
  type StatuslineBar,
  type StatuslineSegment,
  type SegmentKey,
} from './config.js';
import { generateStatuslineScript } from './generator.js';

/**
 * Statusline manager — persists the config (project-local or global default),
 * regenerates the script, and keeps `settings.json`'s `statusLine` pointed at
 * it. All filesystem ops: the watch service observes `.claude/helpers/` and
 * `.weave/`, so writes flow back to the dashboard via SSE without an explicit
 * push.
 *
 * Config sourcing: a project either follows the global default template
 * (`source: 'global'`, the default) or keeps its own local config
 * (`source: 'custom'`). When following global, the project file only stores
 * `{source:'global'}` and the script is generated from the global template —
 * so editing the global config automatically re-renders every following
 * project (auto-sync is per-project by construction).
 */

const WEAVE_DIR = '.weave';
const STATUSLINE_FILE = 'statusline.json';
const HELPERS_DIR = '.claude/helpers';
const STATUSLINE_SCRIPT = 'statusline.cjs';
const SETTINGS_FILE = '.claude/settings.json';
const GLOBAL_STATUSLINE_FILE = 'statusline.json';

/** Directory for the global template; overridable for tests (defaults to ~/.weave). */
let globalStatuslineDir = path.join(homedir(), '.weave');

/** Point the global template directory elsewhere (tests use a temp dir). */
export function setGlobalStatuslineDir(dir: string): void {
  globalStatuslineDir = dir;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// --- global default template (~/.weave/statusline.json) ---

/** Read the user's global statusline template; falls back to the default. */
export async function readGlobalStatuslineConfig(): Promise<StatuslineConfig> {
  try {
    const raw = await readFile(
      path.join(globalStatuslineDir, GLOBAL_STATUSLINE_FILE),
      'utf-8',
    );
    const cfg = mergeDefaults(JSON.parse(raw) as Partial<StatuslineConfig>);
    return { ...cfg, source: 'global' };
  } catch {
    return DEFAULT_STATUSLINE_CONFIG;
  }
}

/** Persist the global statusline template (source is always `global`). */
export async function writeGlobalStatuslineConfig(
  config: StatuslineConfig,
): Promise<void> {
  await mkdir(globalStatuslineDir, { recursive: true });
  const normalized = { ...mergeDefaults(config as Partial<StatuslineConfig>), source: 'global' };
  await writeFile(
    path.join(globalStatuslineDir, GLOBAL_STATUSLINE_FILE),
    `${JSON.stringify(normalized, null, 2)}\n`,
    'utf-8',
  );
}

// --- project-local config ---

/**
 * Read the project's effective statusline config. A project with no local
 * override (or one that stores `source: 'global'`) resolves to the global
 * template; a `source: 'custom'` project resolves to its own local config.
 */
export async function readStatuslineConfig(projectPath: string): Promise<StatuslineConfig> {
  const globalCfg = await readGlobalStatuslineConfig();
  try {
    const raw = await readFile(path.join(projectPath, WEAVE_DIR, STATUSLINE_FILE), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StatuslineConfig>;
    if (parsed.source === 'custom') {
      return mergeDefaults(parsed);
    }
    return globalCfg;
  } catch {
    return globalCfg;
  }
}

/**
 * Persist the project statusline config. Following projects (source `global`)
 * only store the source marker — the script is generated from the global
 * template, so global edits propagate automatically.
 */
export async function writeStatuslineConfig(
  projectPath: string,
  config: StatuslineConfig,
): Promise<void> {
  const dir = path.join(projectPath, WEAVE_DIR);
  await mkdir(dir, { recursive: true });
  const source = config.source ?? 'global';
  const payload =
    source === 'global'
      ? { source: 'global' as const }
      : mergeDefaults(config as Partial<StatuslineConfig>);
  await writeFile(
    path.join(dir, STATUSLINE_FILE),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf-8',
  );
}

/** Write the generated statusline script, creating the helpers dir if needed. */
export async function writeStatuslineScript(projectPath: string, script: string): Promise<string> {
  const dir = path.join(projectPath, HELPERS_DIR);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, STATUSLINE_SCRIPT);
  await writeFile(file, script, 'utf-8');
  return file;
}

/** Read the generated statusline script (empty string if absent). */
export async function readStatuslineScript(projectPath: string): Promise<string> {
  try {
    return await readFile(path.join(projectPath, HELPERS_DIR, STATUSLINE_SCRIPT), 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Ensure `.claude/settings.json` has a `statusLine` entry pointing at the
 * statusline script, with a `refreshInterval` (seconds) so Claude Code re-runs
 * it on a timer during idle periods — updates after each assistant response
 * are event-driven by Claude Code itself and need no weave-side polling.
 * Preserves all other settings. Idempotent.
 */
export async function ensureSettingsStatusLine(
  projectPath: string,
  refreshInterval = 10,
): Promise<void> {
  const file = path.join(projectPath, SETTINGS_FILE);
  const isWindows = process.platform === 'win32';
  let settings: Record<string, unknown> = {};
  if (await pathExists(file)) {
    try {
      settings = JSON.parse(await readFile(file, 'utf-8')) as Record<string, unknown>;
    } catch {
      settings = {};
    }
  }
  const scriptPath = path.join(projectPath, HELPERS_DIR, STATUSLINE_SCRIPT);
  const command = isWindows ? `node "${scriptPath}"` : `node ${scriptPath}`;
  settings['statusLine'] = {
    type: 'command',
    command,
    padding: 0,
    refreshInterval: Math.max(1, Math.round(refreshInterval)),
  };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
}

/**
 * Apply a statusline config to a project: persist it, regenerate the script
 * (from the project's effective config), and keep `settings.json` pointed at
 * the script. The watch service picks up the writes.
 */
export async function applyStatuslineConfig(
  projectPath: string,
  config: StatuslineConfig,
): Promise<void> {
  await writeStatuslineConfig(projectPath, config);
  const effective =
    (config.source ?? 'global') === 'global'
      ? await readGlobalStatuslineConfig()
      : mergeDefaults(config as Partial<StatuslineConfig>);
  const script = generateStatuslineScript(effective);
  await writeStatuslineScript(projectPath, script);
  await ensureSettingsStatusLine(projectPath, effective.refreshInterval);
}

/**
 * Migrate a possibly-legacy config to the `lines` model: configs that predate
 * `lines` carried `layout` + `order` (single = one full row; multi = the old
 * identity + metrics split). Every segment key must appear in some row so a
 * segment checked on in the panel is always renderable — a LEGACY migration
 * appends any missing keys to the first row. An explicit `lines` value is
 * trusted verbatim (deduped, unknown keys dropped): the panel lets users
 * remove a capsule from every row, and that must survive a save/reload.
 */
/** Legacy on-disk shape (predates `lines`): `layout` + `order`. Kept only for
 * migration, so it is intentionally wider than the current StatuslineConfig. */
type LegacyStatuslineConfig = Partial<StatuslineConfig> & {
  order?: SegmentKey[];
  layout?: 'single' | 'multi';
};

function normalizeLines(parsed: LegacyStatuslineConfig): SegmentKey[][] {
  let lines: SegmentKey[][];
  // Only migrations force full coverage; an explicit `lines` value is the
  // user's arrangement and may legitimately omit keys (unplaced capsules).
  let seededFromLegacy = false;
  if (parsed.lines?.length) {
    lines = parsed.lines.map((r) => [...r]);
  } else if (parsed.order?.length) {
    seededFromLegacy = true;
    const order = parsed.order;
    if (parsed.layout === 'multi') {
      lines = [
        LEGACY_IDENTITY_LINE.filter((k) => order.includes(k)),
        LEGACY_METRICS_LINE.filter((k) => order.includes(k)),
      ].filter((l) => l.length > 0);
    } else {
      lines = [order];
    }
  } else {
    seededFromLegacy = true;
    lines = DEFAULT_STATUSLINE_CONFIG.lines.map((r) => [...r]);
  }
  // Known keys only, each at most once across all rows (first row wins).
  const seen = new Set<SegmentKey>();
  lines = lines.map((row) =>
    row.filter((k) => {
      if (!SEGMENT_ORDER.includes(k)) return false;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }),
  );
  if (lines.length === 0) lines = [[]];
  if (seededFromLegacy) {
    const missing = SEGMENT_ORDER.filter((k) => !seen.has(k));
    if (missing.length) lines[0] = [...lines[0], ...missing];
  }
  return lines;
}

const HEX6 = /^#[0-9a-fA-F]{6}$/;
const HEX3 = /^#([0-9a-fA-F]{3})$/;
const ANSI256 = /^ansi256:(\d{1,3})$/;

/**
 * Coerce a stored colour to a valid one, falling back when it is malformed.
 * Accepts the seven names, `ansi256:0-255`, and `#rgb` / `#rrggbb` (3-digit
 * hex is expanded so downstream code only ever sees 6-digit form).
 *
 * Values are validated here rather than in the generator because a bad colour
 * must never reach a written config — the generated script has a hard fallback
 * (`37`), so an invalid value would otherwise fail silently.
 */
function normalizeColor(value: unknown, fallback: StatuslineColor): StatuslineColor {
  if (typeof value !== 'string') return fallback;
  if ((NAMED_COLORS as readonly string[]).includes(value)) {
    return value as StatuslineColor;
  }
  const indexed = ANSI256.exec(value);
  if (indexed) {
    const n = Number(indexed[1]);
    if (n >= 0 && n <= 255) return `ansi256:${n}`;
    return fallback;
  }
  if (HEX6.test(value)) return value.toLowerCase() as StatuslineColor;
  const short = HEX3.exec(value);
  if (short) {
    const [, h] = short;
    return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`.toLowerCase() as StatuslineColor;
  }
  return fallback;
}

/** Merge a stored segment over its default, validating the colour fields. */
function normalizeSegment(raw: unknown, base: StatuslineSegment): StatuslineSegment {
  if (!raw || typeof raw !== 'object') return { ...base };
  const p = raw as Partial<StatuslineSegment>;
  const merged: StatuslineSegment = {
    ...base,
    ...p,
    color: normalizeColor(p.color, base.color),
    backgroundColor:
      p.backgroundColor == null ? null : normalizeColor(p.backgroundColor, base.backgroundColor ?? 'gray'),
  };
  // Empty strings mean "unset" for the optional text fields — storing '' would
  // otherwise render a bare labelSeparator with no label.
  if (typeof p.label !== 'string' || p.label === '') delete merged.label;
  if (typeof p.format !== 'string' || p.format === '') delete merged.format;
  if (p.metric !== 'session' && p.metric !== 'context') delete merged.metric;
  return merged;
}

/** Clamp a stored bar into range; malformed glyph fields fall back. */
function normalizeBar(raw: unknown): StatuslineBar {
  const base = DEFAULT_STATUSLINE_CONFIG.bar;
  if (!raw || typeof raw !== 'object') return { ...base };
  const b = raw as Partial<StatuslineBar>;
  const cells = Math.round(Number(b.cells));
  return {
    cells: Number.isFinite(cells) ? Math.max(1, Math.min(40, cells)) : base.cells,
    fill: typeof b.fill === 'string' && b.fill !== '' ? b.fill : base.fill,
    empty: typeof b.empty === 'string' && b.empty !== '' ? b.empty : base.empty,
  };
}

function mergeDefaults(parsed: Partial<StatuslineConfig>): StatuslineConfig {
  const segments = { ...DEFAULT_STATUSLINE_CONFIG.segments };
  for (const key of Object.keys(segments) as (keyof typeof segments)[]) {
    segments[key] = normalizeSegment(parsed.segments?.[key], segments[key]);
  }
  const interval = parsed.refreshInterval;
  return {
    separator: parsed.separator ?? DEFAULT_STATUSLINE_CONFIG.separator,
    align: parsed.align ?? DEFAULT_STATUSLINE_CONFIG.align,
    // `showLogo` from older configs is intentionally dropped: the logo is no
    // longer optional, and carrying a dead field would confuse the panel.
    logoText: parsed.logoText ?? DEFAULT_STATUSLINE_CONFIG.logoText,
    logoColor: normalizeColor(parsed.logoColor, DEFAULT_STATUSLINE_CONFIG.logoColor),
    powerline: {
      // spread keeps the optional glyph fields (separator/startCap/endCap);
      // undefined means "classic triangle defaults" downstream
      ...parsed.powerline,
      enabled: parsed.powerline?.enabled ?? DEFAULT_STATUSLINE_CONFIG.powerline.enabled,
    },
    lines: normalizeLines(parsed),
    refreshInterval:
      interval != null && interval >= 1 ? interval : DEFAULT_STATUSLINE_CONFIG.refreshInterval,
    source: parsed.source ?? DEFAULT_STATUSLINE_CONFIG.source,
    bar: normalizeBar(parsed.bar),
    divider: typeof parsed.divider === 'string' ? parsed.divider : DEFAULT_STATUSLINE_CONFIG.divider,
    labelSeparator:
      typeof parsed.labelSeparator === 'string'
        ? parsed.labelSeparator
        : DEFAULT_STATUSLINE_CONFIG.labelSeparator,
    segments,
  };
}
