import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  horizontalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import {
  api,
  NAMED_COLORS,
  SEGMENT_TOKENS,
  SEGMENT_DEFAULT_FORMAT,
  CONTEXT_STYLE_FORMAT,
  WEAVE_VERSION,
  type StatuslineConfig,
  type StatuslineColor,
  type StatuslineAlign,
  type StatuslineSegment,
  type SegmentKey,
} from '@/lib/api';
import {
  ANSI256_GRID,
  colorLabel,
  cssFg,
  cssSolid,
  parseColorInput,
} from '@/lib/statusline-color';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { AgentBadge } from '@/components/AgentBadge';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useT } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/dict';

const SEGMENTS: { key: SegmentKey; labelKey: MessageKey; sample: string }[] = [
  { key: 'project', labelKey: 'seg.project', sample: 'my-project' },
  { key: 'git', labelKey: 'seg.git', sample: 'main' },
  { key: 'changes', labelKey: 'seg.changes', sample: '3' },
  { key: 'model', labelKey: 'seg.model', sample: 'claude-sonnet-5' },
  { key: 'thinking', labelKey: 'seg.thinking', sample: 'high' },
  { key: 'context', labelKey: 'seg.context', sample: '78% ▰▰▰▰▰▰▰▱▱' },
  { key: 'tokens', labelKey: 'seg.tokens', sample: '12k' },
  { key: 'cost', labelKey: 'seg.cost', sample: '$0.42' },
  { key: 'rate', labelKey: 'seg.rate', sample: '5h 45%' },
  { key: 'time', labelKey: 'seg.time', sample: '12:30' },
  { key: 'version', labelKey: 'seg.version', sample: '2.1.286' },
  { key: 'output_style', labelKey: 'seg.output_style', sample: 'explanatory' },
  { key: 'session', labelKey: 'seg.session', sample: 'feat-statusline' },
  { key: 'exceeds200k', labelKey: 'seg.exceeds200k', sample: '200k' },
  { key: 'fast_mode', labelKey: 'seg.fast_mode', sample: 'fast' },
  { key: 'vim', labelKey: 'seg.vim', sample: 'INSERT' },
  { key: 'pr', labelKey: 'seg.pr', sample: '#482' },
  { key: 'worktree', labelKey: 'seg.worktree', sample: 'weave-next' },
  { key: 'agent', labelKey: 'seg.agent', sample: 'reviewer' },
];

/** Shortcut row in the swatch strip; the popover exposes the full range. */
const COLORS: StatuslineColor[] = [...NAMED_COLORS];

const ALIGNS: { key: StatuslineAlign; labelKey: MessageKey }[] = [
  { key: 'left', labelKey: 'align.left' },
  { key: 'center', labelKey: 'align.center' },
  { key: 'right', labelKey: 'align.right' },
];

const BAR_STYLES: { key: 'percent' | 'bar' | 'both'; labelKey: MessageKey }[] = [
  { key: 'percent', labelKey: 'statusline.barStyle.percent' },
  { key: 'bar', labelKey: 'statusline.barStyle.bar' },
  { key: 'both', labelKey: 'statusline.barStyle.both' },
];

/** Which quantity the `tokens` segment reports. */
const TOKEN_METRICS: {
  key: 'session' | 'context';
  labelKey: MessageKey;
  titleKey: MessageKey;
}[] = [
  {
    key: 'session',
    labelKey: 'statusline.metric.session',
    titleKey: 'statusline.metric.sessionTitle',
  },
  {
    key: 'context',
    labelKey: 'statusline.metric.context',
    titleKey: 'statusline.metric.contextTitle',
  },
];


/** Which rate-limit window the `rate` block reports. */
const RATE_WINDOWS: {
  key: 'five_hour' | 'seven_day' | 'spend';
  labelKey: MessageKey;
  titleKey: MessageKey;
}[] = [
  { key: 'five_hour', labelKey: 'rateWin.fiveHour.label', titleKey: 'rateWin.fiveHour.title' },
  { key: 'seven_day', labelKey: 'rateWin.sevenDay.label', titleKey: 'rateWin.sevenDay.title' },
  { key: 'spend', labelKey: 'rateWin.spend.label', titleKey: 'rateWin.spend.title' },
];

// Powerline glyph presets (Nerd Font code points — spelled out so the source
// stays copy-paste safe; a literal PUA char does not survive editing reliably).
const glyph = (hex: number, nameKey: MessageKey): { char: string; nameKey: MessageKey } => ({
  char: String.fromCodePoint(hex),
  nameKey,
});
/** Classic triangle set — used when the config leaves a glyph field undefined. */
const DEFAULT_JOIN = String.fromCodePoint(0xe0b0);
const DEFAULT_START_CAP = String.fromCodePoint(0xe0b2);
const DEFAULT_END_CAP = String.fromCodePoint(0xe0b0);
const JOIN_PRESETS = [
  glyph(0xe0b0, 'statusline.glyph.triangleRight'),
  glyph(0xe0b2, 'statusline.glyph.triangleLeft'),
  glyph(0xe0b4, 'statusline.glyph.roundRight'),
  glyph(0xe0b6, 'statusline.glyph.roundLeft'),
];
const START_CAP_PRESETS = [
  glyph(0xe0b2, 'statusline.glyph.triangle'),
  glyph(0xe0b6, 'statusline.glyph.round'),
  glyph(0xe0ba, 'statusline.glyph.lowerTriangle'),
  glyph(0xe0be, 'statusline.glyph.diagonal'),
];
const END_CAP_PRESETS = [
  glyph(0xe0b0, 'statusline.glyph.triangle'),
  glyph(0xe0b4, 'statusline.glyph.round'),
  glyph(0xe0b8, 'statusline.glyph.lowerTriangle'),
  glyph(0xe0bc, 'statusline.glyph.diagonal'),
];

/** One glyph role's preset buttons. `undefined` selects the default preset;
 * an explicit empty string means "disabled" (caps only). */
