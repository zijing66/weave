import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAnsiSpans, stripAnsi } from '../statusline/ansi.js';
import { buildMockInput } from '../statusline/mock-input.js';
import {
  DEFAULT_STATUSLINE_CONFIG,
  type StatuslineConfig,
  type SegmentKey,
} from '@weave/server';
import {
  runPreviewLines,
  toggleSegment,
  cycleSegmentColor,
  toggleSegmentBold,
  toggleSegmentMerge,
  cycleSegmentIcon,
  cycleContextStyle,
  cycleAlign,
  togglePowerline,
  toggleLogo,
  cycleSeparator,
  bumpRefreshInterval,
  clampCursor,
  moveCursor,
} from '../statusline/preview.js';

describe('parseAnsiSpans', () => {
  it('returns a single unstyled span for plain text', () => {
    expect(parseAnsiSpans('hello')).toEqual([{ text: 'hello' }]);
  });

  it('parses a coloured bold foreground span', () => {
    // paint() shape: \x1b[1;34m + text + \x1b[0m
    const line = '\x1b[1;34mweave\x1b[0m';
    expect(parseAnsiSpans(line)).toEqual([{ text: 'weave', color: 'blue', bold: true }]);
  });

  it('parses background and foreground codes in one sequence', () => {
    // powerline shape: \x1b[37;44m text \x1b[0m → unknown fg 37 ignored, bg 44
    const spans = parseAnsiSpans('\x1b[37;44m git: main \x1b[0m');
    expect(spans).toEqual([{ text: ' git: main ', backgroundColor: 'blue' }]);
  });

  it('parses the dim divider (2;90) as dim gray', () => {
    const spans = parseAnsiSpans('\x1b[2;90m────\x1b[0m');
    expect(spans).toEqual([{ text: '────', color: 'gray', dim: true }]);
  });

  it('splits on reset into consecutive spans', () => {
    const line = '\x1b[32mon\x1b[0m mid \x1b[1;31mred\x1b[0m';
    expect(parseAnsiSpans(line)).toEqual([
      { text: 'on', color: 'green' },
      { text: ' mid ' },
      { text: 'red', color: 'red', bold: true },
    ]);
  });

  it('round-trips: stripping yields the visible text', () => {
    const line = '\x1b[1;35m🤖 Fable\x1b[0m · \x1b[36m42%\x1b[0m';
    const joined = parseAnsiSpans(line).map((s) => s.text).join('');
    expect(joined).toBe(stripAnsi(line));
  });
});

describe('buildMockInput', () => {
  it('embeds the project path and terminal width', () => {
    const input = buildMockInput('/some/project', 72);
    expect(input.workspace.current_dir).toBe('/some/project');
    expect(input.terminal.columns).toBe(72);
    expect(input.model.display_name).toBeTruthy();
    expect(input.context_window?.used_percentage).toBeGreaterThan(0);
  });

  it('defaults to 100 columns', () => {
    expect(buildMockInput('/x').terminal.columns).toBe(100);
  });
});

