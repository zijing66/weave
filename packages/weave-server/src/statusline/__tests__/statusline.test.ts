import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateStatuslineScript } from '../generator.js';
import {
  DEFAULT_STATUSLINE_CONFIG,
  PLAIN_STATUSLINE_CONFIG,
  SEGMENT_DEFAULT_FORMAT,
  SEGMENT_ORDER,
  SEGMENT_TOKENS,
  type SegmentKey,
} from '../config.js';
import { WEAVE_VERSION } from '../../version.js';
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

  it('embeds the logo text and the weave version', () => {
    const script = generateStatuslineScript(DEFAULT_STATUSLINE_CONFIG);
    expect(script).toContain(DEFAULT_STATUSLINE_CONFIG.logoText);
    expect(script).toContain(`const WEAVE_VERSION = "${WEAVE_VERSION}"`);
  });

  it('renders the version into the logo rather than a toggle', () => {
    const out = runScript(generateStatuslineScript(DEFAULT_STATUSLINE_CONFIG), {
      model: { display_name: 'claude-sonnet-5' },
      workspace: { current_dir: '/tmp/my-project' },
    });
    expect(out).toContain(`▊ weave v${WEAVE_VERSION}`);
  });

  it('multiple lines emit the configured divider between rows', () => {
    const cfg: typeof DEFAULT_STATUSLINE_CONFIG = {
      ...DEFAULT_STATUSLINE_CONFIG,
      divider: '────',
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
    expect(script).toContain('CONFIG.divider');
  });

  it('draws no divider when the divider is empty', () => {
    const cfg: typeof DEFAULT_STATUSLINE_CONFIG = {
      ...DEFAULT_STATUSLINE_CONFIG,
      lines: [['project'], ['tokens']],
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        tokens: { ...DEFAULT_STATUSLINE_CONFIG.segments.tokens, enabled: true },
      },
    };
    const out = runScript(generateStatuslineScript(cfg), {
      model: { display_name: 'claude-sonnet-5' },
      workspace: { current_dir: '/tmp/my-project' },
    });
    // two content rows, nothing between them
    expect(out.split('\n')).toHaveLength(2);
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
    expect(cfg.segments.tokens.enabled).toBe(true);
    // the shipped default is three thematic rows; context sits on row 2
    expect(cfg.lines).toHaveLength(3);
    expect(cfg.lines[0]).toEqual(['model', 'thinking', 'time']);
    expect(cfg.lines[1]).toContain('context');
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
    expect(cfg.powerline.enabled).toBe(true);
    expect(cfg.align).toBe('left');
    expect(cfg.segments.project.icon).toBe('📁');
    expect(cfg.segments.project.backgroundColor).toBe('#2f334d'); // the shipped default
    expect(cfg.segments.project.merge).toBe(false);
    // a config with neither lines nor order falls back to the shipped rows
    expect(cfg.lines).toEqual(DEFAULT_STATUSLINE_CONFIG.lines);
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
    // logoText is pinned to the badge now, so the propagation marker is the
    // model label — rendered at runtime by the generated script's config.
    await writeGlobalStatuslineConfig({
      ...DEFAULT_STATUSLINE_CONFIG,
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        model: { ...DEFAULT_STATUSLINE_CONFIG.segments.model, label: 'GLOBMARK' },
      },
    });
    await applyStatuslineConfig(dir, { ...DEFAULT_STATUSLINE_CONFIG, source: 'global' });
    const file = JSON.parse(readFileSync(join(dir, '.weave/statusline.json'), 'utf-8'));
    expect(file.source).toBe('global');
    expect(file.segments).toBeUndefined(); // full config is NOT persisted locally
    const script = readFileSync(join(dir, '.claude/helpers/statusline.cjs'), 'utf-8');
    expect(script).toContain('GLOBMARK'); // generated from the global template
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

describe('statusline — config normalisation', () => {
  let dir: string;
  let home: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'weave-sl-norm-'));
    home = mkdtempSync(join(tmpdir(), 'weave-sl-norm-home-'));
    setGlobalStatuslineDir(home);
    mkdirSync(join(dir, '.weave'), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const writeCustom = (cfg: unknown): void => {
    writeFileSync(join(dir, '.weave/statusline.json'), JSON.stringify({ source: 'custom', ...(cfg as object) }));
  };

  it('trusts an explicit lines value so capsules can be unplaced', async () => {
    // The panel lets users remove a capsule from every row; that omission
    // must survive save/reload instead of being force-appended back.
    writeCustom({ lines: [['model'], ['context', 'project']] });
    const cfg = await readStatuslineConfig(dir);
    expect(cfg.lines).toEqual([['model'], ['context', 'project']]);
  });

  it('dedupes a segment key across rows and drops unknown keys', async () => {
    writeCustom({
      lines: [['model', 'model', 'not-a-segment'], ['model', 'git']],
    });
    const cfg = await readStatuslineConfig(dir);
    expect(cfg.lines).toEqual([['model'], ['git']]);
  });

  it('pins logoText to the shipped badge (only the colour is configurable)', async () => {
    writeCustom({ logoText: 'HACKED', logoColor: 'cyan' });
    const cfg = await readStatuslineConfig(dir);
    expect(cfg.logoText).toBe(DEFAULT_STATUSLINE_CONFIG.logoText);
    expect(cfg.logoColor).toBe('cyan'); // colour still round-trips
  });

  it('accepts the seven named colours', async () => {
    writeCustom({ segments: { project: { enabled: true, color: 'magenta' } } });
    const cfg = await readStatuslineConfig(dir);
    expect(cfg.segments.project.color).toBe('magenta');
  });

  it('accepts an indexed 256 colour', async () => {
    writeCustom({ segments: { project: { enabled: true, color: 'ansi256:196' } } });
    const cfg = await readStatuslineConfig(dir);
    expect(cfg.segments.project.color).toBe('ansi256:196');
  });

  it('rejects an out-of-range 256 index, falling back to the default', async () => {
    writeCustom({ segments: { project: { enabled: true, color: 'ansi256:999' } } });
    const cfg = await readStatuslineConfig(dir);
    expect(cfg.segments.project.color).toBe('#c0caf5'); // the project default
  });

  it('expands 3-digit hex and lowercases it', async () => {
    writeCustom({ segments: { project: { enabled: true, color: '#ABC' } } });
    const cfg = await readStatuslineConfig(dir);
    expect(cfg.segments.project.color).toBe('#aabbcc');
  });

  it('keeps a 6-digit hex verbatim (lowercased)', async () => {
    writeCustom({ segments: { project: { enabled: true, color: '#7AA2F7' } } });
    const cfg = await readStatuslineConfig(dir);
    expect(cfg.segments.project.color).toBe('#7aa2f7');
  });

  it('rejects a malformed colour instead of writing it through', async () => {
    writeCustom({ segments: { project: { enabled: true, color: '#zzzzzz' } } });
    const cfg = await readStatuslineConfig(dir);
    expect(cfg.segments.project.color).toBe('#c0caf5');
  });

  it('defaults bar and labelSeparator on a config that predates them', async () => {
    writeCustom({ segments: {} });
    const cfg = await readStatuslineConfig(dir);
    expect(cfg.bar).toEqual({ cells: 12, fill: '█', empty: '░' });
    expect(cfg.labelSeparator).toBe(': ');
  });

  it('clamps bar cells into 1-40 and falls back on empty glyphs', async () => {
    writeCustom({ bar: { cells: 999, fill: '', empty: '·' } });
    const cfg = await readStatuslineConfig(dir);
    expect(cfg.bar.cells).toBe(40);
    expect(cfg.bar.fill).toBe('█'); // empty glyph → default
    expect(cfg.bar.empty).toBe('·');
  });

  it('treats empty label/format as unset so no bare separator is rendered', async () => {
    writeCustom({ segments: { model: { enabled: true, label: '', format: '' } } });
    const cfg = await readStatuslineConfig(dir);
    expect(cfg.segments.model.label).toBeUndefined();
    expect(cfg.segments.model.format).toBeUndefined();
  });

  it('round-trips label, format and metric', async () => {
    writeCustom({
      segments: {
        model: { enabled: true, label: 'Model' },
        context: { enabled: true, format: '[{bar}] {used}/{total} ({percent}%)' },
        tokens: { enabled: true, metric: 'context' },
      },
    });
    const cfg = await readStatuslineConfig(dir);
    expect(cfg.segments.model.label).toBe('Model');
    expect(cfg.segments.context.format).toBe('[{bar}] {used}/{total} ({percent}%)');
    expect(cfg.segments.tokens.metric).toBe('context');
  });

  it('drops an unknown metric value', async () => {
    writeCustom({ segments: { tokens: { enabled: true, metric: 'nonsense' } } });
    const cfg = await readStatuslineConfig(dir);
    expect(cfg.segments.tokens.metric).toBeUndefined();
  });

  it('round-trips the rate window and drops an unknown one', async () => {
    writeCustom({ segments: { rate: { enabled: true, window: 'seven_day' } } });
    expect((await readStatuslineConfig(dir)).segments.rate.window).toBe('seven_day');
    writeCustom({ segments: { rate: { enabled: true, window: 'hourly' } } });
    expect((await readStatuslineConfig(dir)).segments.rate.window).toBeUndefined();
  });

  it('legacy seeding places enabled opt-in blocks but leaves disabled ones out', async () => {
    writeFileSync(
      join(dir, '.weave/statusline.json'),
      JSON.stringify({
        // no source → resolves as the global template; source custom reaches
        // mergeDefaults, where the legacy order→lines migration lives
        source: 'custom',
        layout: 'single',
        order: ['model'],
        segments: { vim: { enabled: true }, pr: { enabled: false } },
      }),
    );
    const cfg = await readStatuslineConfig(dir);
    expect(cfg.lines.flat()).toContain('vim');
    expect(cfg.lines.flat()).not.toContain('pr');
  });

  it('every segment key has token hints, a default format and a default segment', () => {
    for (const k of SEGMENT_ORDER) {
      expect(SEGMENT_TOKENS[k], `tokens for ${k}`).toBeDefined();
      expect(SEGMENT_DEFAULT_FORMAT[k], `format for ${k}`).toBeTruthy();
      expect(DEFAULT_STATUSLINE_CONFIG.segments[k], `segment for ${k}`).toBeDefined();
    }
  });
});