function GlyphPicker({
  label,
  value,
  fallback,
  presets,
  editable,
  allowNone,
  onChange,
}: {
  label: string;
  value: string | undefined;
  fallback: string;
  presets: { char: string; nameKey: MessageKey }[];
  editable: boolean;
  allowNone?: boolean;
  onChange: (v: string) => void;
}) {
  const t = useT();
  const current = value ?? fallback;
  return (
    <div className="flex items-center gap-1">
      <span className="text-neutral-500">{label}</span>
      {presets.map((p) => (
        <button
          key={p.nameKey}
          onClick={() => onChange(p.char)}
          disabled={!editable}
          title={`${t(p.nameKey)} (U+${p.char.codePointAt(0)!.toString(16).toUpperCase()})`}
          className={cn(
            // nerd-font = bundled Nerd Font + mono fallback; plain font-mono
            // shows tofu here on machines without a system Nerd Font
            'nerd-font w-6 h-6 rounded flex items-center justify-center disabled:opacity-30',
            current === p.char
              ? 'bg-neutral-800 text-neutral-100 ring-1 ring-white/30'
              : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900',
          )}
        >
          {p.char}
        </button>
      ))}
      {allowNone && (
        <button
          onClick={() => onChange('')}
          disabled={!editable}
          title={t('statusline.disableCap')}
          className={cn(
            'rounded px-1.5 h-6 text-[10px] disabled:opacity-30',
            value === ''
              ? 'bg-neutral-800 text-neutral-100 ring-1 ring-white/30'
              : 'text-neutral-500 hover:text-neutral-300',
          )}
        >
          {t('statusline.none')}
        </button>
      )}
    </div>
  );
}

/**
 * A colour swatch strip plus an expandable popover.
 *
 * The seven named colours stay one click away; the popover adds the full 256
 * palette and a native colour input for arbitrary hex. Values resolve through
 * `cssSolid`, so an `ansi256:` index or a `#rrggbb` renders exactly, which
 * Tailwind classes could not express.
 */
