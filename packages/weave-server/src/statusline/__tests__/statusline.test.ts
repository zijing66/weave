import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateStatuslineScript } from '../generator.js';
import { DEFAULT_STATUSLINE_CONFIG, type SegmentKey } from '../config.js';
import {
  readStatuslineConfig,
  applyStatuslineConfig,
  ensureSettingsStatusLine,
  readGlobalStatuslineConfig,
  writeGlobalStatuslineConfig,
  setGlobalStatuslineDir,
} from '../manager.js';

function runScript(script: string, stdin: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'weave-sl-run-'));
  const file = join(dir, 'statusline.cjs');
  writeFileSync(file, script);
  const r = spawnSync(process.execPath, [file], {
    input: JSON.stringify(stdin),
    encoding: 'utf8',
  });
  rmSync(dir, { recursive: true, force: true });
  return r.stdout;
}

describe('statusline — generator', () => {
  it('emits a shebanged node script embedding the config', () => {
    const script = generateStatuslineScript(DEFAULT_STATUSLINE_CONFIG);
    expect(script.startsWith('#!/usr/bin/env node')).toBe(true);
    expect(script).toContain('CONFIG = ');
    expect(script).toContain('require(');
  });

  it('only renders enabled segment branches', () => {
    const cfg = {
      ...DEFAULT_STATUSLINE_CONFIG,
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        time: { ...DEFAULT_STATUSLINE_CONFIG.segments.time, enabled: true },
      },
    };
    const script = generateStatuslineScript(cfg);
    expect(script).toContain('toLocaleTimeString');
  });

  it('embeds logo text and renders a logo branch', () => {
    const script = generateStatuslineScript(DEFAULT_STATUSLINE_CONFIG);
    expect(script).toContain('showLogo');
    expect(script).toContain(DEFAULT_STATUSLINE_CONFIG.logoText);
  });

  it('multiple lines emit a divider between rows', () => {
    const cfg: typeof DEFAULT_STATUSLINE_CONFIG = {
      ...DEFAULT_STATUSLINE_CONFIG,
      lines: [
        ['project', 'git'],
        ['tokens'],
      ],
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        tokens: { ...DEFAULT_STATUSLINE_CONFIG.segments.tokens, enabled: true },
      },
    };
    const script = generateStatuslineScript(cfg);
    expect(script).toContain('rows.length');
    expect(script).toContain('DIVIDER');
  });
});

