import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HarnessCommand } from '../../driver.js';
import { CODEX_COMMANDS, createCodexCommandSurface } from '../commands.js';

let root = '';
let savedHome: string | undefined;
const home = (): string => path.join(root, 'home');
const codexHome = (): string => path.join(home(), '.codex');

function touch(file: string, body = ''): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
}

/** 官方 `skills/list` 的假实现；`null` = 取不到（调用方退回目录扫描）。 */
const official = (skills: HarnessCommand[] | null) => async (): Promise<HarnessCommand[] | null> => skills;

beforeEach(() => {
  savedHome = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  root = mkdtempSync(path.join(tmpdir(), 'weave-codex-cmd-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedHome;
});

describe('codex 命令清单', () => {
  it('内建 + prompts + 官方 skills/list（`$` 触发符、插件 skill 归 plugin）', async () => {
    touch(path.join(codexHome(), 'prompts/audit.md'), '---\ndescription: Audit deps\n---\n正文');
    touch(path.join(codexHome(), 'prompts/plain.md'), '第一行就是说明\n第二行');
    const surface = createCodexCommandSurface({
      skills: official([
        { name: 'visualize:visualize', description: 'Turn ideas into visuals', source: 'plugin', sigil: '$' },
        { name: 'triage', description: 'Triage failures', source: 'skill', sigil: '$' },
      ]),
    });

    const list = await surface.list({ projectPath: root, homedir: home() });
    const byName = new Map(list.map((c) => [c.name, c]));

    expect(byName.get('compact')).toMatchObject({ source: 'builtin' });
    expect(byName.get('audit')).toMatchObject({ source: 'command', description: 'Audit deps' });
    expect(byName.get('plain')).toMatchObject({ source: 'command', description: '第一行就是说明' });
    expect(byName.get('visualize:visualize')).toMatchObject({ source: 'plugin', sigil: '$' });
    expect(byName.get('triage')).toMatchObject({ source: 'skill', sigil: '$' });
  });

  it('官方通道拿不到 → 退回扫 $CODEX_HOME/skills（同样是 `$`）', async () => {
    touch(path.join(codexHome(), 'skills/triage/SKILL.md'), '---\ndescription: Triage failures\n---');
    const surface = createCodexCommandSurface({ skills: official(null) });

    const list = await surface.list({ projectPath: root, homedir: home() });
    expect(list.find((c) => c.name === 'triage')).toMatchObject({ source: 'skill', sigil: '$' });
  });

  it('$CODEX_HOME 优先于 homedir', async () => {
    process.env.CODEX_HOME = path.join(root, 'elsewhere');
    touch(path.join(root, 'elsewhere/prompts/fromenv.md'), '来自环境变量');
    touch(path.join(codexHome(), 'prompts/ignored.md'), '不该出现');
    const surface = createCodexCommandSurface({ skills: official(null) });

    const list = await surface.list({ projectPath: root, homedir: home() });
    expect(list.some((c) => c.name === 'fromenv')).toBe(true);
    expect(list.some((c) => c.name === 'ignored')).toBe(false);
  });

  it('同名以内建为准', async () => {
    touch(path.join(codexHome(), 'prompts/model.md'), '自定义同名');
    const surface = createCodexCommandSurface({ skills: official(null) });
    const list = await surface.list({ projectPath: root, homedir: home() });
    expect(list.filter((c) => c.name === 'model')).toHaveLength(1);
    expect(list.find((c) => c.name === 'model')?.source).toBe('builtin');
  });

  it('返显如实答 null（rollout 不记 TUI 命令）', async () => {
    expect(await CODEX_COMMANDS.executions(path.join(root, 'x.jsonl'))).toBeNull();
  });
});