function ColorPicker({
  value,
  editable,
  onChange,
  allowNone,
  noneSelected,
  onNone,
}: {
  value: StatuslineColor | null;
  editable: boolean;
  onChange: (c: StatuslineColor) => void;
  allowNone?: boolean;
  noneSelected?: boolean;
  onNone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const t = useT();

  const commitDraft = (): void => {
    const parsed = parseColorInput(draft);
    if (parsed) onChange(parsed);
    setDraft('');
  };

  return (
    <div className="flex gap-1 items-center">
      {allowNone && (
        <button
          type="button"
          onClick={onNone}
          disabled={!editable}
          title={t('statusline.noBackground')}
          className={cn(
            'h-3.5 w-3.5 rounded border border-white/20 disabled:opacity-30',
            noneSelected ? 'ring-2 ring-white/60 bg-neutral-800' : 'opacity-40',
          )}
        >
          <span className="block h-px bg-neutral-500 rotate-45" />
        </button>
      )}

      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          disabled={!editable}
          title={c}
          style={{ backgroundColor: cssSolid(c) }}
          className={cn(
            'h-3.5 w-3.5 rounded-full disabled:opacity-30',
            value === c ? 'ring-2 ring-white/60' : 'opacity-50',
          )}
        />
      ))}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!editable}
        title={
          value && !isNamedColor(value)
            ? t('statusline.moreColorsCurrent', { color: colorLabel(value) })
            : t('statusline.moreColors')
        }
        style={value && !isNamedColor(value) ? { backgroundColor: cssSolid(value) } : undefined}
        className={cn(
          'h-3.5 w-3.5 rounded-full border border-white/25 text-[8px] leading-none disabled:opacity-30',
          value && !isNamedColor(value) ? 'ring-2 ring-white/60' : 'opacity-50 text-neutral-400',
        )}
      >
        {value && !isNamedColor(value) ? '' : '+'}
      </button>

      {open && editable && (
        <div className="relative">
          <div className="absolute z-20 left-0 top-5 w-64 rounded border border-white/15 bg-neutral-950 p-2 shadow-xl">
            <div className="grid grid-cols-[repeat(16,minmax(0,1fr))] gap-[2px]">
              {ANSI256_GRID.map((hex, i) => (
                <button
                  key={i}
                  type="button"
                  title={`ansi256:${i}`}
                  onClick={() => {
                    onChange(`ansi256:${i}` as StatuslineColor);
                    setOpen(false);
                  }}
                  style={{ backgroundColor: hex }}
                  className="h-3 w-3 rounded-sm hover:ring-1 hover:ring-white/70"
                />
              ))}
            </div>
            <div className="mt-2 flex items-center gap-1">
              <input
                type="color"
                value={toHexInput(value)}
                onChange={(e) => onChange(e.target.value.toLowerCase() as StatuslineColor)}
                className="h-6 w-8 bg-transparent"
                title={t('statusline.pickTruecolor')}
              />
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitDraft();
                }}
                placeholder={t('statusline.colorPlaceholder')}
                className="bg-neutral-900 rounded px-1.5 py-0.5 text-[11px] font-mono flex-1"
              />
              <button
                type="button"
                onClick={commitDraft}
                className="text-[11px] rounded bg-neutral-800 px-2 py-0.5 text-neutral-300 hover:bg-neutral-700"
              >
                {t('statusline.ok')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const isNamedColor = (c: string): boolean => (NAMED_COLORS as readonly string[]).includes(c);

/** A valid `#rrggbb` for `<input type="color">`, which cannot show names. */
function toHexInput(color: StatuslineColor | null): string {
  if (!color) return '#000000';
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : cssSolid(color);
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface PreviewItem {
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
 * packages/weave-server/src/statusline/generator.ts — this is the browser-side
 * mirror that lets the panel preview edits without a server round-trip.
 */
const SAMPLE_TOKENS: Record<SegmentKey, Record<string, string>> = {
  // Both keys: the default layout renders {path}, older configs use {name}.
  project: { name: 'my-project', path: '/workspace/my-project' },
  git: { branch: 'main', repo: 'acme/weave' },
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

/** The value template a segment renders with, matching the generator. */
function formatFor(key: SegmentKey, seg: StatuslineSegment): string {
  if (seg.format) return seg.format;
  if (key === 'context' && seg.style) return CONTEXT_STYLE_FORMAT[seg.style];
  return SEGMENT_DEFAULT_FORMAT[key];
}

/** Render a segment's sample text: icon + label + templated value. */
function sampleText(key: SegmentKey, seg: StatuslineSegment, config: StatuslineConfig): string {
  const tokens = { ...SAMPLE_TOKENS[key] };
  if (key === 'context') {
    const pct = Number(tokens.percent);
    let filled = Math.round((pct / 100) * config.bar.cells);
    // A non-zero percentage must light at least one cell — mirrors the
    // generator's barFor (otherwise low usage rounds down to an empty bar).
    if (pct > 0 && filled === 0) filled = 1;
    tokens.bar = config.bar.fill.repeat(filled) + config.bar.empty.repeat(config.bar.cells - filled);
  }
  const value = formatFor(key, seg).replace(/\{(\w+)\}/g, (_m, k: string) => tokens[k] ?? '');
  const label = seg.label ? `${seg.label}${config.labelSeparator}` : '';
  return (seg.icon ? `${seg.icon} ` : '') + label + value;
}

/** Mirrors the generator's renderParts: enabled segments for a row. */
function buildPreviewItems(config: StatuslineConfig, keys: SegmentKey[]): PreviewItem[] {
  const items: PreviewItem[] = [];
  for (const key of keys) {
    const seg = config.segments[key];
    if (!seg.enabled) continue;
    const text = sampleText(key, seg, config);
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

/** Move a segment from one row to another at a given index. */
function moveAcrossLines(
  lines: SegmentKey[][],
  from: number,
  to: number,
  key: SegmentKey,
  toIndex: number,
): SegmentKey[][] {
  const next = lines.map((row) => [...row]);
  const idx = next[from].indexOf(key);
  if (idx >= 0) next[from].splice(idx, 1);
  next[to].splice(Math.min(toIndex, next[to].length), 0, key);
  return next;
}

export function StatuslinePanel({
  projectId,
  initialTab = 'project',
}: {
  projectId: number;
  /** Which config this panel edits: the project's own, or the global template.
   * Fixed at mount — the Level-1 nav (project vs global pseudo-project) already
   * owns this choice and remounts the panel via key, so no in-panel switch. */
  initialTab?: 'project' | 'global';
}) {
  const isGlobal = initialTab === 'global';
  const t = useT();
  const [config, setConfig] = useState<StatuslineConfig | null>(null);
  const [globalConfig, setGlobalConfig] = useState<StatuslineConfig | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  // 恢复出厂 is destructive (overwrites the global template), so the first
  // click only arms the button; a second click within 5s executes.
  const [resetArmed, setResetArmed] = useState(false);
  // Follow global / Sync from global both discard the local custom config —
  // the first click arms the button, a second click within 5s executes
  // (same two-step pattern as 恢复出厂).
  const [confirmSwitch, setConfirmSwitch] = useState<'follow' | 'sync' | null>(null);
  // Which capsule's edit modal is open (key === null means "adding").
  const [editing, setEditing] = useState<{ line: number; key: SegmentKey | null } | null>(null);
  // A finished drag also fires a click on the capsule — swallow it.
  const lastDragEnd = useRef(0);
  const skipNextSave = useRef(false);
  // Whole-panel collapse — the header row toggles the entire statusline config block.
  const [open, setOpen] = useState(true);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const loadProject = useCallback(() => {
    setError(null);
    setConfig(null);
    setSaveState('idle');
    api
      .getStatusline(projectId)
      .then((r) => {
        skipNextSave.current = true;
        setGlobalConfig(r.globalConfig);
        // Global view edits the template itself (a writable copy); project view
        // edits the project config (which may just follow the global template).
        setConfig(isGlobal ? (r.globalConfig ? structuredClone(r.globalConfig) : null) : r.config);
      })
      .catch((e) => setError(String(e)));
  }, [projectId, isGlobal]);

  useEffect(() => {
    loadProject();
  }, [loadProject]);

  // Disarm a pending factory reset after a few seconds of hesitation.
  useEffect(() => {
    if (!resetArmed) return;
    const timer = setTimeout(() => setResetArmed(false), 5000);
    return () => clearTimeout(timer);
  }, [resetArmed]);

  // Same hesitation window for the follow/sync confirmations.
  useEffect(() => {
    if (!confirmSwitch) return;
    const timer = setTimeout(() => setConfirmSwitch(null), 5000);
    return () => clearTimeout(timer);
  }, [confirmSwitch]);

  /** First click arms, second click loads the shipped defaults into the form —
   * the normal debounced save then PUTs them and auto-syncs follower projects. */
  const restoreFactory = useCallback(async () => {
    if (!resetArmed) {
      setResetArmed(true);
      return;
    }
    setResetArmed(false);
    setError(null);
    try {
      const factory = await api.getFactoryStatusline();
      setSaveState('idle');
      setConfig(structuredClone(factory));
    } catch (e) {
      setError(String(e));
    }
  }, [resetArmed]);

  const persist = useCallback(async () => {
    if (!config) return;
    setSaveState('saving');
    setError(null);
    try {
      const res = isGlobal
        ? await api.putGlobalStatusline(config)
        : await api.putStatusline(projectId, config);
      if (res.ok) {
        setSaveState('saved');
      } else {
        setSaveState('error');
        setError(t('statusline.saveFailed', { error: `${res.status} ${await res.text()}` }));
      }
    } catch (e) {
      setSaveState('error');
      setError(String(e));
    }
  }, [projectId, config, isGlobal, t]);

  // Auto-save on edit (debounced). The initial load re-sets config without saving.
  useEffect(() => {
    if (!config) return;
    if (skipNextSave.current) {
      skipNextSave.current = false;
      return;
    }
    const timer = setTimeout(() => void persist(), 700);
    return () => clearTimeout(timer);
  }, [config, persist]);

  if (!config) return <p className="text-xs text-neutral-500">{error ?? t('common.loading')}</p>;

  const editable = isGlobal || config.source === 'custom';

  /** Copy the global template into this project as a custom config. */
  function adoptGlobal() {
    if (!globalConfig) return;
    setConfig({ ...structuredClone(globalConfig), source: 'custom' });
  }

  function update(key: SegmentKey, patch: Partial<StatuslineSegment>) {
    setConfig(
      (c) =>
        c && {
          ...c,
          segments: { ...c.segments, [key]: { ...c.segments[key], ...patch } },
        },
    );
  }

  function patch(p: Partial<StatuslineConfig>) {
    setConfig((c) => (c ? { ...c, ...p } : c));
  }

  function addRow() {
    setConfig((c) => (c ? { ...c, lines: [...c.lines, []] } : c));
  }

  function removeRow(line: number) {
    setConfig((c) => {
      if (!c || c.lines.length <= 1) return c;
      const rows = c.lines.map((r) => [...r]);
      const removed = rows.splice(line, 1)[0] ?? [];
      // merge the removed row's segments into the adjacent row so every segment
      // stays reachable (a segment checked on is always renderable somewhere)
      const target = line > 0 ? line - 1 : 0;
      rows[target] = [...rows[target], ...removed];
      return { ...c, lines: rows };
    });
  }

  /** Insert a key at the end of a row, first removing it from every row
   * (used by the modal's type tags: picking a placed type MOVES it here). */
  function placeKeyInLine(line: number, key: SegmentKey) {
    setConfig((c) => {
      if (!c) return c;
      const rows = c.lines.map((r) => r.filter((k) => k !== key));
      rows[line] = [...rows[line], key];
      return { ...c, lines: rows };
    });
  }

  /** Swap the key occupying a slot, preserving its position; the target type
   * may live on another row (it is moved, never duplicated). */
  function switchKeyInLine(line: number, from: SegmentKey, to: SegmentKey) {
    setConfig((c) => {
      if (!c) return c;
      const rows = c.lines.map((r) => r.filter((k) => k !== from && k !== to));
      const idx = c.lines[line].indexOf(from);
      const at = Math.min(Math.max(idx, 0), rows[line].length);
      rows[line] = [...rows[line].slice(0, at), to, ...rows[line].slice(at)];
      return { ...c, lines: rows };
    });
  }

  /** Take a capsule out of its row; the key stays configured so re-adding it
   * from the + pill restores the same styling. */
  function unplaceFromLine(line: number, key: SegmentKey) {
    setConfig((c) => c && ({ ...c, lines: c.lines.map((r, i) => (i === line ? r.filter((k) => k !== key) : r)) }));
  }

  function handleDragEnd(e: DragEndEvent) {
    lastDragEnd.current = Date.now();
    const { active, over } = e;
    if (!over) return;
    const key = active.id as SegmentKey;
    setConfig((c) => {
      if (!c) return c;
      const fromLine = (active.data.current?.line as number | undefined) ?? -1;
      const overLine = (over.data.current?.line as number | undefined) ?? -1;
      const overContainer = over.data.current?.container === true;
      if (fromLine < 0 || overLine < 0) return c;
      // dropped on a row container (empty row / row tail) → append to that row
      if (overContainer) {
        if (fromLine === overLine) return c;
        return { ...c, lines: moveAcrossLines(c.lines, fromLine, overLine, key, c.lines[overLine].length) };
      }
      // dropped on a segment (same or another row)
      if (active.id === over.id) return c;
      const fromIdx = c.lines[fromLine].indexOf(key);
      if (fromIdx < 0) return c;
      if (fromLine === overLine) {
        const toIdx = c.lines[overLine].indexOf(over.id as SegmentKey);
        if (toIdx < 0) return c;
        const lines = c.lines.map((r) => [...r]);
        lines[fromLine] = arrayMove(lines[fromLine], fromIdx, toIdx);
        return { ...c, lines };
      }
      const toIdx = c.lines[overLine].indexOf(over.id as SegmentKey);
      return {
        ...c,
        lines: moveAcrossLines(c.lines, fromLine, overLine, key, toIdx < 0 ? c.lines[overLine].length : toIdx),
      };
    });
  }

  // Mirrors the generator's logoItem: always present, version stamped on.
  const logo = {
    text: `${config.logoText} v${WEAVE_VERSION}`,
    fg: config.logoColor,
    bold: true,
    bg: null as StatuslineColor | null,
    merge: false,
  };

  return (
    <Card className={cn('flex flex-col', open && 'h-[600px] overflow-hidden')}>
      <CardHeader className="shrink-0 items-center">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 text-left"
          title={open ? t('common.collapse') : t('common.expand')}
        >
          {open ? (
            <ChevronDown className="h-4 w-4 text-neutral-500" />
          ) : (
            <ChevronRight className="h-4 w-4 text-neutral-500" />
          )}
          <CardTitle>{t('statusline.title')}</CardTitle>
          <AgentBadge agent="claude" />
        </button>
        <div className="ml-auto flex items-center gap-2 text-xs">
          <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-neutral-400">
            {isGlobal ? t('statusline.scopeGlobal') : t('statusline.scopeProject')}
          </span>
          {isGlobal && (
            <button
              onClick={() => void restoreFactory()}
              className={cn(
                'rounded px-2 py-1 transition-colors',
                resetArmed
                  ? 'bg-red-900/60 text-red-200 ring-1 ring-red-500/60'
                  : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200',
              )}
              title={t('statusline.resetHint')}
            >
              {resetArmed ? t('statusline.resetConfirm') : t('statusline.reset')}
            </button>
          )}
          <button
            onClick={() => void persist()}
            disabled={saveState === 'saving'}
            className={cn(
              'rounded px-2 py-1 disabled:opacity-40',
              saveState === 'saved'
                ? 'bg-emerald-900/40 text-emerald-300'
                : saveState === 'error'
                  ? 'bg-red-900/40 text-red-300'
                  : 'bg-blue-900/40 text-blue-300',
            )}
          >
            {saveState === 'saving'
              ? t('common.saving')
              : saveState === 'saved'
                ? t('statusline.saved')
                : saveState === 'error'
                  ? t('statusline.retry')
                  : t('common.save')}
          </button>
        </div>
      </CardHeader>
      {open && (
      <>
        {/* The preview is pinned under the header; everything below it
            scrolls inside the card's fixed height. */}
        <div className="shrink-0 border-b border-white/[0.06] p-3">
          {/* live preview — one block per row, powerline blocks when enabled */}
          <div className="nerd-font rounded-md bg-neutral-950 border border-white/[0.06] px-3 py-2 text-xs text-neutral-300 whitespace-pre overflow-x-auto">
            {config.lines.map((row, i) => {
              const items = buildPreviewItems(config, row);
              if (i === 0 && logo) items.unshift(logo);
              return (
                <div key={i}>
                  {i > 0 && <div className="text-neutral-700">────────────────────────────</div>}
                  {items.length ? (
                    <PowerlineRow items={items} config={config} />
                  ) : (
                    <span className="text-neutral-600">{t('statusline.emptyRow')}</span>
                  )}
                </div>
              );
            })}
            <span className="text-neutral-600 text-[10px]">{t('statusline.preview')}</span>
          </div>
        </div>
        <CardContent className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          {error && <p className="text-red-400 text-xs">{error}</p>}

          {/* source status row (project view only — global view edits the template directly) */}
          {!isGlobal && (
            <div className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-neutral-900/60 px-2 py-1.5 text-xs">
              {config.source === 'global' ? (
                <>
                  <span className="rounded-full bg-blue-900/50 px-2 py-0.5 text-blue-300">
                    {t('statusline.followingGlobal')}
                  </span>
                  <span className="text-neutral-600">{t('statusline.editsDisabled')}</span>
                  <button
                    onClick={adoptGlobal}
                    className="ml-auto shrink-0 rounded bg-blue-900/40 px-2 py-0.5 text-blue-300 hover:bg-blue-900/60"
                  >
                    {t('statusline.customizeLocally')}
                  </button>
                </>
              ) : (
                <>
                  <span className="rounded-full bg-amber-900/50 px-2 py-0.5 text-amber-300">
                    {t('statusline.localCustom')}
                  </span>
                  <span className="text-neutral-600">{t('statusline.ownConfig')}</span>
                  <button
                    onClick={() => {
                      if (confirmSwitch !== 'follow') {
                        setConfirmSwitch('follow');
                        return;
                      }
                      setConfirmSwitch(null);
                      patch({ source: 'global' });
                    }}
                    className={cn(
                      'ml-auto shrink-0 rounded px-2 py-0.5 transition-colors',
                      confirmSwitch === 'follow'
                        ? 'bg-red-900/60 text-red-200 ring-1 ring-red-500/60'
                        : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700',
                    )}
                    title={t('statusline.followHint')}
                  >
                    {confirmSwitch === 'follow' ? t('statusline.followConfirm') : t('statusline.follow')}
                  </button>
                  <button
                    onClick={() => {
                      if (confirmSwitch !== 'sync') {
                        setConfirmSwitch('sync');
                        return;
                      }
                      setConfirmSwitch(null);
                      adoptGlobal();
                    }}
                    className={cn(
                      'shrink-0 rounded px-2 py-0.5 transition-colors',
                      confirmSwitch === 'sync'
                        ? 'bg-red-900/60 text-red-200 ring-1 ring-red-500/60'
                        : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700',
                    )}
                    title={t('statusline.syncHint')}
                  >
                    {confirmSwitch === 'sync' ? t('statusline.syncConfirm') : t('statusline.sync')}
                  </button>
                </>
              )}
            </div>
          )}

          {/* align + powerline + logo + refresh */}
          <div className="flex items-center gap-2 text-xs text-neutral-400 flex-wrap">
            <span className="w-12">{t('statusline.alignLabel')}</span>
            {ALIGNS.map((a) => (
              <button
                key={a.key}
                onClick={() => patch({ align: a.key })}
                disabled={!editable}
                className={cn(
                  'rounded px-2 py-0.5 disabled:opacity-30',
                  config.align === a.key ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400 hover:text-neutral-200',
                )}
              >
                {t(a.labelKey)}
              </button>
            ))}
            <span className="text-neutral-600">|</span>
            <label className="flex items-center gap-1.5">
              {t('statusline.refresh')}
              <input
                type="number"
                min={1}
                value={config.refreshInterval}
                disabled={!editable}
                onChange={(e) => patch({ refreshInterval: Math.max(1, Number(e.target.value) || 1) })}
                className="bg-neutral-900 rounded px-2 py-0.5 font-mono w-12 text-center disabled:opacity-40"
                title={t('statusline.refreshHint')}
              />
              <span className="text-neutral-600">s</span>
              <span className="text-neutral-600 text-[10px]">{t('statusline.refreshNote')}</span>
            </label>
          </div>
          <label className="flex items-center gap-2 text-xs text-neutral-400">
            <input
              type="checkbox"
              checked={config.powerline.enabled}
              disabled={!editable}
              onChange={(e) =>
                patch({ powerline: { ...config.powerline, enabled: e.target.checked } })
              }
            />
            {t('statusline.powerlineStyle')}
            <span className="text-neutral-600">{t('statusline.powerlineHint')}</span>
          </label>

          {/* powerline glyphs — Nerd-Font separator between blocks and row caps */}
          {config.powerline.enabled && (
            <div className="flex items-center gap-4 text-xs text-neutral-400 flex-wrap pl-6">
              <GlyphPicker
                label={t('statusline.glyphSeparator')}
                value={config.powerline.separator}
                fallback={DEFAULT_JOIN}
                presets={JOIN_PRESETS}
                editable={editable}
                onChange={(v) =>
                  patch({ powerline: { ...config.powerline, separator: v } })
                }
              />
              <GlyphPicker
                label={t('statusline.glyphStartCap')}
                value={config.powerline.startCap}
                fallback={DEFAULT_START_CAP}
                presets={START_CAP_PRESETS}
                editable={editable}
                allowNone
                onChange={(v) => patch({ powerline: { ...config.powerline, startCap: v } })}
              />
              <GlyphPicker
                label={t('statusline.glyphEndCap')}
                value={config.powerline.endCap}
                fallback={DEFAULT_END_CAP}
                presets={END_CAP_PRESETS}
                editable={editable}
                allowNone
                onChange={(v) => patch({ powerline: { ...config.powerline, endCap: v } })}
              />
              <span className="text-neutral-600 text-[10px]">{t('statusline.nerdFontHint')}</span>
            </div>
          )}
          <label className="flex items-center gap-2 text-xs text-neutral-400">
            {t('statusline.logo')}
            {/* The badge is fixed (text and visibility are not user settings);
                only its colour below is configurable. */}
            <span className="rounded bg-neutral-900 px-2 py-0.5 font-mono text-neutral-300">
              {config.logoText} v{WEAVE_VERSION}
            </span>
            <span className="text-neutral-600 text-[10px]">{t('statusline.logoHint')}</span>
            <div className="flex gap-1">
              <ColorPicker
                value={config.logoColor}
                editable={editable}
                onChange={(c) => patch({ logoColor: c })}
              />
            </div>
          </label>

          <label className="flex items-center gap-2 text-xs text-neutral-400">
            {t('statusline.separator')}
            <input
              value={config.separator}
              disabled={!editable}
              onChange={(e) => patch({ separator: e.target.value })}
              className="nerd-font bg-neutral-900 rounded px-2 py-0.5 w-20 disabled:opacity-40"
            />
            <span className="text-neutral-600">{t('statusline.separatorHint')}</span>
          </label>

          {/* bar + label separator — global, because a statusline reads as one design */}
          <div className="flex items-center gap-3 text-xs text-neutral-400">
            <label className="flex items-center gap-2">
              {t('statusline.bar')}
              <input
                type="number"
                min={1}
                max={40}
                value={config.bar.cells}
                disabled={!editable}
                onChange={(e) => patch({ bar: { ...config.bar, cells: Number(e.target.value) || 1 } })}
                className="bg-neutral-900 rounded px-2 py-0.5 font-mono w-14 disabled:opacity-40"
                title={t('statusline.barCellsHint')}
              />
            </label>
            <label className="flex items-center gap-2">
              {t('statusline.fill')}
              <input
                value={config.bar.fill}
                disabled={!editable}
                onChange={(e) => patch({ bar: { ...config.bar, fill: e.target.value } })}
                className="bg-neutral-900 rounded px-2 py-0.5 font-mono w-10 text-center disabled:opacity-40"
              />
            </label>
            <label className="flex items-center gap-2">
              {t('statusline.emptyChar')}
              <input
                value={config.bar.empty}
                disabled={!editable}
                onChange={(e) => patch({ bar: { ...config.bar, empty: e.target.value } })}
                className="bg-neutral-900 rounded px-2 py-0.5 font-mono w-10 text-center disabled:opacity-40"
              />
            </label>
            <label className="flex items-center gap-2">
              {t('statusline.labelSep')}
              <input
                value={config.labelSeparator}
                disabled={!editable}
                onChange={(e) => patch({ labelSeparator: e.target.value })}
                className="bg-neutral-900 rounded px-2 py-0.5 font-mono w-14 disabled:opacity-40"
                title={t('statusline.labelSepHint')}
              />
            </label>
          </div>

          {/* lines — preview-styled capsules; click to edit, drag within/across
              rows, + pill appends a block (type tags in the modal pick/move it) */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[11px] text-neutral-500 uppercase tracking-wide">
                {t('statusline.lines')}
              </p>
              <button
                onClick={addRow}
                disabled={!editable}
                className="text-[11px] rounded bg-neutral-800 px-2 py-0.5 text-neutral-300 hover:bg-neutral-700 disabled:opacity-30"
              >
                {t('statusline.addRow')}
              </button>
            </div>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              {config.lines.map((row, li) => (
                <CapsuleRow
                  key={li}
                  li={li}
                  row={row}
                  linesLen={config.lines.length}
                  editable={editable}
                  config={config}
                  lastDragEnd={lastDragEnd}
                  onRemoveRow={removeRow}
                  onOpen={(line, key) => setEditing({ line, key })}
                  onAdd={(line) => setEditing({ line, key: null })}
                />
              ))}
            </DndContext>
            {editing && (
              <SegmentModal
                editing={editing}
                config={config}
                placedIn={(k) => config.lines.findIndex((r) => r.includes(k))}
                onPick={(k) => {
                  if (editing.key === null) {
                    placeKeyInLine(editing.line, k);
                  } else if (editing.key !== k) {
                    switchKeyInLine(editing.line, editing.key, k);
                  }
                  setEditing({ line: editing.line, key: k });
                }}
                onPatch={update}
                onUnplace={() => {
                  if (editing.key) unplaceFromLine(editing.line, editing.key);
                  setEditing(null);
                }}
                onClose={() => setEditing(null)}
              />
            )}
          </div>
        </CardContent>
      </>
      )}
    </Card>
  );
}

/** Renders a row as joined powerline blocks, or plain text when powerline is off.
 * Mirrors the generator: the join glyph's fg is the previous block's bg (or the
 * previous fg when both blocks share a bg), caps frame the row transparently. */
function PowerlineRow({
  items,
  config,
}: {
  items: PreviewItem[];
  config: StatuslineConfig;
}) {
  if (!config.powerline.enabled) {
    return (
      <span>
        {items
          .map((it) => (
            <span
              key={it.text + it.fg}
              className={cn(it.bold && 'font-bold')}
              style={{ color: cssFg(it.fg) }}
            >
              {it.text}
            </span>
          ))
          .reduce<ReactNode[]>((acc, el, i) => {
            if (i > 0) acc.push(<span key={`sep-${i}`}>{config.separator}</span>);
            acc.push(el);
            return acc;
          }, [])}
      </span>
    );
  }
  const pl = config.powerline;
  const join = pl.separator ?? DEFAULT_JOIN;
  const startCap = pl.startCap ?? DEFAULT_START_CAP;
  const endCap = pl.endCap ?? DEFAULT_END_CAP;
  const first = items[0];
  const last = items[items.length - 1];
  return (
    <span className="inline-flex items-stretch">
      {/* caps/joins paint a block's BACKGROUND colour as text — cssSolid, not
          cssFg: the two palettes diverge for named colours, which showed up
          as a visible shade gap against the block fill (mirrors the
          generator, where fg and bg take the same config value). */}
      {startCap && first?.bg && (
        <span className="whitespace-pre" style={{ color: cssSolid(first.bg) }}>
          {startCap}
        </span>
      )}
      {items.map((it, i) => {
        const prev = items[i - 1];
        const bridged = i > 0 && !prev.joinsNext;
        // bridge between adjacent backgrounded blocks; a bg-less block gets a gap
        const showGlyph = bridged && !!it.bg && !!prev.bg && join !== '';
        return (
          <span key={i} className="inline-flex items-stretch">
            {bridged &&
              (showGlyph ? (
                <span
                  className="whitespace-pre"
                  style={{
                    backgroundColor: cssSolid(it.bg!),
                    color:
                      prev.bg === it.bg ? cssFg(prev.fg) : cssSolid(prev.bg!),
                  }}
                >
                  {join}
                </span>
              ) : (
                <span className="w-1" />
              ))}
            <span
              className={cn('px-1.5 whitespace-pre', it.bold && 'font-bold')}
              style={{
                ...(it.bg ? { backgroundColor: cssSolid(it.bg) } : {}),
                color: cssFg(it.fg),
              }}
            >
              {it.text}
            </span>
          </span>
        );
      })}
      {endCap && last?.bg && (
        <span className="whitespace-pre" style={{ color: cssSolid(last.bg) }}>
          {endCap}
        </span>
      )}
    </span>
  );
}

/** One segment as a preview-styled pill. Click opens the edit modal; dragging
 * reorders within or across rows — handleDragEnd swallows the trailing click. */
function Capsule({
  segKey,
  line,
  segment,
  config,
  editable,
  lastDragEnd,
  onOpen,
}: {
  segKey: SegmentKey;
  line: number;
  segment: StatuslineSegment;
  config: StatuslineConfig;
  editable: boolean;
  lastDragEnd: { current: number };
  onOpen: (line: number, key: SegmentKey) => void;
}) {
  const t = useT();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: segKey,
    disabled: !editable,
    data: { line },
  });
  const style = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition,
  };
  const meta = SEGMENTS.find((s) => s.key === segKey)!;
  const on = segment.enabled;
  const text = sampleText(segKey, segment, config) || t(meta.labelKey);
  const bg = on && segment.backgroundColor ? cssSolid(segment.backgroundColor) : undefined;
  const fg = on ? cssFg(segment.color) : undefined;
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn('shrink-0 max-w-[260px]', isDragging && 'opacity-50 ring-1 ring-white/30')}
    >
      <button
        {...attributes}
        {...listeners}
        onClick={() => {
          // dnd-kit also fires a click after a real drag — ignore that tail
          if (Date.now() - lastDragEnd.current < 250) return;
          onOpen(line, segKey);
        }}
        title={
          on
            ? t('statusline.capsuleTitle', { name: t(meta.labelKey) })
            : t('statusline.capsuleTitleOff', { name: t(meta.labelKey) })
        }
        className={cn(
          'rounded-full px-2.5 py-1 text-xs whitespace-pre select-none transition',
          on
            ? 'shadow-mac-sm'
            : 'border border-dashed border-neutral-600 bg-neutral-800/60 text-neutral-500',
          editable ? 'cursor-grab active:cursor-grabbing hover:brightness-110' : 'cursor-default',
        )}
        style={bg || fg ? { backgroundColor: bg, color: fg } : undefined}
      >
        <span className="block truncate">{text}</span>
      </button>
    </div>
  );
}

/** A statusline row: a droppable container of capsules (empty rows accept
 * drops too) plus the + pill that opens the add modal. */
function CapsuleRow({
  li,
  row,
  linesLen,
  editable,
  config,
  lastDragEnd,
  onRemoveRow,
  onOpen,
  onAdd,
}: {
  li: number;
  row: SegmentKey[];
  linesLen: number;
  editable: boolean;
  config: StatuslineConfig;
  lastDragEnd: { current: number };
  onRemoveRow: (line: number) => void;
  onOpen: (line: number, key: SegmentKey) => void;
  onAdd: (line: number) => void;
}) {
  const t = useT();
  const { setNodeRef, isOver } = useDroppable({
    id: `line-${li}`,
    data: { line: li, container: true },
    disabled: !editable,
  });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'rounded-lg border border-white/[0.08] bg-neutral-900/30 px-2 py-1.5 transition-shadow',
        isOver && 'ring-2 ring-emerald-400/50',
      )}
    >
      <div className="flex items-center gap-2 pb-1">
        <span className="text-[10px] text-neutral-600 font-mono">
          {t('statusline.rowN', { n: li + 1 })}
        </span>
        <span className="text-[10px] text-neutral-600">
          {t('statusline.blockCount', { n: row.length })}
        </span>
        {linesLen > 1 && (
          <button
            onClick={() => onRemoveRow(li)}
            disabled={!editable}
            className="ml-auto text-neutral-500 hover:text-red-400 disabled:opacity-30"
            title={t('statusline.removeRow')}
          >
            <span className="text-xs leading-none">✕</span>
          </button>
        )}
      </div>
      <SortableContext items={row} strategy={horizontalListSortingStrategy}>
        <div className="flex min-h-[34px] flex-wrap items-center gap-1.5">
          {row.length === 0 && (
            <span className="text-[11px] text-neutral-600">{t('statusline.emptyRowHint')}</span>
          )}
          {row.map((key) => (
            <Capsule
              key={key}
              segKey={key}
              line={li}
              segment={config.segments[key]}
              config={config}
              editable={editable}
              lastDragEnd={lastDragEnd}
              onOpen={onOpen}
            />
          ))}
          {editable && (
            <button
              onClick={() => onAdd(li)}
              className="rounded-full border border-dashed border-neutral-600 px-2.5 py-1 text-xs text-neutral-400 transition-colors hover:border-neutral-400 hover:text-neutral-200"
              title={t('statusline.addBlockHint')}
            >
              {t('statusline.addBlock')}
            </button>
          )}
        </div>
      </SortableContext>
    </div>
  );
}