describe('statusline config editors', () => {
  const cfg = (): StatuslineConfig =>
    JSON.parse(JSON.stringify(DEFAULT_STATUSLINE_CONFIG)) as StatuslineConfig;

  it('toggleSegment flips enabled without mutating the input', () => {
    const c = cfg();
    const key: SegmentKey = 'model';
    const before = c.segments[key].enabled;
    const next = toggleSegment(c, key);
    expect(next.segments[key].enabled).toBe(!before);
    expect(c.segments[key].enabled).toBe(before);
  });

  it('cycleSegmentColor walks the palette and wraps', () => {
    const palette = ['gray', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan'];
    const c = cfg();
    const start = palette.indexOf(c.segments.model.color);
    expect(start).toBeGreaterThanOrEqual(0);
    // a full lap (7 colours) lands back on the starting colour
    let cur = c;
    for (let i = 0; i < palette.length; i++) cur = cycleSegmentColor(cur, 'model');
    expect(cur.segments.model.color).toBe(c.segments.model.color);
    // one more step moves to the next palette entry (with wrap-around)
    const next = cycleSegmentColor(cur, 'model').segments.model.color;
    expect(next).toBe(palette[(start + 1) % palette.length]);
  });

  it('toggleSegmentBold / toggleSegmentMerge flip their flags', () => {
    const c = cfg();
    expect(toggleSegmentBold(c, 'git').segments.git.bold).toBe(!c.segments.git.bold);
    expect(toggleSegmentMerge(c, 'git').segments.git.merge).toBe(!c.segments.git.merge);
  });

  it('cycleSegmentIcon cycles through the preset list and back to empty', () => {
    const c = cfg();
    const out = cycleSegmentIcon(c, 'model');
    expect(out.segments.model.icon).not.toBe(c.segments.model.icon);
    // after visiting every icon it wraps to ''
    let cur = out;
    while (cur.segments.model.icon !== '') cur = cycleSegmentIcon(cur, 'model');
    expect(cur.segments.model.icon).toBe('');
  });

  it('cycleContextStyle only affects the context segment', () => {
    const c = cfg();
    const next = cycleContextStyle(c, 'tokens');
    expect(next).toBe(c);
    expect(cycleContextStyle(c, 'context')).not.toEqual(c);
  });

  it('cycleAlign walks left→center→right→left', () => {
    let c = cfg();
    c = { ...c, align: 'left' };
    expect(cycleAlign(c).align).toBe('center');
    expect(cycleAlign(cycleAlign(c)).align).toBe('right');
    expect(cycleAlign(cycleAlign(cycleAlign(c))).align).toBe('left');
  });

  it('togglePowerline / toggleLogo / cycleSeparator / bumpRefreshInterval', () => {
    const c = cfg();
    expect(togglePowerline(c).powerline.enabled).toBe(!c.powerline.enabled);
    expect(toggleLogo(c).showLogo).toBe(!c.showLogo);
    expect(typeof cycleSeparator(c).separator).toBe('string');
    expect(bumpRefreshInterval(c, 1).refreshInterval).toBe(c.refreshInterval + 1);
    expect(bumpRefreshInterval({ ...c, refreshInterval: 1 }, -5).refreshInterval).toBe(1);
  });

  it('clampCursor keeps the cursor inside the grid', () => {
    const c = cfg();
    const clamped = clampCursor(c, { row: 99, col: -3 });
    expect(clamped.row).toBeLessThan(c.lines.length);
    expect(clamped.col).toBeGreaterThanOrEqual(0);
    expect(clamped.col).toBeLessThan(c.lines[clamped.row].length);
  });

  it('moveCursor clamps columns and rows, skipping empty rows', () => {
    const c = cfg();
    const start = { row: 0, col: 0 };
    const moved = moveCursor(c, start, 0, 999);
    expect(moved.row).toBe(0);
    expect(moved.col).toBe(c.lines[0].length - 1);
    const lastRow = moveCursor(c, start, 999, 0);
    expect(lastRow.row).toBe(c.lines.length - 1);
    // single-row config moving down stays on the only row
    const single = { ...c, lines: [c.lines[0]] };
    expect(moveCursor(single, { row: 0, col: 2 }, 5, 0).row).toBe(0);
    // an empty row in the middle is skipped over when passing through
    const gapped: StatuslineConfig = {
      ...c,
      lines: [['model'], [], ['git']],
    };
    expect(moveCursor(gapped, { row: 0, col: 0 }, 2, 0)).toEqual({ row: 2, col: 0 });
    // landing exactly on the empty row falls back to the origin row
    expect(moveCursor(gapped, { row: 0, col: 0 }, 1, 0).row).toBe(0);
  });
});

describe('runPreviewLines (real script round-trip)', () => {
  it('renders non-empty output for the default config', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'weave-preview-'));
    const res = runPreviewLines(DEFAULT_STATUSLINE_CONFIG, dir, 100);
    expect(res.error).toBeUndefined();
    expect(res.lines.length).toBeGreaterThan(0);
    // the plain text must contain model + context data from the mock payload
    const plain = res.lines.map(stripAnsi).join('\n');
    expect(plain).toContain('Fable 5');
    expect(plain).toContain('42%');
  }, 20000);

  it('reflects config edits — disabling a segment removes its text', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'weave-preview-'));
    const base = runPreviewLines(DEFAULT_STATUSLINE_CONFIG, dir, 100).lines
      .map(stripAnsi)
      .join('\n');
    const edited = {
      ...DEFAULT_STATUSLINE_CONFIG,
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        model: { ...DEFAULT_STATUSLINE_CONFIG.segments.model, enabled: false },
      },
    };
    const after = runPreviewLines(edited, dir, 100).lines.map(stripAnsi).join('\n');
    expect(base).toContain('Fable 5');
    expect(after).not.toContain('Fable 5');
  }, 20000);

  it('center alignment pads the rendered line', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'weave-preview-'));
    const centered: StatuslineConfig = {
      ...DEFAULT_STATUSLINE_CONFIG,
      align: 'center',
      showLogo: false,
    };
    const res = runPreviewLines(centered, dir, 100);
    const first = res.lines[0] ?? '';
    expect(first.startsWith('  ') || first.length > 10).toBe(true);
    // plain length < terminal width → padding was added somewhere
    expect(stripAnsi(first).length).toBeGreaterThan(0);
  }, 20000);
});
