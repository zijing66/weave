import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PluginExecutor } from '../plugins.js';
import { commandExecutions, createClaudeCommandSurface } from '../commands.js';

let root = '';
const project = (): string => path.join(root, 'proj');
const home = (): string => path.join(root, 'home');

function touch(file: string, body = ''): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
}

/** 官方口径的假 CLI：`plugin list --json` 回这张表（别的参数一律报错）。 */
const cliOf =
  (rows: unknown): PluginExecutor =>
  async (args) => {
    if (args.join(' ') !== 'plugin list --json') throw new Error(`unexpected: ${args.join(' ')}`);
    return { stdout: JSON.stringify(rows), stderr: '' };
  };

const noCli: PluginExecutor = async () => {
  throw new Error('claude not found');
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'weave-cmd-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('claude 命令清单', () => {
  it('内建 + 项目/用户命令 + skill + **启用**插件的 skill（`<插件>:<skill>`）', async () => {
    touch(path.join(project(), '.claude/commands/deploy.md'), '---\ndescription: Ship it\n---\n正文');
    touch(path.join(project(), '.claude/commands/db/migrate.md'), '把库迁上去');
    touch(path.join(project(), '.claude/skills/reviewer/SKILL.md'), '---\ndescription: Review code\n---');
    touch(path.join(home(), '.claude/skills/helper/SKILL.md'), '帮个忙');
    const on = path.join(root, 'plugins/on');
    const off = path.join(root, 'plugins/off');
    touch(path.join(on, 'skills/design/SKILL.md'), '---\ndescription: Design things\n---');
    touch(path.join(off, 'skills/old/SKILL.md'), '停用的不该出现');
    const surface = createClaudeCommandSurface({
      exec: cliOf([
        { id: 'plug@mkt', enabled: true, installPath: on },
        { id: 'off@mkt', enabled: false, installPath: off },
      ]),
    });

    const list = await surface.list({ projectPath: project(), homedir: home() });
    const byName = new Map(list.map((c) => [c.name, c]));

    expect(byName.get('compact')).toMatchObject({ source: 'builtin', argsHint: '[instructions]' });
    // 内建默认只在输入开头；prompt 型内建（init）句中也可用
    expect(byName.get('compact')?.inline).toBeUndefined();
    expect(byName.get('init')?.inline).toBe(true);
    expect(byName.get('deploy')).toMatchObject({ source: 'command', description: 'Ship it', inline: true });
    // 子目录 = 命名空间
    expect(byName.get('db:migrate')).toMatchObject({ source: 'command', description: '把库迁上去', inline: true });
    expect(byName.get('reviewer')).toMatchObject({ source: 'skill', description: 'Review code', inline: true });
    expect(byName.get('helper')).toMatchObject({ source: 'skill', description: '帮个忙', inline: true });
    expect(byName.get('plug:design')).toMatchObject({ source: 'plugin', description: 'Design things', inline: true });
    // 停用插件里的 skill 不可选
    expect(byName.has('off:old')).toBe(false);
  });

  it('CLI 拿不到启用态 → 退回扫缓存目录（不假装知道）', async () => {
    touch(
      path.join(home(), '.claude/plugins/cache/mkt/plug/abc123/skills/design/SKILL.md'),
      '---\ndescription: Design things\n---',
    );
    const surface = createClaudeCommandSurface({ exec: noCli });
    const list = await surface.list({ projectPath: project(), homedir: home() });
    expect(list.find((c) => c.name === 'plug:design')).toMatchObject({ source: 'plugin' });
  });

  it('目录都不存在时只剩内建（不抛）', async () => {
    const surface = createClaudeCommandSurface({ exec: noCli });
    const list = await surface.list({ projectPath: project(), homedir: home() });
    expect(list.length).toBeGreaterThan(10);
    expect(list.every((c) => c.source === 'builtin')).toBe(true);
  });

  it('符号链接进来的 skill 也识（用户常把仓库里的 skill 链进 ~/.claude/skills）', async (ctx) => {
    touch(path.join(home(), '.claude/skills/plain/SKILL.md'), '原生目录');
    const repo = path.join(root, 'repo/linked');
    touch(path.join(repo, 'SKILL.md'), '---\ndescription: Linked skill\n---');
    mkdirSync(path.join(home(), '.claude/skills'), { recursive: true });
    try {
      symlinkSync(repo, path.join(home(), '.claude/skills/linked'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      ctx.skip(); // 没权限建链接的机器上跳过
    }
    const surface = createClaudeCommandSurface({ exec: noCli });
    const list = await surface.list({ projectPath: project(), homedir: home() });
    expect(list.find((c) => c.name === 'plain')).toMatchObject({ source: 'skill' });
    expect(list.find((c) => c.name === 'linked')).toMatchObject({ source: 'skill', description: 'Linked skill' });
  });

  it('同名以内建为准（不重复列）', async () => {
    touch(path.join(project(), '.claude/commands/model.md'), '自定义同名命令');
    const surface = createClaudeCommandSurface({ exec: noCli });
    const list = await surface.list({ projectPath: project(), homedir: home() });
    expect(list.filter((c) => c.name === 'model')).toHaveLength(1);
    expect(list.find((c) => c.name === 'model')?.source).toBe('builtin');
  });

  it('claude 的命令触发符恒为 `/`（sigil 不设）', async () => {
    const surface = createClaudeCommandSurface({ exec: noCli });
    const list = await surface.list({ projectPath: project(), homedir: home() });
    expect(list.every((c) => c.sigil === undefined)).toBe(true);
  });
});

describe('claude 命令执行返显', () => {
  const line = (o: unknown): string => JSON.stringify(o);
  const cmd = (name: string, args = '', at = '2026-10-23T01:39:11.452Z'): string =>
    line({
      type: 'user',
      timestamp: at,
      message: {
        role: 'user',
        content: `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>\n<command-args>${args}</command-args>`,
      },
    });
  const out = (text: string, at = '2026-10-23T01:39:11.500Z'): string =>
    line({ type: 'user', timestamp: at, message: { role: 'user', content: `<local-command-stdout>${text}</local-command-stdout>` } });
  const skill = (at = '2026-10-23T01:39:12.000Z'): string =>
    line({ type: 'user', isMeta: true, timestamp: at, message: { role: 'user', content: 'Base directory for this skill: …' } });

  it('内建命令 + 紧随的输出 = 一条执行；ANSI 剥掉', async () => {
    const file = path.join(root, 't.jsonl');
    writeFileSync(file, [cmd('model'), out('\u001b[2mSet model to opus\u001b[22m')].join('\n'));
    expect(await commandExecutions(file)).toEqual([
      { name: 'model', args: '', at: '2026-10-23T01:39:11.452Z', output: 'Set model to opus' },
    ]);
  });

  it('命令参数一并保留', async () => {
    const file = path.join(root, 't.jsonl');
    writeFileSync(file, [cmd('goal', '完成当前计划'), out('Goal set')].join('\n'));
    expect(await commandExecutions(file)).toEqual([
      { name: 'goal', args: '完成当前计划', at: '2026-10-23T01:39:11.452Z', output: 'Goal set' },
    ]);
  });

  it('skill 命令没有 stdout（展开成 prompt，已有 UPS 气泡）→ 不算执行', async () => {
    const file = path.join(root, 't.jsonl');
    writeFileSync(file, [cmd('playwright-cli', 'http://localhost'), skill()].join('\n'));
    expect(await commandExecutions(file)).toEqual([]);
  });

  it('转录不存在 → null（不猜）', async () => {
    expect(await commandExecutions(path.join(root, 'nope.jsonl'))).toBeNull();
  });
});
