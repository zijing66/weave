/** statusline 域：块词表、颜色、格式模板与配置（mirror of server statusline/config.ts）。 */

export type StatuslineNamedColor =
  | 'gray'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan';

/**
 * Mirror of `StatuslineColor` in packages/weave-server/src/statusline/config.ts.
 * The web app does not depend on @weavecode/server, so this file is a hand-copied
 * duplicate — keep the two in lockstep (a mismatch breaks `tsc && vite build`).
 * A colour is a named ANSI colour, `ansi256:0-255`, or `#rgb`/`#rrggbb`.
 */
export type StatuslineColor = StatuslineNamedColor | `ansi256:${number}` | `#${string}`;

/** The seven classic ANSI names, in palette order. */
export const NAMED_COLORS: readonly StatuslineNamedColor[] = [
  'gray',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
];

export type SegmentKey =
  | 'project'
  | 'git'
  | 'git_user'
  | 'changes'
  | 'model'
  | 'thinking'
  | 'context'
  | 'tokens'
  | 'cost'
  | 'rate'
  | 'time'
  | 'version'
  | 'output_style'
  | 'session'
  | 'exceeds200k'
  | 'fast_mode'
  | 'vim'
  | 'pr'
  | 'worktree'
  | 'agent';

export interface StatuslineSegment {
  enabled: boolean;
  color: StatuslineColor;
  bold: boolean;
  /** Optional emoji/symbol prefix (e.g. `🤖`, `🌿`, `📁`). Empty when unused. */
  icon: string;
  /** Solid background block colour; `null` for foreground only. */
  backgroundColor: StatuslineColor | null;
  /** Join this segment into the next block (no gap, inherited background). */
  merge: boolean;
  /** Context-bar display mode; ignored by other segments. */
  style?: 'percent' | 'bar' | 'both';
  /** Static prefix, rendered as `<label><labelSeparator><value>`. */
  label?: string;
  /** `{token}` value template; replaces the built-in formatting when set. */
  format?: string;
  /** `tokens` only: session-cumulative or context-window count. */
  metric?: 'session' | 'context';
  /** Which rate-limit window `rate` reports; ignored by other segments. */
  window?: 'five_hour' | 'seven_day' | 'spend';
}

/** Progress-bar appearance; global rather than per-segment. */
export interface StatuslineBar {
  cells: number;
  fill: string;
  empty: string;
}

export type StatuslineAlign = 'left' | 'center' | 'right';
export type StatuslineSource = 'global' | 'custom';

/**
 * Mirror of `WEAVE_VERSION` in packages/weave-server/src/version.ts — the web
 * app stamps the same version into the logo preview as the generator does.
 * Keep in lockstep with that file and the workspace package manifests.
 */
export const WEAVE_VERSION = '0.1.0';

export interface StatuslineConfig {
  separator: string;
  align: StatuslineAlign;
  /** Row-0 logo text, rendered as `<logoText> v<version>`. Not optional. */
  logoText: string;
  logoColor: StatuslineColor;
  /** Nerd-Font glyph set; `undefined` = classic triangle defaults, '' disables a cap. */
  powerline: { enabled: boolean; separator?: string; startCap?: string; endCap?: string };
  /** Ordered rows; each row is the left-to-right segment order of that line. */
  lines: SegmentKey[][];
  /** Seconds between Claude Code re-runs of the script (min 1). */
  refreshInterval: number;
  /** Follow the global template, or keep a project-local config. */
  source: StatuslineSource;
  /** Progress-bar appearance, shared by every segment that draws a bar. */
  bar: StatuslineBar;
  /** Rendered between rows; an empty string (the default) draws nothing. */
  divider: string;
  /** Rendered between a segment's `label` and its value. */
  labelSeparator: string;
  segments: Record<SegmentKey, StatuslineSegment>;
}

/** Mirror of `SEGMENT_TOKENS` in the server's statusline/config.ts. */
export const SEGMENT_TOKENS: Record<SegmentKey, readonly string[]> = {
  project: ['name', 'path'],
  git: ['branch', 'repo', 'ahead', 'behind', 'sync'],
  git_user: ['user', 'email'],
  changes: ['added', 'deleted', 'files'],
  model: ['model'],
  thinking: ['level'],
  context: ['bar', 'used', 'total', 'percent', 'remaining'],
  tokens: ['total', 'percent'],
  cost: ['cost', 'duration', 'api_duration', 'lines_added', 'lines_removed'],
  rate: ['percent', 'limit', 'resets'],
  time: ['time'],
  version: ['version'],
  output_style: ['style'],
  session: ['name'],
  exceeds200k: ['over'],
  fast_mode: ['mode'],
  vim: ['mode'],
  pr: ['number', 'state', 'url'],
  worktree: ['name', 'branch'],
  agent: ['name'],
};

/** Mirror of `SEGMENT_DEFAULT_FORMAT` in the server's statusline/config.ts. */
export const SEGMENT_DEFAULT_FORMAT: Record<SegmentKey, string> = {
  project: '{name}',
  git: '{branch} {sync}',
  git_user: '{user} <{email}>',
  changes: '{files}',
  model: '{model}',
  thinking: '{level}',
  context: '{percent}% {bar}',
  tokens: '{total}',
  cost: '{cost}',
  rate: '{limit} {percent}%',
  time: '{time}',
  version: '{version}',
  output_style: '{style}',
  session: '{name}',
  exceeds200k: '{over}',
  fast_mode: '{mode}',
  vim: '{mode}',
  pr: '#{number}',
  worktree: '{name}',
  agent: '{name}',
};

/** Mirror of `CONTEXT_STYLE_FORMAT`: legacy `context.style` → template. */
export const CONTEXT_STYLE_FORMAT: Record<'percent' | 'bar' | 'both', string> = {
  percent: '{percent}%',
  bar: '{bar}',
  both: '{percent}% {bar}',
};
