/**
 * Statusline configuration — which segments a project's statusline renders, in
 * what colour/style, and how they are laid out.
 *
 * Stored per-project as `.weave/statusline.json`; a global default template
 * lives at `~/.weave/statusline.json`. The generator embeds the effective
 * config into `helpers/statusline.cjs` so the script is self-contained.
 *
 * Layout model (informed by ruflo's statusline + ccstatusline):
 *   - `lines` : an ordered list of rows; each row is the left-to-right segment
 *               order of that line (draggable in the panel, across rows too).
 *               Rows are separated by a dim divider; the logo prefixes row 0.
 *   - `refreshInterval`: how often (seconds, min 1) Claude Code re-runs the
 *               generated script during idle periods. Updates are driven by
 *               Claude Code's own mechanism — the script is a one-shot command
 *               re-invoked after each assistant response (~300ms debounce)
 *               plus this timer; default 10s.
 *
 * When `powerline.enabled`, segments render as solid background blocks that
 * join edge-to-edge (ccstatusline-style), each optionally prefixed by an icon.
 * `align` pads the line so the content sits left, centre, or right.
 *
 * Segment data comes straight from Claude Code's statusline stdin JSON
 * (`context_window.used_percentage`, `rate_limits.five_hour.used_percentage`,
 * `effort.level`, `cost.total_cost_usd`, …), so the generated script needs no
 * external daemon — it re-reads stdin on every render, which is the
 * auto-refresh mechanism.
 */

export type StatuslineNamedColor =
  | 'gray'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan';

/**
 * A colour is one of the seven ANSI names (classic SGR 31-36/90), an indexed
 * 256-colour value (`ansi256:196` → `38;5;196`), or a truecolor hex value
 * (`#ff8800` / `#f80` → `38;2;…`).
 *
 * The template-literal union keeps the seven names autocompletable while still
 * admitting the extended encodings. It is deliberately permissive — anything
 * shaped like a hex string type-checks — so `normalizeColor` in the manager is
 * what actually validates values at rest.
 */
export type StatuslineColor =
  | StatuslineNamedColor
  | `ansi256:${number}`
  | `#${string}`;

/** The seven classic ANSI colour names, in palette order. */
export const NAMED_COLORS: readonly StatuslineNamedColor[] = [
  'gray',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
];

/** All renderable segment kinds (maps to ccstatusline's data segments). */
export type SegmentKey =
  | 'project' // current-working-dir basename
  | 'git' // git-branch
  | 'changes' // git-changes (uncommitted file count)
  | 'model'
  | 'thinking' // thinking-effort
  | 'context' // context-bar (used % + optional progress bar)
  | 'tokens' // tokens-total
  | 'cost' // session-cost
  | 'rate' // rate-limit used %
  | 'time';

export interface StatuslineSegment {
  enabled: boolean;
  color: StatuslineColor;
  /** Render the segment in bold ANSI (`\x1b[1;…m`). */
  bold: boolean;
  /** Optional emoji/symbol prefix (e.g. `🤖`, `🌿`, `📁`). Empty when unused. */
  icon: string;
  /** Solid background block colour; `null` for no background (foreground only). */
  backgroundColor: StatuslineColor | null;
  /** Join this segment into the next block (no gap, inherited background). */
  merge: boolean;
  /** Context-bar display mode; ignored by other segments. */
  style?: 'percent' | 'bar' | 'both';
  /**
   * Static text prefix, rendered as `<label><labelSeparator><value>` — e.g.
   * `label: 'Cost'` yields `Cost: $0.45`. Empty/absent means no prefix, which
   * is the behaviour every config had before labels existed.
   */
  label?: string;
  /**
   * Value template with `{token}` placeholders (see `SEGMENT_TOKENS` for the
   * tokens each segment exposes). When set it replaces the built-in formatting
   * for that segment; when absent the segment falls back to its legacy
   * rendering, so existing configs are unaffected.
   *
   * e.g. `context.format = "[{bar}] {used}/{total} ({percent}%)"`
   */
  format?: string;
  /**
   * Which quantity the `tokens` segment reports: `session` (cumulative tokens
   * for the whole session, read from the transcript) or `context` (tokens
   * currently in the context window). Ignored by other segments.
   */
  metric?: 'session' | 'context';
}

