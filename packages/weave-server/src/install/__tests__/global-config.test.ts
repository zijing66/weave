import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  mkdirSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readGlobalClaudeJson,
  readGlobalMcpServers,
  writeGlobalMcpServer,
  removeGlobalMcpServer,
  readGlobalSkills,
  installGlobalSkill,
  uninstallGlobalSkill,
  readGlobalSkillGroups,
  readClaudePluginEnabled,
  writeClaudePluginEnabled,
  readCodexPluginEnabled,
  writeCodexPluginEnabled,
  resolveGlobalSkillDir,
  listGlobalSkillFiles,
  readGlobalSkillFile,
  globalPersonalSkillRoots,
  ClaudeJsonCorruptError,
} from '../global-config.js';
import { FileTooLargeError } from '../reader.js';
import { AssetNotFoundError } from '../installer.js';
import type { McpServerConfig } from '../installer.js';

// Isolate HOME so tests never touch the real ~/.claude.json.
let fakeHome: string;
let libDir: string;

beforeAll(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'weave-home-'));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome; // Windows
  libDir = mkdtempSync(join(tmpdir(), 'weave-globlib-'));
  mkdirSync(join(libDir, 'foo'), { recursive: true });
  writeFileSync(join(libDir, 'foo', 'SKILL.md'), '# Foo');
});
afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(libDir, { recursive: true, force: true });
});

describe('global ~/.claude.json MCP', () => {
  beforeEach(() => {
    // fresh ~/.claude.json each test
    try {
      rmSync(join(fakeHome, '.claude.json'));
    } catch {
      /* ignore */
    }
  });

  it('returns empty when file absent', async () => {
    expect(await readGlobalMcpServers()).toEqual({});
    expect(await readGlobalClaudeJson()).toEqual({});
  });

  it('adds a server preserving existing top-level keys', async () => {
    writeFileSync(
      join(fakeHome, '.claude.json'),
      JSON.stringify({ someOtherKey: 42, mcpServers: { existing: { command: 'node' } } }),
    );
    await writeGlobalMcpServer('new', { command: 'npx', args: ['x'] });
    const json = JSON.parse(readFileSync(join(fakeHome, '.claude.json'), 'utf-8'));
    expect(json.someOtherKey).toBe(42); // preserved
    expect(json.mcpServers.existing.command).toBe('node'); // preserved
    expect(json.mcpServers.new.command).toBe('npx');
  });

  it('removes a server leaving others intact', async () => {
    await writeGlobalMcpServer('a', { command: 'node' });
    await writeGlobalMcpServer('b', { command: 'node' });
    await removeGlobalMcpServer('a');
    const servers = await readGlobalMcpServers();
    expect(servers.a).toBeUndefined();
    expect(servers.b).toBeDefined();
  });

  it('refuses to write a corrupt ~/.claude.json', async () => {
    writeFileSync(join(fakeHome, '.claude.json'), '{ not valid json');
    await expect(writeGlobalMcpServer('x', { command: 'npx' })).rejects.toBeInstanceOf(
      ClaudeJsonCorruptError,
    );
    // file left untouched
    expect(readFileSync(join(fakeHome, '.claude.json'), 'utf-8')).toBe('{ not valid json');
  });

  it('readGlobalMcpServers tolerates corrupt file (returns empty)', async () => {
    writeFileSync(join(fakeHome, '.claude.json'), '{ broken');
    // readGlobalClaudeJson throws, but readGlobalMcpServers should surface it;
    // the server layer wraps it in safeReadGlobalMcp. Here we assert it throws
    // (caller decides how to handle).
    await expect(readGlobalMcpServers()).rejects.toBeInstanceOf(ClaudeJsonCorruptError);
  });
});

