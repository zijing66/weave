import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { CLAUDE_ASSETS } from '../claude/assets';
import { CODEX_ASSETS } from '../codex/assets';
import { FILE_ASSET_SPECS } from '../shared/file-specs';

/** 批 4a：两 surface 的查询结果与 server 六处散落原实现逐例等价。 */

const HOME = join('/', 'home', 'user');
const PROJECT = join('/', 'repo');

describe('targetDir — Claude 表面', () => {
  it('project scope 落 .claude/<kind>', () => {
    expect(CLAUDE_ASSETS.targetDir('command', 'project', PROJECT, HOME)).toBe(
      join(PROJECT, '.claude', 'commands'),
    );
    expect(CLAUDE_ASSETS.targetDir('agent', 'project', PROJECT, HOME)).toBe(
      join(PROJECT, '.claude', 'agents'),
    );
    expect(CLAUDE_ASSETS.targetDir('workflow', 'project', PROJECT, HOME)).toBe(
      join(PROJECT, '.claude', 'workflows'),
    );
  });

  it('user scope 落 ~/.claude/<kind>，无 userDir 的类别抛 project-scoped only', () => {
    expect(CLAUDE_ASSETS.targetDir('command', 'user', PROJECT, HOME)).toBe(
      join(HOME, '.claude', 'commands'),
    );
    expect(CLAUDE_ASSETS.targetDir('output-style', 'user', PROJECT, HOME)).toBe(
      join(HOME, '.claude', 'output-styles'),
    );
    expect(() => CLAUDE_ASSETS.targetDir('rule', 'user', PROJECT, HOME)).toThrow(
      /project-scoped only/,
    );
  });
});

describe('targetDir — Codex 表面', () => {
  it('无 codexUserDir / 非 user 一律抛 no Codex', () => {
    expect(FILE_ASSET_SPECS.command.codexUserDir).toBeUndefined();
    expect(() => CODEX_ASSETS.targetDir('command', 'user', PROJECT, HOME)).toThrow(/no Codex/);
    expect(() => CODEX_ASSETS.targetDir('command', 'project', PROJECT, HOME)).toThrow(/no Codex/);
    for (const category of ['agent', 'workflow', 'rule', 'output-style'] as const) {
      expect(() => CODEX_ASSETS.targetDir(category, 'user', PROJECT, HOME)).toThrow(/no Codex/);
    }
  });
});

describe('skills / 配置路径', () => {
  it('project skills 目录', () => {
    expect(CLAUDE_ASSETS.projectSkillsDir()).toBe('.claude/skills');
    expect(CODEX_ASSETS.projectSkillsDir()).toBe('.codex/skills');
  });

  it('global skills 根：Claude 单根；Codex current 在前、legacy 在后', () => {
    expect(CLAUDE_ASSETS.globalSkillsRoots(HOME)).toEqual([join(HOME, '.claude', 'skills')]);
    expect(CODEX_ASSETS.globalSkillsRoots(HOME)).toEqual([
      join(HOME, '.agents', 'skills'),
      join(HOME, '.codex', 'skills'),
    ]);
  });

  it('用户级配置文件', () => {
    expect(CLAUDE_ASSETS.userConfigFile(HOME)).toBe(join(HOME, '.claude', 'settings.json'));
    expect(CODEX_ASSETS.userConfigFile(HOME)).toBe(join(HOME, '.codex', 'config.toml'));
  });
});

describe('classify — 路径归属（同 classifyAgent 逐例）', () => {
  it.each([
    ['CLAUDE.md', 'claude'],
    ['docs/CLAUDE.md', 'claude'],
    ['AGENTS.md', 'codex'],
    ['docs/AGENTS.md', 'codex'],
    ['.codex/config.toml', 'codex'],
    ['.codex/AGENTS.md', 'codex'],
    ['.claude/commands/review.md', 'claude'],
    ['README.md', 'claude'], // 无人认领 → server 默认 claude
  ] as const)('%s → %s', (relPath, expected) => {
    const owner = [CODEX_ASSETS, CLAUDE_ASSETS].find((s) => s.classify(relPath));
    expect(owner?.harness ?? 'claude').toBe(expected);
  });
});

describe('ignore — watch 观测集（同 shouldIgnore 逐例）', () => {
  // server shouldIgnore = 根/.weave 中立 + !claude.ignore && !codex.ignore
  const shouldIgnore = (rel: string): boolean => {
    if (rel === '' || rel === '.') return false;
    if (rel === '.weave' || rel.startsWith('.weave/')) return false;
    return CLAUDE_ASSETS.ignore(rel) && CODEX_ASSETS.ignore(rel);
  };

  it.each<[string, boolean]>([
    ['.', false],
    ['', false],
    ['.mcp.json', false],
    ['.claude', false],
    ['.claude/skills/foo/SKILL.md', false],
    ['.codex/config.toml', false],
    ['AGENTS.md', false],
    ['CLAUDE.md', false],
    ['.weave/token', false],
    ['node_modules', true],
    ['node_modules/x', true],
    ['.git', true],
    ['.claude/projects/abc', true],
    ['.claude/cache/x', true],
    ['package.json', true],
    ['src/index.ts', true],
    ['docs/CLAUDE.md', true], // 根级指令文件才观测
  ])('shouldIgnore(%j) === %s', (rel, expected) => {
    expect(shouldIgnore(rel)).toBe(expected);
  });
});