/**
 * Progress-bar appearance. Global rather than per-segment: a statusline reads
 * as one design, and the reference layout uses a single bar style throughout.
 */
export interface StatuslineBar {
  /** Number of cells, clamped to 1-40. */
  cells: number;
  /** Filled-cell glyph. */
  fill: string;
  /** Empty-cell glyph. */
  empty: string;
}

export type StatuslineAlign = 'left' | 'center' | 'right';
/** `global` = follow the global default template; `custom` = project-local. */
export type StatuslineSource = 'global' | 'custom';

/**
 * Powerline glyph configuration. All glyph fields are optional Nerd-Font
 * characters; `undefined` falls back to the classic triangle set and an empty
 * string disables that glyph (caps only — the join separator is never empty).
 */
export interface StatuslinePowerline {
  enabled: boolean;
  /** Block-join separator between adjacent blocks (default `` U+E0B0). */
  separator?: string;
  /** Row-start cap, painted in the first block's bg on a transparent
   * background (default `` U+E0B2). Empty string disables. */
  startCap?: string;
  /** Row-end cap, painted in the last block's bg (default `` U+E0B0).
   * Empty string disables. */
  endCap?: string;
}

/** Classic triangle glyph set, used when the config leaves a field unset. */
export const POWERLINE_DEFAULT_GLYPHS = {
  separator: '',
  startCap: '',
  endCap: '',
} as const;

export interface StatuslineConfig {
  /** Separator rendered between segments within a line (ignored in powerline mode). */
  separator: string;
  /** Where the rendered line(s) sit within the terminal width. */
  align: StatuslineAlign;
  /**
   * Text of the row-0 logo mark, rendered as `<logoText> v<version>`. The logo
   * itself is not optional — it identifies the line as weave's and carries the
   * version that generated the script.
   */
  logoText: string;
  /** Colour of the logo mark. */
  logoColor: StatuslineColor;
  /** ccstatusline-style solid background blocks. */
  powerline: StatuslinePowerline;
  /**
   * Ordered lines; each line is the left-to-right segment order of that row.
   * The panel adds/removes lines and reorders segments within/across them.
   * Rows are separated by a dim divider; the logo prefixes the first row.
   */
  lines: SegmentKey[][];
  /**
   * How often Claude Code re-runs the statusline script (seconds, min 1).
   * Event-driven updates (after each assistant response) happen regardless;
   * this timer only bounds staleness during idle periods. Default 10s.
   */
  refreshInterval: number;
  /** Project config origin: follow the global template, or project-local. */
  source: StatuslineSource;
  /** Progress-bar appearance, shared by every segment that draws a bar. */
  bar: StatuslineBar;
  /** Rendered between rows; an empty string (the default) draws nothing. */
  divider: string;
  /** Rendered between a segment's `label` and its value. Default `': '`. */
  labelSeparator: string;
  segments: Record<SegmentKey, StatuslineSegment>;
}

/** Default order in which enabled segments render left-to-right. */
export const SEGMENT_ORDER: SegmentKey[] = [
  'project',
  'git',
  'changes',
  'model',
  'thinking',
  'context',
  'tokens',
  'cost',
  'rate',
  'time',
];

/**
 * Legacy two-row split (single header + metrics) used to migrate old configs
 * that had `layout: 'multi'`.
 */
export const LEGACY_IDENTITY_LINE: SegmentKey[] = ['project', 'git', 'model'];
export const LEGACY_METRICS_LINE: SegmentKey[] = ['context', 'tokens', 'cost', 'rate'];

const seg = (over: Partial<StatuslineSegment>): StatuslineSegment => ({
  enabled: true,
  color: 'gray',
  bold: false,
  icon: '',
  backgroundColor: null,
  merge: false,
  ...over,
});

/**
 * The shipped default: two powerline rows with text labels and a bracketed
 * context bar.
 *
 * ```
 * 🤖 Model: deepseek-flash[1M] 🧠 [░░░░░░░░░░░░] 39k/1.0M (4%) 🌿 main ✏️ (+1, -1)
 * 🧩 Thinking: high 💸 Cost: $0.45 🔢 Total: 960.9k 📁 D:\…\weave-cli
 * ```
 *
 * Needs a Nerd Font for the powerline joins; `PLAIN_STATUSLINE_CONFIG` is the
 * same layout without them.
 */
