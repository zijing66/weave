import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildLibraryIndex, findSkillSource } from '../library-index.js';
import type { LibraryRow } from '../../repositories/libraries.js';

function makeLib(base: string, path: string): LibraryRow {
  return {
    id: Math.floor(Math.random() * 1e6),
    path,
    kind: 'skill',
    addedAt: new Date().toISOString(),
  };
}

describe('buildLibraryIndex', () => {
  let libA: string;
  let libB: string;

  beforeAll(() => {
    libA = mkdtempSync(join(tmpdir(), 'weave-libA-'));
    libB = mkdtempSync(join(tmpdir(), 'weave-libB-'));
    // libA: two skills at top level (zj-skills layout)
    mkdirSync(join(libA, 'code-review'), { recursive: true });
    writeFileSync(join(libA, 'code-review', 'SKILL.md'), '# code-review');
    mkdirSync(join(libA, 'testing'), { recursive: true });
    writeFileSync(join(libA, 'testing', 'SKILL.md'), '# testing');
    // libB: weave-templates layout (templates/skills/<name>) + a shared name
    mkdirSync(join(libB, 'templates', 'skills', 'refactoring'), { recursive: true });
    writeFileSync(join(libB, 'templates', 'skills', 'refactoring', 'SKILL.md'), '# refactoring');
    mkdirSync(join(libB, 'templates', 'skills', 'code-review'), { recursive: true });
    writeFileSync(join(libB, 'templates', 'skills', 'code-review', 'SKILL.md'), '# code-review-b');
  });
  afterAll(() => {
    rmSync(libA, { recursive: true, force: true });
    rmSync(libB, { recursive: true, force: true });
  });

  it('indexes skills by name across multiple libraries', async () => {
    const idx = await buildLibraryIndex([makeLib('A', libA), makeLib('B', libB)]);
    expect([...idx.skills.keys()].sort()).toEqual(['code-review', 'refactoring', 'testing']);
    expect(idx.mcp).toBeDefined();
  });

  it('first library wins on name collision', async () => {
    const a = makeLib('A', libA);
    const b = makeLib('B', libB);
    const idx = await buildLibraryIndex([a, b]);
    const src = findSkillSource(idx, 'code-review');
    expect(src).toBeDefined();
    expect(src!.libraryPath).toBe(libA); // libA listed first → wins
    expect(src!.dirPath).toBe(join(libA, 'code-review'));
  });

  it('findSkillSource returns undefined for unknown name', async () => {
    const idx = await buildLibraryIndex([makeLib('A', libA)]);
    expect(findSkillSource(idx, 'nope')).toBeUndefined();
  });

  it('skips libraries whose kind excludes skills', async () => {
    const mcpOnly: LibraryRow = { ...makeLib('A', libA), kind: 'mcp' };
    const idx = await buildLibraryIndex([mcpOnly]);
    expect(idx.skills.size).toBe(0);
  });

  it('kind "both" is included', async () => {
    const both: LibraryRow = { ...makeLib('A', libA), kind: 'both' };
    const idx = await buildLibraryIndex([both]);
    expect(idx.skills.has('code-review')).toBe(true);
  });

  it('skips unreadable / missing library paths', async () => {
    const missing: LibraryRow = makeLib('X', join(tmpdir(), 'weave-does-not-exist-xyz'));
    const idx = await buildLibraryIndex([missing, makeLib('A', libA)]);
    expect(idx.skills.has('code-review')).toBe(true); // libA still indexed
  });

  it('包内 skill/文件模板不进更新索引（包子树排除，P6 修订）', async () => {
    const libC = mkdtempSync(join(tmpdir(), 'weave-libC-'));
    try {
      // 插件包：manifest + 包内 skill + 包内 command（隶属包，不作独立更新来源）
      mkdirSync(join(libC, 'pack', '.claude-plugin'), { recursive: true });
      writeFileSync(join(libC, 'pack', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'p', version: '1.0.0' }));
      mkdirSync(join(libC, 'pack', 'skills', 'pack-skill'), { recursive: true });
      writeFileSync(join(libC, 'pack', 'skills', 'pack-skill', 'SKILL.md'), '# x');
      mkdirSync(join(libC, 'pack', 'commands'), { recursive: true });
      writeFileSync(join(libC, 'pack', 'commands', 'x.md'), '# x');
      // 包外独立 skill 照旧
      mkdirSync(join(libC, 'solo'), { recursive: true });
      writeFileSync(join(libC, 'solo', 'SKILL.md'), '# solo');

      const idx = await buildLibraryIndex([makeLib('C', libC)]);
      expect(idx.skills.has('solo')).toBe(true);
      expect(idx.skills.has('pack-skill')).toBe(false);
      expect(idx.files.has('command/x')).toBe(false);
    } finally {
      rmSync(libC, { recursive: true, force: true });
    }
  });
});