describe('statusline — default config golden output', () => {
  // Pins the exact rendering of the shipped default, ANSI stripped, so a change
  // to the default layout has to be a deliberate edit to this expectation.
  const stdin = {
    model: { display_name: 'claude-sonnet-5' },
    workspace: { current_dir: '/tmp/my-project' },
    effort: { level: 'high' },
    context_window: {
      total_input_tokens: 39000,
      context_window_size: 1000000,
      used_percentage: 4,
    },
    cost: { total_cost_usd: 0.45 },
    terminal: { columns: 200 },
  };

  it('renders the shipped three-row layout byte-for-byte (ANSI stripped)', () => {
    // The wall-clock segment is non-deterministic, so the golden run switches
    // it off; `ships the labelled…` pins that the shipped default ships it on.
    const cfg = {
      ...DEFAULT_STATUSLINE_CONFIG,
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        time: { ...DEFAULT_STATUSLINE_CONFIG.segments.time, enabled: false },
      },
    };
    const out = runScript(generateStatuslineScript(cfg), stdin);
    const plain = out
      .replace(/\x1b\[[0-9;]*m/g, '')
      // powerline blocks pad their text with a space on each side, and the
      // row caps are private-use glyphs — collapse both for a readable pin
      .replace(/[-]/g, '')
      .replace(/[ \t]+/g, ' ')
      .trim();

    expect(plain.split('\n').map((l) => l.trim())).toEqual([
      `▊ weave v${WEAVE_VERSION} 🤖 Model: claude-sonnet-5 🧩 Thinking: high`,
      `🧠 [█░░░░░░░░░░░] 39k/1.0M (4%) 💸 Cost: $0.45`,
      `📁 /tmp/my-project`,
    ]);
  });
});