export const DEFAULT_STATUSLINE_CONFIG: StatuslineConfig = {
  separator: ' ',
  align: 'left',
  logoText: '▊ weave',
  logoColor: 'magenta',
  powerline: { enabled: true, separator: '\ue0b0', startCap: '\ue0b2', endCap: '\ue0b0' },
  lines: [
    ['model', 'context', 'git', 'changes'],
    // rate/time sit here rather than in row 0 so the first row matches the
    // reference layout exactly; both are disabled out of the box.
    ['thinking', 'cost', 'tokens', 'project', 'rate', 'time'],
  ],
  refreshInterval: 10,
  source: 'global',
  bar: { cells: 12, fill: '█', empty: '░' },
  divider: '',
  labelSeparator: ': ',
  segments: {
    model: seg({
      color: '#1f2335',
      backgroundColor: '#7aa2f7',
      bold: true,
      icon: '🤖',
      label: 'Model',
    }),
    context: seg({
      color: '#c0caf5',
      backgroundColor: '#24283b',
      icon: '🧠',
      format: '[{bar}] {used}/{total} ({percent}%)',
    }),
    git: seg({ color: '#1f2335', backgroundColor: '#9ece6a', icon: '🌿', format: '{branch}' }),
    changes: seg({
      color: '#1f2335',
      backgroundColor: '#e0af68',
      icon: '✏️',
      format: '(+{added}, -{deleted})',
    }),
    thinking: seg({
      color: '#1f2335',
      backgroundColor: '#bb9af7',
      icon: '🧩',
      label: 'Thinking',
    }),
    cost: seg({ color: '#1f2335', backgroundColor: '#73daca', icon: '💸', label: 'Cost' }),
    tokens: seg({
      color: '#1f2335',
      backgroundColor: '#ff9e64',
      icon: '🔢',
      label: 'Total',
      metric: 'session',
    }),
    project: seg({
      color: '#c0caf5',
      backgroundColor: '#2f334d',
      icon: '📁',
      format: '{path}',
    }),
    rate: seg({ enabled: false, color: '#f7768e', icon: '⚡', label: 'Rate' }),
    time: seg({ enabled: false, color: 'gray', icon: '🕒' }),
  },
};

/**
 * The same layout with powerline blocks turned off, for terminals without a
 * Nerd Font — segments fall back to the plain separator and no private-use
 * glyphs are emitted.
 */
export const PLAIN_STATUSLINE_CONFIG: StatuslineConfig = {
  ...DEFAULT_STATUSLINE_CONFIG,
  powerline: { enabled: false },
};

/**
 * Tokens each segment exposes to `StatuslineSegment.format`. Exported so the
 * web panel and the CLI preview can offer the same vocabulary the generator
 * understands — keep in lockstep with `segmentTokens` in `generator.ts`.
 */
export const SEGMENT_TOKENS: Record<SegmentKey, readonly string[]> = {
  project: ['name', 'path'],
  git: ['branch'],
  changes: ['added', 'deleted', 'files'],
  model: ['model'],
  thinking: ['level'],
  context: ['bar', 'used', 'total', 'percent', 'remaining'],
  tokens: ['total', 'percent'],
  cost: ['cost'],
  rate: ['percent', 'limit', 'resets'],
  time: ['time'],
};

/**
 * Built-in value formatting per segment, used when `format` is unset. Each one
 * reproduces the rendering the generator hard-coded before `format` existed, so
 * an untouched config produces byte-identical output.
 *
 * `context` is special-cased in the generator: its legacy output depended on
 * `style`, so `DEFAULT_CONTEXT_FORMAT` below covers all three modes instead.
 */
export const SEGMENT_DEFAULT_FORMAT: Record<SegmentKey, string> = {
  project: '{name}',
  git: '{branch}',
  changes: '{files}',
  model: '{model}',
  thinking: '{level}',
  context: '{percent}% {bar}',
  tokens: '{total}',
  cost: '{cost}',
  rate: '5h {percent}%',
  time: '{time}',
};

/** Legacy `context.style` → template, preserving each mode's old rendering. */
export const CONTEXT_STYLE_FORMAT: Record<'percent' | 'bar' | 'both', string> = {
  percent: '{percent}%',
  bar: '{bar}',
  both: '{percent}% {bar}',
};
