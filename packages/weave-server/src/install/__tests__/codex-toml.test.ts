import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'smol-toml';
import {
  parseDottedKey,
  sectionHeaderKey,
  renderTomlHeader,
  renderTomlString,
  splitTomlSections,
  upsertTomlSection,
  removeTomlSection,
  parseSectionEntries,
  readCodexMcpFromText,
  upsertCodexMcpInText,
  removeCodexMcpFromText,
  upsertCodexPluginEnabledInText,
  readCodexMcpServers,
  writeCodexMcpServer,
  removeCodexMcpServer,
  codexMcpExists,
  codexConfigFile,
  CodexTomlCorruptError,
} from '../codex-toml.js';

/** A config.toml shape modelled on a real user file: comments, quoted keys,
 * literal strings, nested sections, blank-line style. */
const REAL_LIKE = `# user-level Codex config
model = "gpt-image-2"
notify = [ "C:\\\\bin\\\\codex.exe", "turn-ended" ]

[model_providers.custom]
name = "custom"
base_url = "http://models.example"

[projects.'d:\\repo\\weave']
trust_level = "trusted"

[mcp_servers.codegraph]
type = "stdio"
command = "codegraph"
args = ["serve", "--mcp"]

[mcp_servers.node_repl]
command = 'D:\\bin\\node_repl.exe'
startup_timeout_sec = 120

[mcp_servers.node_repl.env]
NODE_REPL_PATH = 'D:\\bin\\node.exe'
`;

describe('parseDottedKey', () => {
  it('parses bare dotted keys', () => {
    expect(parseDottedKey('mcp_servers.codegraph')).toEqual(['mcp_servers', 'codegraph']);
  });

  it('decodes quoted parts without splitting on inner dots', () => {
    expect(parseDottedKey('"gpt-5.5"')).toEqual(['gpt-5.5']);
    expect(parseDottedKey("projects.'d:\\repo'")).toEqual(['projects', 'd:\\repo']);
  });

  it('returns null for malformed input', () => {
    expect(parseDottedKey('')).toBeNull();
    expect(parseDottedKey('"unterminated')).toBeNull();
    expect(parseDottedKey('a..b')).toBeNull();
    expect(parseDottedKey('a b')).toBeNull();
  });
});

describe('sectionHeaderKey', () => {
  it('parses plain and nested headers', () => {
    expect(sectionHeaderKey('[mcp_servers.x]')).toEqual(['mcp_servers', 'x']);
    expect(sectionHeaderKey('[mcp_servers.node_repl.env]')).toEqual([
      'mcp_servers',
      'node_repl',
      'env',
    ]);
  });

  it('parses quoted keys and trailing comments', () => {
    expect(sectionHeaderKey('[plugins."visualize@openai-bundled"]')).toEqual([
      'plugins',
      'visualize@openai-bundled',
    ]);
    expect(sectionHeaderKey("[projects.'d:\\path'] # trusted dir")).toEqual([
      'projects',
      'd:\\path',
    ]);
  });

  it('parses array-of-tables headers', () => {
    expect(sectionHeaderKey('[[fruit]]')).toEqual(['fruit']);
  });

  it('rejects non-header lines', () => {
    expect(sectionHeaderKey('command = "x"')).toBeNull();
    expect(sectionHeaderKey('# [not a header]')).toBeNull();
    expect(sectionHeaderKey('')).toBeNull();
    expect(sectionHeaderKey('  [unterminated')).toBeNull();
    expect(sectionHeaderKey('[a] trailing garbage')).toBeNull();
  });

  it('renders headers symmetrically for bare and quoted parts', () => {
    expect(renderTomlHeader(['mcp_servers', 'my-tool'])).toBe('[mcp_servers.my-tool]');
    expect(renderTomlHeader(['plugins', 'a@b'])).toBe('[plugins."a@b"]');
  });
});

describe('renderTomlString', () => {
  it('uses literal strings for backslash content (Windows paths)', () => {
    expect(renderTomlString('D:\\bin\\node.exe')).toBe("'D:\\bin\\node.exe'");
  });

  it('uses basic strings otherwise, escaping quotes and control chars', () => {
    expect(renderTomlString('say "hi"')).toBe('"say \\"hi\\""');
    expect(renderTomlString('line\nbreak')).toBe('"line\\nbreak"');
  });
});

describe('splitTomlSections', () => {
  it('splits into root + header segments, lines verbatim', () => {
    const sections = splitTomlSections(REAL_LIKE);
    expect(sections[0]!.key).toBeNull();
    expect(sections[0]!.lines.join('\n')).toContain('model = "gpt-image-2"');
    expect(sections.map((s) => s.key)).toEqual([
      null,
      ['model_providers', 'custom'],
      ['projects', 'd:\\repo\\weave'],
      ['mcp_servers', 'codegraph'],
      ['mcp_servers', 'node_repl'],
      ['mcp_servers', 'node_repl', 'env'],
    ]);
  });
});