describe('statusline — data segments', () => {
  const tmpDirs: string[] = [];
  const tmp = (prefix: string): string => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
  };
  afterEach(() => {
    while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  const tokensCfg = {
    ...DEFAULT_STATUSLINE_CONFIG,
    lines: [['tokens']] as SegmentKey[][],
    segments: {
      ...DEFAULT_STATUSLINE_CONFIG.segments,
      tokens: { ...DEFAULT_STATUSLINE_CONFIG.segments.tokens, enabled: true, label: 'Total' },
    },
  };
  const changesCfg = {
    ...DEFAULT_STATUSLINE_CONFIG,
    lines: [['changes']] as SegmentKey[][],
    segments: {
      ...DEFAULT_STATUSLINE_CONFIG.segments,
      changes: {
        ...DEFAULT_STATUSLINE_CONFIG.segments.changes,
        enabled: true,
        format: '(+{added}, -{deleted})',
      },
    },
  };

  /** One transcript record; Claude Code writes one per content block. */
  const usageLine = (id: string, input: number, output: number): string =>
    `${JSON.stringify({ message: { id, usage: { input_tokens: input, output_tokens: output } } })}\n`;

  it('counts each transcript message once, not once per content block', () => {
    const t = join(tmp('weave-sl-tr-'), 'session.jsonl');
    // msg_1 appears twice (two content blocks) with identical usage
    writeFileSync(t, usageLine('msg_1', 5000, 1000) + usageLine('msg_1', 5000, 1000) + usageLine('msg_2', 5000, 1000));
    const out = runScript(generateStatuslineScript(tokensCfg), {
      workspace: { current_dir: '/tmp/my-project' },
      transcript_path: t,
    });
    expect(out).toContain('Total: 12k'); // 6000 + 6000, not 18k
    expect(out).not.toContain('18k');
  });

  it('accumulates across appends without recounting earlier lines', () => {
    const t = join(tmp('weave-sl-tr-'), 'session.jsonl');
    writeFileSync(t, usageLine('msg_1', 5000, 1000));
    const first = runScript(generateStatuslineScript(tokensCfg), {
      workspace: { current_dir: '/tmp/my-project' },
      transcript_path: t,
    });
    expect(first).toContain('Total: 6k');

    appendFileSync(t, usageLine('msg_2', 5000, 1000));
    const second = runScript(generateStatuslineScript(tokensCfg), {
      workspace: { current_dir: '/tmp/my-project' },
      transcript_path: t,
    });
    expect(second).toContain('Total: 12k'); // previous 6k + the appended 6k
  });

  it('resets the running total when the transcript is rewritten', () => {
    const t = join(tmp('weave-sl-tr-'), 'session.jsonl');
    writeFileSync(t, usageLine('msg_1', 5000, 1000) + usageLine('msg_2', 5000, 1000));
    const before = runScript(generateStatuslineScript(tokensCfg), {
      workspace: { current_dir: '/tmp/my-project' },
      transcript_path: t,
    });
    expect(before).toContain('Total: 12k');

    // /compact can shrink the file — the cache must not keep the old total
    writeFileSync(t, usageLine('msg_3', 1000, 0));
    const after = runScript(generateStatuslineScript(tokensCfg), {
      workspace: { current_dir: '/tmp/my-project' },
      transcript_path: t,
    });
    expect(after).toContain('Total: 1k');
  });

  it('hides the tokens segment when no transcript is available', () => {
    const out = runScript(generateStatuslineScript(tokensCfg), {
      workspace: { current_dir: '/tmp/my-project' },
    });
    expect(out).not.toContain('Total');
  });

  it('reports added/deleted line counts from git', () => {
    const repo = tmp('weave-sl-git-');
    const git = (...args: string[]): void => {
      const r = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: repo, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    };
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    git('add', '-A');
    git('commit', '-qm', 'init');

    writeFileSync(join(repo, 'a.txt'), 'one\nthree\n'); // -two +three
    const out = runScript(generateStatuslineScript(changesCfg), {
      workspace: { current_dir: repo },
    });
    expect(out).toContain('(+1, -1)');
  });

  it('hides the changes segment outside a git repository', () => {
    const out = runScript(generateStatuslineScript(changesCfg), {
      workspace: { current_dir: tmp('weave-sl-nogit-') },
    });
    expect(out).not.toContain('(+');
  });
});

describe('statusline — shipped default layout', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  it('renders the reference layout across three rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-sl-ref-'));
    tmpDirs.push(dir);
    // a directory (not a repo) so git/changes have no data and drop out
    const cwd = join(dir, 'weave-cli');
    mkdirSync(cwd);

    const transcript = join(dir, 'session.jsonl');
    writeFileSync(
      transcript,
      `${JSON.stringify({ message: { id: 'm1', usage: { input_tokens: 24000 } } })}\n`,
    );

    const out = runScript(generateStatuslineScript(DEFAULT_STATUSLINE_CONFIG), {
      model: { display_name: 'deepseek-flash[1M]' },
      workspace: { current_dir: cwd },
      effort: { level: 'high' },
      context_window: {
        total_input_tokens: 39000,
        total_output_tokens: 0,
        context_window_size: 1000000,
        used_percentage: 4,
      },
      cost: { total_cost_usd: 0.45 },
      transcript_path: transcript,
      terminal: { columns: 200 },
    });

    expect(out).toContain('🤖 Model: deepseek-flash[1M]');
    expect(out).toContain('🧠 [█░░░░░░░░░░░] 39k/1.0M (4%)');
    expect(out).toContain('🧩 Thinking: high');
    expect(out).toContain('💸 Cost: $0.45');
    expect(out).toContain('🔢 Total: 24k');
    expect(out).toContain(`📁 ${cwd}`); // the default shows the full working directory
    // three content rows with dim dividers between them
    const rows = out.split('\n').filter((l) => !l.includes('──'));
    expect(rows.length).toBe(3);
    expect(rows[0]).toContain('Model:');
    expect(rows[0]).toContain('Thinking:');
    expect(rows[1]).toContain('🧠');
    expect(rows[2]).toContain('📁');
  });

  it('the plain variant drops the Nerd-Font glyphs but keeps the text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-sl-ref2-'));
    tmpDirs.push(dir);
    const cwd = join(dir, 'weave-cli');
    mkdirSync(cwd);

    const out = runScript(generateStatuslineScript(PLAIN_STATUSLINE_CONFIG), {
      model: { display_name: 'deepseek-flash[1M]' },
      workspace: { current_dir: cwd },
      effort: { level: 'high' },
      context_window: { total_input_tokens: 39000, context_window_size: 1000000, used_percentage: 4 },
      cost: { total_cost_usd: 0.45 },
    });

    expect(out).not.toContain(''); // no powerline chevrons
    expect(out).not.toContain('');
    expect(out).toContain('Model: deepseek-flash[1M]');
    expect(out).toContain('💸 Cost: $0.45');
  });

  it('ships the labelled, three-row layout as the default', () => {
    expect(DEFAULT_STATUSLINE_CONFIG.segments.model.label).toBe('Model');
    expect(DEFAULT_STATUSLINE_CONFIG.segments.tokens.label).toBe('Total');
    expect(DEFAULT_STATUSLINE_CONFIG.segments.tokens.metric).toBe('session');
    expect(DEFAULT_STATUSLINE_CONFIG.lines).toEqual([
      ['model', 'thinking', 'time'],
      ['context', 'tokens', 'cost', 'rate'],
      ['git', 'changes', 'project'],
    ]);
    // the clock ships enabled with its blue block (baked from the live config)
    expect(DEFAULT_STATUSLINE_CONFIG.segments.time.enabled).toBe(true);
    expect(DEFAULT_STATUSLINE_CONFIG.segments.time.backgroundColor).toBe('blue');
    // round caps ship by default (triangles remain the undefined fallback)
    expect(DEFAULT_STATUSLINE_CONFIG.powerline.startCap).toBe('\ue0b6');
    expect(DEFAULT_STATUSLINE_CONFIG.powerline.endCap).toBe('\ue0b4');
    expect(DEFAULT_STATUSLINE_CONFIG.bar).toEqual({ cells: 12, fill: '█', empty: '░' });
    expect(DEFAULT_STATUSLINE_CONFIG.powerline.enabled).toBe(true);
    expect(DEFAULT_STATUSLINE_CONFIG.divider).toBe('');
  });
});