describe('statusline — manager', () => {
  let dir: string;
  let home: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'weave-sl-'));
    home = mkdtempSync(join(tmpdir(), 'weave-sl-home-'));
    setGlobalStatuslineDir(home);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('returns the global default config when none exists', async () => {
    const cfg = await readStatuslineConfig(dir);
    expect(cfg.source).toBe('global');
    expect(cfg.segments.project.enabled).toBe(true);
    expect(cfg.segments.tokens.enabled).toBe(false);
    expect(cfg.lines[0]).toContain('context');
    expect(cfg.refreshInterval).toBe(10);
  });

  it('defaults new powerline/source/lines fields on a legacy partial config', async () => {
    mkdirSync(join(dir, '.weave'), { recursive: true });
    writeFileSync(
      join(dir, '.weave/statusline.json'),
      JSON.stringify({ layout: 'single', segments: { project: { enabled: true, color: 'cyan', bold: true } } }),
    );
    const cfg = await readStatuslineConfig(dir);
    // a legacy file with no source resolves to the global template
    expect(cfg.source).toBe('global');
    expect(cfg.powerline.enabled).toBe(false);
    expect(cfg.align).toBe('left');
    expect(cfg.segments.project.icon).toBe('📁');
    expect(cfg.segments.project.backgroundColor).toBeNull();
    expect(cfg.segments.project.merge).toBe(false);
    // legacy single layout migrates to a single full-width row
    expect(cfg.lines).toEqual([DEFAULT_STATUSLINE_CONFIG.lines[0]]);
  });

  it('powerline glyph fields round-trip through config normalisation', async () => {
    mkdirSync(join(dir, '.weave'), { recursive: true });
    writeFileSync(
      join(dir, '.weave/statusline.json'),
      JSON.stringify({
        source: 'custom',
        powerline: { enabled: true, separator: '', startCap: '', endCap: '' },
      }),
    );
    const cfg = await readStatuslineConfig(dir);
    expect(cfg.powerline.enabled).toBe(true);
    expect(cfg.powerline.separator).toBe(''); // preserved verbatim
    expect(cfg.powerline.startCap).toBe(''); // explicit empty = disabled cap
    expect(cfg.powerline.endCap).toBe('');
  });

  it('migrates a legacy multi layout into the two old rows', async () => {
    mkdirSync(join(dir, '.weave'), { recursive: true });
    writeFileSync(
      join(dir, '.weave/statusline.json'),
      JSON.stringify({ source: 'custom', layout: 'multi', order: ['project', 'git', 'model', 'context', 'tokens', 'cost', 'rate'] }),
    );
    const read = await readStatuslineConfig(dir);
    expect(read.lines[0]).toContain('project');
    expect(read.lines[1]).toContain('context');
  });

  it('writes refreshInterval into settings.statusLine', async () => {
    await applyStatuslineConfig(dir, { ...DEFAULT_STATUSLINE_CONFIG, source: 'custom', refreshInterval: 5 });
    const settings = JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf-8'));
    expect(settings.statusLine.refreshInterval).toBe(5);
  });

  it('a custom project config is kept and read back', async () => {
    const cfg: typeof DEFAULT_STATUSLINE_CONFIG = {
      ...DEFAULT_STATUSLINE_CONFIG,
      source: 'custom',
      separator: ' / ',
    };
    await applyStatuslineConfig(dir, cfg);
    const file = JSON.parse(readFileSync(join(dir, '.weave/statusline.json'), 'utf-8'));
    expect(file.source).toBe('custom');
    expect(file.separator).toBe(' / ');
    const read = await readStatuslineConfig(dir);
    expect(read.source).toBe('custom');
    expect(read.separator).toBe(' / ');
  });

  it('a following project stores only the source marker and renders from global', async () => {
    await writeGlobalStatuslineConfig({ ...DEFAULT_STATUSLINE_CONFIG, logoText: '▊ GLOBAL' });
    await applyStatuslineConfig(dir, { ...DEFAULT_STATUSLINE_CONFIG, source: 'global' });
    const file = JSON.parse(readFileSync(join(dir, '.weave/statusline.json'), 'utf-8'));
    expect(file.source).toBe('global');
    expect(file.segments).toBeUndefined(); // full config is NOT persisted locally
    const script = readFileSync(join(dir, '.claude/helpers/statusline.cjs'), 'utf-8');
    expect(script).toContain('▊ GLOBAL'); // generated from the global template
  });

  it('global template round-trips', async () => {
    await writeGlobalStatuslineConfig({ ...DEFAULT_STATUSLINE_CONFIG, separator: ' # ' });
    const read = await readGlobalStatuslineConfig();
    expect(read.separator).toBe(' # ');
    expect(read.source).toBe('global');
  });

  it('applyStatuslineConfig writes config + script + settings', async () => {
    await applyStatuslineConfig(dir, { ...DEFAULT_STATUSLINE_CONFIG, source: 'custom' });
    const script = readFileSync(join(dir, '.claude/helpers/statusline.cjs'), 'utf-8');
    expect(script).toContain('weave statusline');
    const settings = JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf-8'));
    expect(settings.statusLine.type).toBe('command');
    expect(String(settings.statusLine.command)).toContain('statusline.cjs');
  });

  it('ensureSettingsStatusLine preserves existing settings', async () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(
      join(dir, '.claude/settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(x)'] } }),
    );
    await ensureSettingsStatusLine(dir);
    const settings = JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf-8'));
    expect(settings.permissions.allow).toContain('Bash(x)');
    expect(settings.statusLine.command).toContain('statusline.cjs');
  });
});

