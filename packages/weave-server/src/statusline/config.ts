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
 *   - `refreshInterval`: how often Claude Code re-runs the generated script so
 *               changes take effect live (Claude Code minimum is 1 second).
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

export type StatuslineColor =
  | 'gray'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan';

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
}

export type StatuslineAlign = 'left' | 'center' | 'right';
/** `global` = follow the global default template; `custom` = project-local. */
export type StatuslineSource = 'global' | 'custom';

export interface StatuslineConfig {
  /** Separator rendered between segments within a line (ignored in powerline mode). */
  separator: string;
  /** Where the rendered line(s) sit within the terminal width. */
  align: StatuslineAlign;
  /** Whether to prefix the header with the weave logo mark. */
  showLogo: boolean;
  /** Logo text rendered before the first line's segments (e.g. `▊ weave`). */
  logoText: string;
  /** Colour of the logo mark. */
  logoColor: StatuslineColor;
  /** ccstatusline-style solid background blocks. */
  powerline: { enabled: boolean };
  /**
   * Ordered lines; each line is the left-to-right segment order of that row.
   * The panel adds/removes lines and reorders segments within/across them.
   * Rows are separated by a dim divider; the logo prefixes the first row.
   */
  lines: SegmentKey[][];
  /** How often Claude Code re-runs the statusline script (seconds, min 1). */
  refreshInterval: number;
  /** Project config origin: follow the global template, or project-local. */
  source: StatuslineSource;
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

export const DEFAULT_STATUSLINE_CONFIG: StatuslineConfig = {
  separator: ' │ ',
  align: 'left',
  showLogo: true,
  logoText: '▊ weave',
  logoColor: 'magenta',
  powerline: { enabled: false },
  lines: [SEGMENT_ORDER],
  refreshInterval: 1,
  source: 'global',
  segments: {
    project: seg({ color: 'cyan', bold: true, icon: '📁' }),
    git: seg({ color: 'magenta', icon: '🌿' }),
    changes: seg({ enabled: false, color: 'yellow', icon: '✏️' }),
    model: seg({ color: 'blue', icon: '🤖' }),
    thinking: seg({ enabled: false, color: 'yellow', icon: '🧩' }),
    context: seg({ enabled: true, color: 'cyan', icon: '🧠', style: 'both' }),
    tokens: seg({ enabled: false, color: 'yellow', icon: '🔢' }),
    cost: seg({ enabled: false, color: 'green', icon: '💸' }),
    rate: seg({ enabled: false, color: 'red', icon: '⚡' }),
    time: seg({ enabled: false, color: 'gray', icon: '🕒' }),
  },
};