describe('upsertTomlSection', () => {
  it('inserts a new section at EOF separated by one blank line', () => {
    const out = upsertTomlSection('model = "x"\n', ['mcp_servers', 'new'], ['command = "npx"']);
    expect(out).toBe('model = "x"\n\n[mcp_servers.new]\ncommand = "npx"\n');
  });

  it('creates a file from empty text', () => {
    const out = upsertTomlSection('', ['mcp_servers', 'new'], ['command = "npx"']);
    expect(out).toBe('[mcp_servers.new]\ncommand = "npx"\n');
  });

  it('replaces only the matched section, preserving neighbours byte-for-byte', () => {
    const out = upsertTomlSection(REAL_LIKE, ['mcp_servers', 'codegraph'], ['command = "cg2"']);
    expect(out).toContain('# user-level Codex config');
    expect(out).toContain('base_url = "http://models.example"');
    expect(out).toContain("[projects.'d:\\repo\\weave']");
    expect(out).toContain('[mcp_servers.node_repl.env]');
    expect(out).not.toContain('args = ["serve", "--mcp"]');
    expect(out).toContain('command = "cg2"');
    expect(() => parse(out)).not.toThrow();
  });

  it('drops nested sub-sections of the replaced section and keeps separation', () => {
    const text = `[a]\nx = 1\n\n[a.sub]\ny = 2\n\n[other]\nz = 3\n`;
    const out = upsertTomlSection(text, ['a'], ['x = 9']);
    expect(out).toBe(`[a]\nx = 9\n\n[other]\nz = 3\n`);
  });

  it('preserves the no-blank-line style when the replaced section had none', () => {
    const text = `[a]\nx = 1\n[b]\ny = 2\n`;
    const out = upsertTomlSection(text, ['a'], ['x = 9']);
    expect(out).toBe(`[a]\nx = 9\n[b]\ny = 2\n`);
  });
});

describe('removeTomlSection', () => {
  it('removes the section plus nested sub-sections, keeping the rest', () => {
    const { text, removed } = removeTomlSection(REAL_LIKE, ['mcp_servers', 'codegraph']);
    expect(removed).toBe(true);
    expect(text).not.toContain('[mcp_servers.codegraph]');
    expect(text).toContain('[mcp_servers.node_repl.env]');
    expect(text).toContain('[model_providers.custom]');
  });

  it('removes a section with its nested env sub-section', () => {
    const text = `[mcp_servers.x]\ncommand = "a"\n\n[mcp_servers.x.env]\nK = "v"\n\n[other]\no = 1\n`;
    const r = removeTomlSection(text, ['mcp_servers', 'x']);
    expect(r.removed).toBe(true);
    expect(r.text).toBe('[other]\no = 1\n');
  });

  it('reports removed=false for an absent section (text unchanged)', () => {
    const r = removeTomlSection(REAL_LIKE, ['mcp_servers', 'absent']);
    expect(r.removed).toBe(false);
    expect(r.text).toBe(REAL_LIKE);
  });

  it('keeps the parent when removing only a sub-section', () => {
    const text = `[a]\nx = 1\n\n[a.sub]\ny = 2\n`;
    const r = removeTomlSection(text, ['a', 'sub']);
    expect(r.removed).toBe(true);
    expect(r.text).toBe('[a]\nx = 1\n');
  });
});

describe('parseSectionEntries', () => {
  it('parses entries in order, skipping comments and blanks', () => {
    const entries = parseSectionEntries([
      '[mcp_servers.x]',
      '# comment',
      'command = "npx"',
      '',
      'startup_timeout_sec = 120',
      '"gpt-5.5" = 1',
    ]);
    expect(entries).toEqual([
      ['command', 'command = "npx"'],
      ['startup_timeout_sec', 'startup_timeout_sec = 120'],
      ['gpt-5.5', '"gpt-5.5" = 1'],
    ]);
  });
});

describe('readCodexMcpFromText', () => {
  it('reads stdio servers, env as a plain object', () => {
    const servers = readCodexMcpFromText(REAL_LIKE);
    expect(servers.codegraph).toEqual({
      command: 'codegraph',
      args: ['serve', '--mcp'],
    });
    expect(servers.node_repl).toEqual({
      command: 'D:\\bin\\node_repl.exe',
      env: { NODE_REPL_PATH: 'D:\\bin\\node.exe' },
    });
  });

  it('returns empty for absent, corrupt, or non-table mcp_servers', () => {
    expect(readCodexMcpFromText('')).toEqual({});
    expect(readCodexMcpFromText('not [ valid toml')).toEqual({});
    expect(readCodexMcpFromText('mcp_servers = "oops"')).toEqual({});
  });

  it('skips entries without a command (remote/url servers)', () => {
    const servers = readCodexMcpFromText(
      `[mcp_servers.remote]\nurl = "http://x"\n\n[mcp_servers.local]\ncommand = "y"\n`,
    );
    expect(Object.keys(servers)).toEqual(['local']);
  });
});