describe('statusline — runtime output', () => {
  const stdin = {
    model: { display_name: 'claude-sonnet-5' },
    workspace: { current_dir: '/tmp/my-project' },
  };

  it('always renders the logo, stamped with the version', () => {
    const out = runScript(generateStatuslineScript(DEFAULT_STATUSLINE_CONFIG), stdin);
    expect(out).toContain(`▊ weave v${WEAVE_VERSION}`);
    expect(out).toContain('my-project');
    expect(out).toContain('claude-sonnet-5');
  });

  it('a single-row config renders one physical line', () => {
    const cfg = { ...DEFAULT_STATUSLINE_CONFIG, lines: [['project', 'model']] as SegmentKey[][] };
    const out = runScript(generateStatuslineScript(cfg), stdin);
    expect(out.trim()).not.toContain('\n');
    expect(out).toContain('claude-sonnet-5');
  });

  it('renders the default segment icons', () => {
    const out = runScript(generateStatuslineScript(DEFAULT_STATUSLINE_CONFIG), stdin);
    expect(out).toContain('📁');
    expect(out).toContain('🤖');
  });

  it('multiple lines render as rows separated by a divider', () => {
    const cfg = {
      ...DEFAULT_STATUSLINE_CONFIG,
      divider: '────',
      lines: [
        ['project', 'git', 'model'],
        ['tokens', 'cost'],
      ],
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        // `tokens` reports session-cumulative tokens by default (from the
        // transcript); this row exercises the context-window metric instead.
        tokens: { ...DEFAULT_STATUSLINE_CONFIG.segments.tokens, enabled: true, metric: 'context' as const },
        cost: { ...DEFAULT_STATUSLINE_CONFIG.segments.cost, enabled: true },
      },
    };
    const out = runScript(generateStatuslineScript(cfg), {
      ...stdin,
      total_cost_usd: 1.234,
      context_window: { total_input_tokens: 12000, total_output_tokens: 0 },
    });
    const lines = out.split('\n');
    expect(lines.length).toBe(3); // row1, divider, row2
    expect(lines[0]).toContain('▊ weave');
    expect(lines[0]).toContain('my-project');
    expect(lines[1]).toContain('──');
    expect(lines[2]).toContain('12k');
    expect(lines[2]).toContain('$1.23');
  });

  it('the logo text is configurable but cannot be hidden', () => {
    const cfg = { ...DEFAULT_STATUSLINE_CONFIG, logoText: 'W' };
    const out = runScript(generateStatuslineScript(cfg), stdin);
    expect(out).toContain(`W v${WEAVE_VERSION}`);
    expect(out).not.toContain('▊ weave');
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

  it('lights at least one bar cell for any non-zero percentage', () => {
    const cfg = {
      ...DEFAULT_STATUSLINE_CONFIG,
      lines: [['context']] as SegmentKey[][],
      bar: { cells: 12, fill: '█', empty: '░' },
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        context: {
          ...DEFAULT_STATUSLINE_CONFIG.segments.context,
          enabled: true,
          format: '[{bar}] ({percent}%)',
        },
      },
    };
    // 3% of 12 cells is 0.36 — must not round down to an all-empty bar.
    const low = runScript(generateStatuslineScript(cfg), {
      ...stdin,
      context_window: {
        total_input_tokens: 34200,
        total_output_tokens: 0,
        context_window_size: 1000000,
        used_percentage: 3,
      },
    });
    expect(low).toContain('[█░░░░░░░░░░░] (3%)');
    // 0% still renders a fully empty bar, not a false sliver of progress.
    const zero = runScript(generateStatuslineScript(cfg), {
      ...stdin,
      context_window: {
        total_input_tokens: 0,
        total_output_tokens: 0,
        context_window_size: 1000000,
        used_percentage: 0,
      },
    });
    expect(zero).toContain('[░░░░░░░░░░░░] (0%)');
  });

  it('context segment can render as a bare percentage or a bare bar', () => {
    const base = {
      ...DEFAULT_STATUSLINE_CONFIG,
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        context: { ...DEFAULT_STATUSLINE_CONFIG.segments.context, enabled: true, format: undefined },
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
      lines: [['project', 'model']] as SegmentKey[][],
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

  it('emits truecolor and 256-colour SGR sequences', () => {
    const cfg = {
      ...DEFAULT_STATUSLINE_CONFIG,
      // backgrounds only paint in powerline mode (blocks), so enable it here
      powerline: { enabled: true },
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        model: {
          ...DEFAULT_STATUSLINE_CONFIG.segments.model,
          color: '#7aa2f7' as const,
          backgroundColor: 'ansi256:236' as const,
        },
      },
    };
    const out = runScript(generateStatuslineScript(cfg), stdin);
    expect(out).toContain('38;2;122;162;247'); // #7aa2f7 as truecolor fg
    expect(out).toContain('48;5;236'); // ansi256:236 as indexed bg
  });

  it('expands a 3-digit hex colour', () => {
    const cfg = {
      ...DEFAULT_STATUSLINE_CONFIG,
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        model: { ...DEFAULT_STATUSLINE_CONFIG.segments.model, color: '#f80' as const },
      },
    };
    const out = runScript(generateStatuslineScript(cfg), stdin);
    expect(out).toContain('38;2;255;136;0');
  });

  it('degrades an unknown colour to white rather than emitting garbage', () => {
    const cfg = {
      ...DEFAULT_STATUSLINE_CONFIG,
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        model: { ...DEFAULT_STATUSLINE_CONFIG.segments.model, bold: false, color: 'chartreuse' as never },
      },
    };
    const out = runScript(generateStatuslineScript(cfg), stdin);
    expect(out).toContain('\x1b[37;'); // white fg, then the block background
    expect(out).toContain('claude-sonnet-5'); // still rendered
  });

  it('renders a label prefix ahead of the value', () => {
    const cfg = {
      ...DEFAULT_STATUSLINE_CONFIG,
      lines: [['model']] as SegmentKey[][],
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        model: { ...DEFAULT_STATUSLINE_CONFIG.segments.model, label: 'Model' },
      },
    };
    const out = runScript(generateStatuslineScript(cfg), stdin);
    expect(out).toContain('🤖 Model: claude-sonnet-5');
  });

  it('honours a custom labelSeparator', () => {
    const cfg = {
      ...DEFAULT_STATUSLINE_CONFIG,
      labelSeparator: ' » ',
      lines: [['model']] as SegmentKey[][],
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        model: { ...DEFAULT_STATUSLINE_CONFIG.segments.model, label: 'Model' },
      },
    };
    const out = runScript(generateStatuslineScript(cfg), stdin);
    expect(out).toContain('🤖 Model » claude-sonnet-5');
  });

  it('renders the reference bracketed context format with used/total', () => {
    const cfg = {
      ...DEFAULT_STATUSLINE_CONFIG,
      lines: [['context']] as SegmentKey[][],
      bar: { cells: 12, fill: '█', empty: '░' },
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        context: {
          ...DEFAULT_STATUSLINE_CONFIG.segments.context,
          enabled: true,
          format: '[{bar}] {used}/{total} ({percent}%)',
        },
      },
    };
    const out = runScript(generateStatuslineScript(cfg), {
      ...stdin,
      context_window: {
        total_input_tokens: 39000,
        total_output_tokens: 0,
        context_window_size: 1000000,
        used_percentage: 4,
      },
    });
    expect(out).toContain('[█░░░░░░░░░░░] 39k/1.0M (4%)');
  });

  it('honours custom bar cells and glyphs', () => {
    const cfg = {
      ...DEFAULT_STATUSLINE_CONFIG,
      lines: [['context']] as SegmentKey[][],
      bar: { cells: 4, fill: '▰', empty: '▱' },
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        context: { ...DEFAULT_STATUSLINE_CONFIG.segments.context, enabled: true, format: '{bar}' },
      },
    };
    const out = runScript(generateStatuslineScript(cfg), {
      ...stdin,
      context_window: { used_percentage: 50 },
    });
    expect(out).toContain('▰▰▱▱');
  });

  it('drops a segment whose format resolves to nothing', () => {
    const cfg = {
      ...DEFAULT_STATUSLINE_CONFIG,
      lines: [['model']] as SegmentKey[][],
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        model: { ...DEFAULT_STATUSLINE_CONFIG.segments.model, format: 'literal' },
      },
    };
    // unknown tokens collapse to '' — a template made only of them yields no text
    const cfgEmpty = {
      ...cfg,
      segments: {
        ...cfg.segments,
        model: { ...cfg.segments.model, format: '{nope}' },
      },
    };
    expect(runScript(generateStatuslineScript(cfg), stdin)).toContain('literal');
    expect(runScript(generateStatuslineScript(cfgEmpty), stdin)).not.toContain('claude-sonnet-5');
  });

  it('keeps the legacy context style rendering when no format is set', () => {
    const base = {
      ...DEFAULT_STATUSLINE_CONFIG,
      lines: [['context']] as SegmentKey[][],
    };
    const both = runScript(generateStatuslineScript(base), {
      ...stdin,
      context_window: { used_percentage: 30 },
    });
    expect(both).toContain('30%');
    expect(both).toContain('█');
  });

  it('align right pads the line to the terminal width', () => {
    const cfg = { ...DEFAULT_STATUSLINE_CONFIG, align: 'right' as const };
    const out = runScript(generateStatuslineScript(cfg), stdin);
    expect(out).toMatch(/^\x1b\[0m {5,}/); // leading reset, then right-align padding
    expect(out.trimEnd()).toContain('claude-sonnet-5');
  });

  const optInKeys: SegmentKey[] = [
    'version',
    'output_style',
    'session',
    'exceeds200k',
    'fast_mode',
    'vim',
    'pr',
    'worktree',
    'agent',
  ];

  const optInConfig = () => {
    const segments = { ...DEFAULT_STATUSLINE_CONFIG.segments };
    for (const k of optInKeys) segments[k] = { ...segments[k], enabled: true };
    return {
      ...DEFAULT_STATUSLINE_CONFIG,
      lines: [optInKeys] as SegmentKey[][],
      segments,
    };
  };

  it('renders every opt-in block when its payload field is present', () => {
    const out = runScript(generateStatuslineScript(optInConfig()), {
      ...stdin,
      version: '2.1.286',
      output_style: { name: 'explanatory' },
      session_name: 'feat-x',
      exceeds_200k_tokens: true,
      fast_mode: true,
      vim: { mode: 'INSERT' },
      pr: { number: 482, url: 'https://github.com/acme/weave/pull/482', review_state: 'approved' },
      worktree: { name: 'wt-next', branch: 'feat/y' },
      agent: { name: 'reviewer' },
    });
    expect(out).toContain('2.1.286');
    expect(out).toContain('explanatory');
    expect(out).toContain('feat-x');
    expect(out).toContain('200k');
    expect(out).toContain('fast');
    expect(out).toContain('INSERT');
    expect(out).toContain('#482');
    expect(out).toContain('wt-next');
    expect(out).toContain('reviewer');
  });

  it('drops conditional blocks when their payload field is missing', () => {
    const out = runScript(generateStatuslineScript(optInConfig()), {
      ...stdin,
      version: '2.1.286', // the only unconditioned block in the set
      exceeds_200k_tokens: false,
      // no fast_mode / vim / pr / worktree / agent / output_style / session_name;
      // session falls back to the short id
      session_id: '01234567-89ab-cdef',
    });
    expect(out).toContain('2.1.286');
    expect(out).not.toContain('INSERT');
    expect(out).not.toContain('#482');
    expect(out).not.toContain('wt-next');
    expect(out).not.toContain('reviewer');
    expect(out).not.toContain('explanatory');
    // session_name absent → the id prefix still renders
    expect(out).toContain('01234567');
  });

  it('rate can report the seven-day and spend windows', () => {
    const rateWith = (win: 'five_hour' | 'seven_day' | 'spend') => ({
      ...DEFAULT_STATUSLINE_CONFIG,
      lines: [['rate']] as SegmentKey[][],
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        rate: { ...DEFAULT_STATUSLINE_CONFIG.segments.rate, enabled: true, window: win },
      },
    });
    const seven = runScript(generateStatuslineScript(rateWith('seven_day')), {
      ...stdin,
      rate_limits: { seven_day: { used_percentage: 33, resets_at: 'monday' } },
    });
    expect(seven).toContain('7d 33%');
    const spend = runScript(generateStatuslineScript(rateWith('spend')), {
      ...stdin,
      rate_limits: { spend_limit: { used_percentage: 10 } },
    });
    expect(spend).toContain('spend 10%');
    // the default window still renders byte-identically to the old hard-coded form
    const five = runScript(generateStatuslineScript(rateWith('five_hour')), {
      ...stdin,
      rate_limits: { five_hour: { used_percentage: 45 } },
    });
    expect(five).toContain('5h 45%');
  });

  it('cost exposes duration and line-count tokens', () => {
    const cfg = {
      ...DEFAULT_STATUSLINE_CONFIG,
      lines: [['cost']] as SegmentKey[][],
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        cost: {
          ...DEFAULT_STATUSLINE_CONFIG.segments.cost,
          enabled: true,
          format: '{cost} {duration} +{lines_added}/-{lines_removed}',
        },
      },
    };
    const out = runScript(generateStatuslineScript(cfg), {
      ...stdin,
      cost: {
        total_cost_usd: 1.5,
        total_duration_ms: 7200000,
        total_lines_added: 12,
        total_lines_removed: 3,
      },
    });
    expect(out).toContain('$1.50 2h +12/-3');
  });

  it('git exposes the repo owner/name token', () => {
    const cfg = {
      ...DEFAULT_STATUSLINE_CONFIG,
      lines: [['git']] as SegmentKey[][],
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        git: {
          ...DEFAULT_STATUSLINE_CONFIG.segments.git,
          enabled: true,
          format: '{branch}@{repo}',
        },
      },
    };
    const out = runScript(generateStatuslineScript(cfg), {
      ...stdin,
      workspace: {
        current_dir: process.cwd(), // inside the weave repo, so branch resolves
        repo: { host: 'github.com', owner: 'acme', name: 'weave' },
      },
    });
    expect(out).toContain('@acme/weave');
  });

  it('align center pads both sides', () => {
    const cfg = {
      ...DEFAULT_STATUSLINE_CONFIG,
      align: 'center' as const,
      // the clock's variable width would shift the centring padding
      segments: {
        ...DEFAULT_STATUSLINE_CONFIG.segments,
        time: { ...DEFAULT_STATUSLINE_CONFIG.segments.time, enabled: false },
      },
    };
    const out = runScript(generateStatuslineScript(cfg), stdin);
    expect(out.trim()).toContain('claude-sonnet-5');
    expect(out).toMatch(/^\x1b\[0m {10,}/); // leading reset, then centring padding
  });
});