describe('statusline — runtime output', () => {
  const stdin = {
    model: { display_name: 'claude-sonnet-5' },
    workspace: { current_dir: '/tmp/my-project' },
  };

  it('single layout renders the logo + segments on one line', () => {
    const out = runScript(generateStatuslineScript(DEFAULT_STATUSLINE_CONFIG), stdin);
    expect(out).toContain('▊ weave');
    expect(out).toContain('my-project');
    expect(out).toContain('claude-sonnet-5');
    // single layout is a single physical line
    expect(out.trim()).not.toContain('\n');
  });

  it('renders the default segment icons', () => {
    const out = runScript(generateStatuslineScript(DEFAULT_STATUSLINE_CONFIG), stdin);
    expect(out).toContain('📁');
    expect(out).toContain('🤖');
  });

  it('multiple lines render as rows separated by a divider', () => {
    const cfg = {
      ...DEFAULT_STATUSLINE_CONFIG,
      lines: [
        ['project', 'git', 'model'],
        ['tokens', 'cost'],
      ],
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        tokens: { ...DEFAULT_STATUSLINE_CONFIG.segments.tokens, enabled: true },
        cost: { ...DEFAULT_STATUSLINE_CONFIG.segments.cost, enabled: true },
      },
    };
    const out = runScript(generateStatuslineScript(cfg), {
      ...stdin,
      total_cost_usd: 1.234,
      usage: { input_tokens: 12000 },
    });
    const lines = out.split('\n');
    expect(lines.length).toBe(3); // row1, divider, row2
    expect(lines[0]).toContain('▊ weave');
    expect(lines[0]).toContain('my-project');
    expect(lines[1]).toContain('──');
    expect(lines[2]).toContain('12k');
    expect(lines[2]).toContain('$1.23');
  });

  it('omits the logo when showLogo is false', () => {
    const cfg = { ...DEFAULT_STATUSLINE_CONFIG, showLogo: false };
    const out = runScript(generateStatuslineScript(cfg), stdin);
    expect(out).not.toContain('▊ weave');
    expect(out).toContain('my-project');
  });

  it('context segment renders percent + progress bar from used_percentage', () => {
    const cfg = {
      ...DEFAULT_STATUSLINE_CONFIG,
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        context: { ...DEFAULT_STATUSLINE_CONFIG.segments.context, enabled: true, style: 'both' as const },
      },
    };
    const out = runScript(generateStatuslineScript(cfg), {
      ...stdin,
      context_window: { used_percentage: 78 },
    });
    expect(out).toContain('78%');
    expect(out).toContain('█'); // filled progress bar cell
    expect(out).toContain('░'); // empty progress bar cell
  });

  it('context segment can render as a bare percentage or a bare bar', () => {
    const base = {
      ...DEFAULT_STATUSLINE_CONFIG,
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        context: { ...DEFAULT_STATUSLINE_CONFIG.segments.context, enabled: true },
      },
    };
    const percent = runScript(generateStatuslineScript({ ...base, segments: { ...base.segments, context: { ...base.segments.context, style: 'percent' } } }), {
      ...stdin,
      context_window: { used_percentage: 50 },
    });
    expect(percent).toContain('50%');
    expect(percent).not.toContain('█');

    const bar = runScript(generateStatuslineScript({ ...base, segments: { ...base.segments, context: { ...base.segments.context, style: 'bar' } } }), {
      ...stdin,
      context_window: { used_percentage: 50 },
    });
    expect(bar).toContain('█');
    expect(bar).not.toContain('%');
  });

  it('thinking + rate segments render from stdin fields', () => {
    const cfg = {
      ...DEFAULT_STATUSLINE_CONFIG,
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        thinking: { ...DEFAULT_STATUSLINE_CONFIG.segments.thinking, enabled: true },
        rate: { ...DEFAULT_STATUSLINE_CONFIG.segments.rate, enabled: true },
      },
    };
    const out = runScript(generateStatuslineScript(cfg), {
      ...stdin,
      effort: { level: 'high' },
      rate_limits: { five_hour: { used_percentage: 45 } },
    });
    expect(out).toContain('high');
    expect(out).toContain('5h 45%');
  });

  it('renders segments in the row order', () => {
    const cfg = {
      ...DEFAULT_STATUSLINE_CONFIG,
      lines: [['model', 'project']] as SegmentKey[][],
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        time: { ...DEFAULT_STATUSLINE_CONFIG.segments.time, enabled: false },
      },
    };
    const out = runScript(generateStatuslineScript(cfg), stdin);
    const iModel = out.indexOf('claude-sonnet-5');
    const iProject = out.indexOf('my-project');
    expect(iModel).toBeGreaterThan(-1);
    expect(iProject).toBeGreaterThan(iModel); // model first, project second
  });

  it('powerline mode emits background colour codes and no separator', () => {
    const cfg = {
      ...DEFAULT_STATUSLINE_CONFIG,
      powerline: { enabled: true },
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        project: { ...DEFAULT_STATUSLINE_CONFIG.segments.project, backgroundColor: 'cyan' },
        model: { ...DEFAULT_STATUSLINE_CONFIG.segments.model, backgroundColor: 'blue' },
      },
    };
    const out = runScript(generateStatuslineScript(cfg), stdin);
    expect(out).toContain(';46m'); // cyan background
    expect(out).toContain(';44m'); // blue background
    expect(out).not.toContain('│'); // blocks join via chevrons/gaps, never '│'
  });

  it('powerline bridges adjacent blocks with chevron glyphs and caps the row', () => {
    const cfg = {
      ...DEFAULT_STATUSLINE_CONFIG,
      powerline: { enabled: true },
      showLogo: false,
      lines: [['project', 'model']] as SegmentKey[][],
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        project: { ...DEFAULT_STATUSLINE_CONFIG.segments.project, backgroundColor: 'cyan' },
        model: { ...DEFAULT_STATUSLINE_CONFIG.segments.model, backgroundColor: 'blue' },
      },
    };
    const out = runScript(generateStatuslineScript(cfg), stdin);
    // join glyph: fg = previous block's bg (cyan), bg = next block's bg (blue)
    expect(out).toContain('36;44m');
    // start cap in the first block's bg (cyan), end cap in the last (blue)
    expect(out).toContain('\x1b[36m');
    expect(out).toContain('\x1b[34m');
  });

  it('powerline glyphs are configurable — round separator, disabled caps', () => {
    const cfg = {
      ...DEFAULT_STATUSLINE_CONFIG,
      powerline: { enabled: true, separator: '', startCap: '', endCap: '' },
      showLogo: false,
      lines: [['project', 'model']] as SegmentKey[][],
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        project: { ...DEFAULT_STATUSLINE_CONFIG.segments.project, backgroundColor: 'cyan' },
        model: { ...DEFAULT_STATUSLINE_CONFIG.segments.model, backgroundColor: 'blue' },
      },
    };
    const out = runScript(generateStatuslineScript(cfg), stdin);
    expect(out).toContain(''); // round join glyph between blocks
    expect(out).not.toContain(''); // triangle join replaced
    expect(out).not.toContain(''); // start cap disabled
  });

  it('powerline glyph fields undefined fall back to the triangle set', () => {
    const cfg = {
      ...DEFAULT_STATUSLINE_CONFIG,
      powerline: { enabled: true },
      showLogo: false,
      lines: [['project']] as SegmentKey[][],
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        project: { ...DEFAULT_STATUSLINE_CONFIG.segments.project, backgroundColor: 'cyan' },
      },
    };
    const out = runScript(generateStatuslineScript(cfg), stdin);
    expect(out).toContain(''); // default start cap
    expect(out).toContain(''); // default end cap
  });

  it('merge segments inherit the next block background', () => {
    const cfg = {
      ...DEFAULT_STATUSLINE_CONFIG,
      powerline: { enabled: true },
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        project: { ...DEFAULT_STATUSLINE_CONFIG.segments.project, backgroundColor: null, merge: true },
        model: { ...DEFAULT_STATUSLINE_CONFIG.segments.model, backgroundColor: 'blue' },
      },
    };
    const out = runScript(generateStatuslineScript(cfg), stdin);
    const projIdx = out.indexOf('my-project');
    expect(projIdx).toBeGreaterThan(-1);
    expect(out.slice(Math.max(0, projIdx - 40), projIdx)).toContain(';44m');
  });

  it('align right pads the line to the terminal width', () => {
    const cfg = { ...DEFAULT_STATUSLINE_CONFIG, align: 'right' as const };
    const out = runScript(generateStatuslineScript(cfg), stdin);
    expect(out).toMatch(/^\x1b\[0m {5,}/); // leading reset, then right-align padding
    expect(out.trimEnd()).toContain('claude-sonnet-5');
  });

  it('align center pads both sides', () => {
    const cfg = { ...DEFAULT_STATUSLINE_CONFIG, align: 'center' as const };
    const out = runScript(generateStatuslineScript(cfg), stdin);
    expect(out.trim()).toContain('claude-sonnet-5');
    expect(out).toMatch(/^\x1b\[0m {10,}/); // leading reset, then centring padding
  });
});