describe('upsertCodexMcpInText', () => {
  const CFG = { command: 'npx', args: ['-y', 'server'], env: { API_KEY: 'k' } };

  it('appends a server and keeps the rest of the file byte-identical', () => {
    const out = upsertCodexMcpInText(REAL_LIKE, 'weave', CFG);
    expect(out.startsWith(REAL_LIKE)).toBe(true);
    expect(out).toContain('[mcp_servers.weave]\ncommand = "npx"');
    expect(out).toContain('args = ["-y", "server"]');
    expect(out).toContain('[mcp_servers.weave.env]\nAPI_KEY = "k"');
    expect(() => parse(out)).not.toThrow();
  });

  it('replaces an existing server but preserves user-added keys', () => {
    const out = upsertCodexMcpInText(REAL_LIKE, 'codegraph', { command: 'cg' });
    expect(out).toContain('[mcp_servers.codegraph]\ncommand = "cg"');
    expect(out).toContain('type = "stdio"'); // user key survives
    expect(out).not.toContain('args = ["serve", "--mcp"]'); // managed key refreshed
    expect(() => parse(out)).not.toThrow();
  });

  it('preserves env vars weave does not manage', () => {
    const out = upsertCodexMcpInText(REAL_LIKE, 'codegraph', {
      command: 'codegraph',
      env: { NEW: '1' },
    });
    expect(out).toContain('NEW = "1"');
    expect(() => parse(out)).not.toThrow();
  });

  it('replaces managed env keys and keeps user-added ones', () => {
    const out = upsertCodexMcpInText(REAL_LIKE, 'node_repl', {
      command: 'node',
      env: { NODE_REPL_PATH: 'D:/new/node.exe' },
    });
    expect(out).toContain('NODE_REPL_PATH = "D:/new/node.exe"');
    expect(out).toContain('startup_timeout_sec = 120');
    expect(() => parse(out)).not.toThrow();
  });

  it('quotes server names that are not bare keys', () => {
    const out = upsertCodexMcpInText(REAL_LIKE, 'my.tool', { command: 'x' });
    expect(out).toContain('[mcp_servers."my.tool"]');
    expect(() => parse(out)).not.toThrow();
  });

  it('rejects an inline mcp_servers root value', () => {
    expect(() => upsertCodexMcpInText('mcp_servers = { a = 1 }\n', 'x', CFG)).toThrow(
      CodexTomlCorruptError,
    );
  });
});

describe('removeCodexMcpFromText', () => {
  it('removes the server section and keeps other servers', () => {
    const { text, removed } = removeCodexMcpFromText(REAL_LIKE, 'codegraph');
    expect(removed).toBe(true);
    expect(text).not.toContain('[mcp_servers.codegraph]');
    expect(text).toContain('[mcp_servers.node_repl.env]');
  });
});

describe('upsertCodexPluginEnabledInText', () => {
  it('adds a plugin section without touching others', () => {
    const out = upsertCodexPluginEnabledInText(REAL_LIKE, 'visualize@openai-bundled', true);
    expect(out).toContain('[plugins."visualize@openai-bundled"]\nenabled = true');
    expect(() => parse(out)).not.toThrow();
  });

  it('updates enabled while preserving other keys in the section', () => {
    const text = `[plugins."p@mp"]\nenabled = true\nversion = "1.0"\n`;
    const out = upsertCodexPluginEnabledInText(text, 'p@mp', false);
    expect(out).toContain('enabled = false');
    expect(out).toContain('version = "1.0"');
  });
});

describe('codex config.toml file wrappers', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'weave-codex-home-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('round-trips write → read → remove against a temp config.toml', async () => {
    const file = codexConfigFile(home);
    await writeCodexMcpServer('weave', { command: 'npx', args: ['weave'] }, file);
    expect(await codexMcpExists('weave', file)).toBe(true);
    expect((await readCodexMcpServers(file)).weave).toEqual({
      command: 'npx',
      args: ['weave'],
    });

    await writeCodexMcpServer('other', { command: 'run' }, file);
    const raw = readFileSync(file, 'utf-8');
    expect(raw).toContain('[mcp_servers.weave]');
    expect(raw).toContain('[mcp_servers.other]');

    expect(await removeCodexMcpServer('weave', file)).toBe(true);
    expect(await removeCodexMcpServer('weave', file)).toBe(false);
    expect(await codexMcpExists('weave', file)).toBe(false);
    expect(Object.keys(await readCodexMcpServers(file))).toEqual(['other']);
  });

  it('preserves hand-written config content across a write', async () => {
    const file = codexConfigFile(home);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, REAL_LIKE);
    await writeCodexMcpServer('weave', { command: 'npx' }, file);
    const raw = readFileSync(file, 'utf-8');
    expect(raw).toContain('# user-level Codex config');
    expect(raw).toContain('base_url = "http://models.example"');
    expect(raw).toContain('[mcp_servers.weave]');
    expect(() => parse(raw)).not.toThrow();
  });

  it('refuses to write a config.toml that does not parse', async () => {
    const file = codexConfigFile(home);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'broken [ [ toml');
    await expect(writeCodexMcpServer('x', { command: 'y' }, file)).rejects.toBeInstanceOf(
      CodexTomlCorruptError,
    );
    expect(readFileSync(file, 'utf-8')).toBe('broken [ [ toml'); // untouched
  });
});