/**
 * Small dialog for one capsule: switch its type with the tags (a tag whose
 * type already lives on another row shows where, and moves it here), edit
 * every field, or take the capsule out of its row. Portalled to <body> so the
 * card's backdrop-filter cannot trap the fixed overlay.
 */
function SegmentModal({
  editing,
  config,
  placedIn,
  onPick,
  onPatch,
  onUnplace,
  onClose,
}: {
  editing: { line: number; key: SegmentKey | null };
  config: StatuslineConfig;
  placedIn: (k: SegmentKey) => number;
  onPick: (k: SegmentKey) => void;
  onPatch: (k: SegmentKey, p: Partial<StatuslineSegment>) => void;
  onUnplace: () => void;
  onClose: () => void;
}) {
  const key = editing.key;
  const seg = key ? config.segments[key] : null;
  const t = useT();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md space-y-3 rounded-xl border border-white/10 bg-neutral-900 p-4 shadow-mac">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-neutral-100">
            {key
              ? `${config.segments[key].icon ? config.segments[key].icon + ' ' : ''}${
                  t(SEGMENTS.find((s) => s.key === key)!.labelKey)
                }`
              : t('statusline.addBlockTitle')}
          </span>
          <span className="text-[10px] text-neutral-500">
            {t('statusline.rowN', { n: editing.line + 1 })}
          </span>
          <button
            onClick={onClose}
            className="ml-auto text-neutral-500 hover:text-neutral-300"
            title={t('statusline.closeEsc')}
          >
            ✕
          </button>
        </div>

        {/* type tags — pick a new type; a type placed elsewhere shows its row */}
        <div className="flex flex-wrap gap-1.5">
          {SEGMENTS.map((s) => {
            const at = placedIn(s.key);
            const isCurrent = s.key === key;
            const otherRow = at >= 0 && at !== editing.line;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => {
                  if (!isCurrent) onPick(s.key);
                }}
                title={otherRow ? t('statusline.tagOtherRow', { n: at + 1 }) : s.key}
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                  isCurrent
                    ? 'border-blue-500/50 bg-blue-900/50 text-blue-200'
                    : otherRow
                      ? 'border-transparent bg-neutral-800/70 text-amber-400/80 hover:bg-neutral-700 hover:text-amber-300'
                      : 'border-transparent bg-neutral-800/70 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200',
                )}
              >
                {t(s.labelKey)}
                {otherRow && (
                  <span className="ml-1 text-[9px] opacity-70">
                    {t('statusline.rowShort', { n: at + 1 })}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {key === null && (
          <p className="text-xs text-neutral-500">{t('statusline.pickHint')}</p>
        )}

        {key && seg && (
          <>
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <button
                onClick={() => onPatch(key, { enabled: !seg.enabled })}
                className={cn(
                  'rounded px-2 py-0.5',
                  seg.enabled
                    ? 'bg-emerald-900/50 text-emerald-300'
                    : 'bg-neutral-800 text-neutral-500',
                )}
              >
                {seg.enabled ? t('statusline.enabled') : t('statusline.disabled')}
              </button>
              <button
                onClick={() => onPatch(key, { bold: !seg.bold })}
                className={cn(
                  'rounded px-2 py-0.5',
                  seg.bold
                    ? 'bg-neutral-800 text-neutral-100 font-bold'
                    : 'text-neutral-500 hover:text-neutral-300',
                )}
                title={t('statusline.bold')}
              >
                B
              </button>
              <label
                className={cn(
                  'flex cursor-pointer items-center gap-1 rounded px-2 py-0.5',
                  seg.merge
                    ? 'bg-neutral-800 text-neutral-200'
                    : 'text-neutral-500 hover:text-neutral-300',
                )}
                title={t('statusline.mergeHint')}
              >
                <input
                  type="checkbox"
                  checked={seg.merge}
                  onChange={(e) => onPatch(key, { merge: e.target.checked })}
                  className="hidden"
                />
                {t('statusline.merge')}
              </label>
              <input
                value={seg.icon}
                onChange={(e) => onPatch(key, { icon: e.target.value })}
                placeholder={t('statusline.iconPlaceholder')}
                className="ml-auto w-14 rounded bg-neutral-800 px-1.5 py-0.5 text-center font-mono text-xs"
                title={t('statusline.iconHint')}
              />
            </div>

            {key === 'context' && (
              <div className="flex items-center gap-1.5 text-xs text-neutral-400">
                <span className="w-10 text-neutral-600">{t('statusline.fieldStyle')}</span>
                {BAR_STYLES.map((st) => (
                  <button
                    key={st.key}
                    onClick={() => onPatch(key, { style: st.key })}
                    className={cn(
                      'rounded px-1.5 py-0.5',
                      (seg.style ?? 'both') === st.key
                        ? 'bg-neutral-800 text-neutral-100'
                        : 'text-neutral-500 hover:text-neutral-300',
                    )}
                    title={t(st.labelKey)}
                  >
                    {t(st.labelKey)}
                  </button>
                ))}
              </div>
            )}
            {key === 'tokens' && (
              <div className="flex items-center gap-1.5 text-xs text-neutral-400">
                <span className="w-10 text-neutral-600">{t('statusline.fieldMetric')}</span>
                {TOKEN_METRICS.map((m) => (
                  <button
                    key={m.key}
                    onClick={() => onPatch(key, { metric: m.key })}
                    className={cn(
                      'rounded px-1.5 py-0.5',
                      (seg.metric ?? 'session') === m.key
                        ? 'bg-neutral-800 text-neutral-100'
                        : 'text-neutral-500 hover:text-neutral-300',
                    )}
                    title={t(m.titleKey)}
                  >
                    {t(m.labelKey)}
                  </button>
                ))}
              </div>
            )}

            {key === 'rate' && (
              <div className="flex items-center gap-1.5 text-xs text-neutral-400">
                <span className="w-10 text-neutral-600">{t('statusline.fieldWindow')}</span>
                {RATE_WINDOWS.map((w) => (
                  <button
                    key={w.key}
                    onClick={() => onPatch(key, { window: w.key })}
                    className={cn(
                      'rounded px-1.5 py-0.5',
                      (seg.window ?? 'five_hour') === w.key
                        ? 'bg-neutral-800 text-neutral-100'
                        : 'text-neutral-500 hover:text-neutral-300',
                    )}
                    title={t(w.titleKey)}
                  >
                    {t(w.labelKey)}
                  </button>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2 text-xs">
              <span className="w-10 text-neutral-600">{t('statusline.fgBg')}</span>
              <ColorPicker
                value={seg.color}
                editable
                onChange={(c) => onPatch(key, { color: c })}
              />
              <ColorPicker
                value={seg.backgroundColor}
                editable
                allowNone
                noneSelected={seg.backgroundColor === null}
                onNone={() => onPatch(key, { backgroundColor: null })}
                onChange={(c) => onPatch(key, { backgroundColor: c })}
              />
            </div>

            <div className="flex items-center gap-2 text-xs">
              <span className="w-10 text-neutral-600">{t('statusline.fieldLabel')}</span>
              <input
                value={seg.label ?? ''}
                onChange={(e) => onPatch(key, { label: e.target.value })}
                placeholder={t('statusline.labelPlaceholder')}
                className="w-24 rounded bg-neutral-800 px-1.5 py-0.5 font-mono"
                title={t('statusline.labelInputHint')}
              />
              <span className="text-neutral-600">{t('statusline.fieldFormat')}</span>
              <input
                value={seg.format ?? ''}
                onChange={(e) => onPatch(key, { format: e.target.value })}
                placeholder={SEGMENT_DEFAULT_FORMAT[key]}
                className="min-w-0 flex-1 rounded bg-neutral-800 px-1.5 py-0.5 font-mono"
                title={t('statusline.tokensTitle', {
                  tokens: SEGMENT_TOKENS[key].map((tok) => '{' + tok + '}').join(' '),
                })}
              />
            </div>

            <div className="flex items-center justify-between border-t border-white/[0.06] pt-2">
              <button
                onClick={onUnplace}
                className="rounded px-2 py-1 text-xs text-red-400/80 hover:bg-red-900/30 hover:text-red-300"
                title={t('statusline.unplaceHint')}
              >
                {t('statusline.unplace')}
              </button>
              <button
                onClick={onClose}
                className="rounded bg-blue-900/50 px-3 py-1 text-xs text-blue-200 hover:bg-blue-900/70"
              >
                {t('statusline.done')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