describe('global skills (directory ops)', () => {
  it('lists installed global skills', async () => {
    await installGlobalSkill(join(libDir, 'foo'), 'foo');
    expect(await readGlobalSkills()).toContain('foo');
  });

  it('install conflict throws', async () => {
    await installGlobalSkill(join(libDir, 'foo'), 'dup');
    await expect(installGlobalSkill(join(libDir, 'foo'), 'dup')).rejects.toThrow();
    await uninstallGlobalSkill('dup');
  });

  it('uninstall removes the directory', async () => {
    await installGlobalSkill(join(libDir, 'foo'), 'tmp');
    await uninstallGlobalSkill('tmp');
    expect(existsSync(join(fakeHome, '.claude', 'skills', 'tmp'))).toBe(false);
  });

  it('lists symlinked skill directories (not filtered by isDirectory)', async () => {
    // ~/.claude/skills/linked → libDir/foo (a real skill dir). The old
    // isDirectory() filter dropped symlinks; the fix follows the link.
    const skillsDir = join(fakeHome, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const link = join(skillsDir, 'linked');
    try {
      rmSync(link, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    symlinkSync(join(libDir, 'foo'), link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await readGlobalSkills()).toContain('linked');
  });
});

describe('global skill groups (personal + plugin, Claude + Codex)', () => {
  it('returns personal groups, keeping empties', async () => {
    const groups = await readGlobalSkillGroups();
    // personal groups are always present (may have 0 skills); plugins are
    // only present when their manifest/cache exists.
    expect(groups.find((g) => g.source === 'claude-personal')).toBeDefined();
    expect(groups.find((g) => g.source === 'codex-personal')).toBeDefined();
    // claude-personal should see the symlinked skill from the prior test
    const cp = groups.find((g) => g.source === 'claude-personal');
    expect(cp?.skills.map((s) => s.name)).toContain('linked');
  });

  it('reads Claude plugin skills from installed_plugins.json', async () => {
    // Seed a plugin install whose skills/ contains one skill.
    const pluginCache = join(fakeHome, '.claude', 'plugins', 'cache', 'mk', 'p', '1.0.0');
    mkdirSync(join(pluginCache, 'skills', 'plugin-skill'), { recursive: true });
    writeFileSync(
      join(pluginCache, 'skills', 'plugin-skill', 'SKILL.md'),
      '# Plugin Skill',
    );
    writeFileSync(
      join(fakeHome, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'p@mk': [
            {
              scope: 'user',
              installPath: pluginCache,
              version: '1.0.0',
              installedAt: '2026-01-01T00:00:00.000Z',
              lastUpdated: '2026-01-01T00:00:00.000Z',
              gitCommitSha: 'deadbeef',
            },
          ],
        },
      }),
    );
    const groups = await readGlobalSkillGroups();
    const pluginGroup = groups.find((g) => g.source === 'claude-plugin' && g.pluginKey === 'p@mk');
    expect(pluginGroup).toBeDefined();
    expect(pluginGroup?.skills.map((s) => s.name)).toContain('plugin-skill');
  });
});

describe('plugin enable state (Claude settings.json + Codex config.toml)', () => {
  beforeEach(() => {
    try {
      rmSync(join(fakeHome, '.claude', 'settings.json'));
    } catch {
      /* ignore */
    }
    try {
      rmSync(join(fakeHome, '.codex', 'config.toml'));
    } catch {
      /* ignore */
    }
  });

  it('reads/writes Claude plugin enable in settings.json, preserving keys', async () => {
    writeFileSync(
      join(fakeHome, '.claude', 'settings.json'),
      JSON.stringify({ model: 'sonnet', enabledPlugins: { 'a@mk': true } }),
    );
    expect(await readClaudePluginEnabled()).toEqual({ 'a@mk': true });
    await writeClaudePluginEnabled('b@mk', false);
    const json = JSON.parse(
      readFileSync(join(fakeHome, '.claude', 'settings.json'), 'utf-8'),
    );
    expect(json.model).toBe('sonnet'); // preserved
    expect(json.enabledPlugins).toEqual({ 'a@mk': true, 'b@mk': false });
  });

  it('reads/writes Codex plugin enable in config.toml', async () => {
    mkdirSync(join(fakeHome, '.codex'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.codex', 'config.toml'),
      `model = "gpt-image-2"\n[plugins."a@mk"]\nenabled = true\n`,
    );
    expect(await readCodexPluginEnabled()).toEqual({ 'a@mk': true });
    await writeCodexPluginEnabled('b@mk', false);
    const map = await readCodexPluginEnabled();
    expect(map['a@mk']).toBe(true);
    expect(map['b@mk']).toBe(false);
    // model preserved through TOML round-trip
    const raw = readFileSync(join(fakeHome, '.codex', 'config.toml'), 'utf-8');
    expect(raw).toContain('gpt-image-2');
  });
});

describe('global skill file listing / reading (follows symlinks)', () => {
  let skillDir: string;

  beforeAll(() => {
    skillDir = join(fakeHome, '.claude', 'skills', 'flist');
    mkdirSync(join(skillDir, 'sub'), { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# Flist\n\nbody');
    writeFileSync(join(skillDir, 'sub', 'note.md'), 'nested');
    writeFileSync(join(skillDir, '.hidden'), 'should be skipped');
  });

  it('globalPersonalSkillRoots lists the Claude root and both Codex roots', () => {
    const roots = globalPersonalSkillRoots();
    expect(roots.some((r) => r.endsWith(join('.claude', 'skills')))).toBe(true);
    // current Codex location, then the deprecated one it still reads
    expect(roots.some((r) => r.endsWith(join('.agents', 'skills')))).toBe(true);
    expect(roots.some((r) => r.endsWith(join('.codex', 'skills')))).toBe(true);
    expect(roots.length).toBe(3);
  });

  it('resolveGlobalSkillDir finds a claude-personal skill', async () => {
    const dir = await resolveGlobalSkillDir('claude-personal', 'flist');
    expect(dir).toBe(skillDir);
    expect(await resolveGlobalSkillDir('claude-personal', 'nope')).toBeNull();
  });

  it('reads Codex personal skills from both roots, preferring the current one', async () => {
    // Codex reads ~/.agents/skills first and still registers the deprecated
    // ~/.codex/skills, so weave must surface skills from either.
    const current = join(fakeHome, '.agents', 'skills');
    const legacy = join(fakeHome, '.codex', 'skills');
    for (const [root, name] of [
      [current, 'in-both'],
      [legacy, 'in-both'],
      [legacy, 'legacy-only'],
    ] as const) {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, 'SKILL.md'), `# ${name}`);
    }

    const groups = await readGlobalSkillGroups();
    const personal = groups.find((g) => g.source === 'codex-personal');
    expect(personal).toBeDefined();
    const names = personal!.skills.map((s) => s.name).sort();
    expect(names).toEqual(['in-both', 'legacy-only']);
    // the collision resolves to the current location
    expect(personal!.skills.find((s) => s.name === 'in-both')!.dir).toBe(join(current, 'in-both'));
  });

  it('lists files recursively, excluding hidden entries', async () => {
    const files = await listGlobalSkillFiles(skillDir);
    const rels = files.map((f) => f.relPath);
    expect(rels).toContain('SKILL.md');
    expect(rels).toContain('sub/note.md');
    expect(rels).not.toContain('.hidden');
    // absPath is absolute and nested under the skill dir
    expect(files[0].absPath.startsWith(skillDir)).toBe(true);
    expect(files.every((f) => f.category === 'skill')).toBe(true);
  });

  it('reads a file inside the skill dir', async () => {
    const f = await readGlobalSkillFile(skillDir, 'SKILL.md');
    expect(f.content).toContain('# Flist');
    expect(f.size).toBeGreaterThan(0);
  });

  it('reads through a symlinked skill dir (junction on win32)', async () => {
    const link = join(fakeHome, '.claude', 'skills', 'flist-linked');
    try {
      rmSync(link, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    symlinkSync(skillDir, link, process.platform === 'win32' ? 'junction' : 'dir');
    const files = await listGlobalSkillFiles(link);
    expect(files.map((f) => f.relPath)).toContain('SKILL.md');
    const f = await readGlobalSkillFile(link, 'sub/note.md');
    expect(f.content).toBe('nested');
  });

  it('rejects path traversal and absolute paths', async () => {
    await expect(readGlobalSkillFile(skillDir, '../settings.json')).rejects.toBeInstanceOf(
      AssetNotFoundError,
    );
    await expect(
      readGlobalSkillFile(skillDir, process.platform === 'win32' ? 'C:/windows/system32' : '/etc/passwd'),
    ).rejects.toBeInstanceOf(AssetNotFoundError);
  });

  it('rejects a missing file', async () => {
    await expect(readGlobalSkillFile(skillDir, 'nope.md')).rejects.toBeInstanceOf(
      AssetNotFoundError,
    );
  });

  it('rejects a file exceeding the size cap', async () => {
    const big = join(skillDir, 'big.txt');
    writeFileSync(big, 'x'.repeat(512 * 1024 + 1));
    await expect(readGlobalSkillFile(skillDir, 'big.txt')).rejects.toBeInstanceOf(
      FileTooLargeError,
    );
  });
});
