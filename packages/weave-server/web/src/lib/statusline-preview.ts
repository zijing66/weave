import {
  CONTEXT_STYLE_FORMAT,
  SEGMENT_DEFAULT_FORMAT,
  type SegmentKey,
  type StatuslineColor,
  type StatuslineConfig,
  type StatuslineSegment,
} from './api';

export interface PreviewItem {
  text: string;
  fg: StatuslineColor;
  bold: boolean;
  bg: StatuslineColor | null;
  merge: boolean;
  /** Merged into the following block — no separator between them. */
  joinsNext?: boolean;
}

/**
 * Sample values for each segment's format tokens.
 *
 * Keep in lockstep with `segmentTokens` in
 * weave-harness/src/claude/statusline/generator.ts — this is the browser-side
 * mirror that lets the panel preview edits without a server round-trip.
 */
export const SAMPLE_TOKENS: Record<SegmentKey, Record<string, string>> = {
  // Both keys: the default layout renders {path}, older configs use {name}.
  project: { name: 'my-project', path: '/workspace/my-project' },
  git: { branch: 'main', repo: 'acme/weave', ahead: '1', behind: '2', sync: '(2↓/1↑)' },
  git_user: { user: 'yao', email: 'yao@weave.dev' },
  changes: { added: '1', deleted: '1', files: '3' },
  model: { model: 'claude-sonnet-5' },
  thinking: { level: 'high' },
  context: { percent: '78', used: '780k', total: '1.0M', remaining: '22' },
  tokens: { total: '960.9k', percent: '42' },
  cost: { cost: '$0.42', duration: '12m', api_duration: '3m', lines_added: '42', lines_removed: '7' },
  rate: { percent: '45', limit: '5h', resets: '' },
  time: { time: '12:30' },
  version: { version: '2.1.286' },
  output_style: { style: 'explanatory' },
  session: { name: 'feat-statusline' },
  exceeds200k: { over: '200k' },
  fast_mode: { mode: 'fast' },
  vim: { mode: 'INSERT' },
  pr: { number: '482', state: 'approved', url: 'https://github.com/acme/weave/pull/482' },
  worktree: { name: 'weave-next', branch: 'feat/x' },
  agent: { name: 'reviewer' },
};

/** 某一块的 token 值（缺的块 = 当下没有数据，调用方据此不渲染）。 */
export type StatuslineTokens = Partial<Record<SegmentKey, Record<string, string>>>;

/** The value template a segment renders with, matching the generator. */
function formatFor(key: SegmentKey, seg: StatuslineSegment): string {
  if (seg.format) return seg.format;
  if (key === 'context' && seg.style) return CONTEXT_STYLE_FORMAT[seg.style];
  return SEGMENT_DEFAULT_FORMAT[key];
}

/** Render a segment's text: icon + label + templated value. */
export function segmentText(
  key: SegmentKey,
  seg: StatuslineSegment,
  config: StatuslineConfig,
  tokens: Record<string, string>,
): string {
  const values = { ...tokens };
  if (key === 'context') {
    const pct = Number(values.percent);
    let filled = Math.round((pct / 100) * config.bar.cells);
    // A non-zero percentage must light at least one cell — mirrors the
    // generator's barFor (otherwise low usage rounds down to an empty bar).
    if (pct > 0 && filled === 0) filled = 1;
    values.bar = config.bar.fill.repeat(filled) + config.bar.empty.repeat(config.bar.cells - filled);
  }
  // trim 同生成脚本：可选 token（如 {sync}）没有值时不留下多余的分隔空格
  const value = formatFor(key, seg)
    .replace(/\{(\w+)\}/g, (_m, k: string) => values[k] ?? '')
    .trim();
  const label = seg.label ? `${seg.label}${config.labelSeparator}` : '';
  return (seg.icon ? `${seg.icon} ` : '') + label + value;
}

/**
 * Mirrors the generator's renderParts: enabled segments for a row, with merges
 * resolved. 只渲染 `tokens` 里给出了值的块——没有数据的块整块不出现（与生成
 * 脚本里「format 解析成空即丢掉」同口径，但不会只剩一个图标/标签）。
 */
export function buildPreviewItems(
  config: StatuslineConfig,
  keys: SegmentKey[],
  tokens: StatuslineTokens = SAMPLE_TOKENS,
): PreviewItem[] {
  const items: PreviewItem[] = [];
  for (const key of keys) {
    const seg = config.segments[key];
    if (!seg.enabled) continue;
    const facts = tokens[key];
    if (!facts) continue;
    const text = segmentText(key, seg, config, facts);
    if (text === '') continue;
    items.push({
      text,
      fg: seg.color,
      bold: seg.bold,
      bg: seg.backgroundColor,
      merge: seg.merge,
    });
  }
  // resolve merges the way the generated script does
  const out: PreviewItem[] = [];
  let pending: PreviewItem[] = [];
  for (const it of items) {
    if (it.merge) {
      pending.push(it);
      continue;
    }
    for (const p of pending) {
      p.bg = it.bg;
      p.joinsNext = true;
    }
    pending = [];
    out.push(it);
  }
  for (const p of pending) p.bg = null;
  return out.concat(pending);
}
