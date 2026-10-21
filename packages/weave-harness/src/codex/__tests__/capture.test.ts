import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HARNESS_EVENTS } from '@weavecode/core';
import {
  CODEX_HOOK_EVENTS,
  captureGroupsPresent,
  installUserCapture,
  readScriptHealth,
  readUserCapture,
  stripProjectCapture,
  sweepWeaveHookEvents,
  uninstallUserCapture,
} from '../capture.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'weave-codex-capture-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const hooksFile = (): string => path.join(home, '.codex', 'hooks.json');
const scriptFile = (): string => path.join(home, '.codex', 'helpers', 'hook-handler.cjs');

async function readHooks(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(hooksFile(), 'utf-8'));
}

const handlersOf = (doc: Record<string, any>): Array<Record<string, any>> =>
  Object.values(doc.hooks as Record<string, any[]>)
    .flat()
    .flatMap((group) => group.hooks);

const commandsOf = (doc: Record<string, any>): string[] =>
  handlersOf(doc).map((h) => h.command as string);

describe('CODEX_HOOK_EVENTS', () => {
  it('由 HARNESS_EVENTS.codex 反推：中断事件声明成 codex 线名 Interrupt', () => {
    expect(CODEX_HOOK_EVENTS).toContain('Interrupt');
    expect(CODEX_HOOK_EVENTS).not.toContain('TurnAborted');
    expect(CODEX_HOOK_EVENTS).toHaveLength(HARNESS_EVENTS.codex.length);
  });
});

describe('installUserCapture', () => {
  it('装出 hooks.json 的十个事件组 + hook-handler 脚本', async () => {
    await installUserCapture({ home, version: '1.2.3' });

    const doc = await readHooks();
    expect(Object.keys(doc.hooks).sort()).toEqual([...CODEX_HOOK_EVENTS].sort());
    const commands = commandsOf(doc);
    expect(commands).toHaveLength(CODEX_HOOK_EVENTS.length);
    for (const command of commands) {
      expect(command).toContain('helpers/hook-handler.cjs');
    }

    const script = await readFile(scriptFile(), 'utf-8');
    expect(script).toContain('@version weave@1.2.3');
    expect(script).toContain("const OWN_HARNESS = \"codex\"");
  });

  it('超时恒 ≤3s：codex 把 SessionEnd / Interrupt 的上限压到 3s，写大了每次启动都打告警', async () => {
    await installUserCapture({ home, version: '1.2.3' });
    for (const handler of handlersOf(await readHooks())) {
      expect(handler.timeout).toBeLessThanOrEqual(3);
    }
  });

  it('编码为 codex：可注入事件表为空（脚本永不往 codex 回注上下文）', async () => {
    await installUserCapture({ home, version: '1.2.3' });
    const script = await readFile(scriptFile(), 'utf-8');
    expect(script).toContain('const INJECTABLE_EVENTS = [];');
    expect(script).toContain('const TITLE_EVENTS = [];');
  });

  it('命令串不随版本变——trusted_hash 才能跨 weave 升级保持有效', async () => {
    await installUserCapture({ home, version: '1.2.3' });
    const before = commandsOf(await readHooks());
    await installUserCapture({ home, version: '9.9.9' });
    expect(commandsOf(await readHooks())).toEqual(before);
  });

  it('幂等：装两次不会翻倍', async () => {
    await installUserCapture({ home, version: '1.2.3' });
    await installUserCapture({ home, version: '1.2.3' });
    expect(commandsOf(await readHooks())).toHaveLength(CODEX_HOOK_EVENTS.length);
  });

  it('用户自己的 hook 组与 description 一个都不动', async () => {
    await mkdir(path.dirname(hooksFile()), { recursive: true });
    await writeFile(
      hooksFile(),
      JSON.stringify({
        description: 'my own hooks',
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
      }),
    );

    await installUserCapture({ home, version: '1.2.3' });

    const doc = await readHooks();
    expect(doc.description).toBe('my own hooks');
    const stopCommands = (doc.hooks.Stop as any[]).flatMap((g) => g.hooks).map((h) => h.command);
    expect(stopCommands).toContain('say done');
    expect(stopCommands.some((c: string) => c.includes('helpers/hook-handler.cjs'))).toBe(true);
  });

  it('用户文件不是合法 JSON 时不碰（无法合并就不写）', async () => {
    await mkdir(path.dirname(hooksFile()), { recursive: true });
    await writeFile(hooksFile(), '{ not json');
    await expect(installUserCapture({ home, version: '1.2.3' })).rejects.toThrow(/not parseable/);
    expect(await readFile(hooksFile(), 'utf-8')).toBe('{ not json');
  });
});

describe('readUserCapture / readScriptHealth', () => {
  it('未装时报 not installed，装了如实报两件', async () => {
    expect(await readUserCapture({ home })).toEqual({ installed: false, helperPresent: false });

    await installUserCapture({ home, version: '1.2.3' });
    expect(await readUserCapture({ home })).toEqual({ installed: true, helperPresent: true });
  });

  it('health 认得出 weave 生成物与版本，且不上报 inbox 凭据（codex 无此概念）', async () => {
    await installUserCapture({ home, version: '1.2.3' });
    const health = await readScriptHealth({ home });
    expect(health.source).toBe('user');
    expect(health.present).toBe(true);
    expect(health.weaveOwned).toBe(true);
    expect(health.generatedVersion).toBe('1.2.3');
    expect(health.reportsInbox).toBe(false);
    expect(health.reportsPaneEnv).toBe(true);
  });

  it('没装时 source=none，且不假装有脚本', async () => {
    const health = await readScriptHealth({ home });
    expect(health.source).toBe('none');
    expect(health.present).toBe(false);
    expect(health.weaveOwned).toBe(false);
  });
});

describe('uninstallUserCapture', () => {
  it('清掉 weave 组、删脚本；只剩 weave 自己的东西时整份删掉', async () => {
    await installUserCapture({ home, version: '1.2.3' });
    await uninstallUserCapture({ home });
    await expect(readFile(hooksFile(), 'utf-8')).rejects.toThrow();
    await expect(readFile(scriptFile(), 'utf-8')).rejects.toThrow();
    expect(await readUserCapture({ home })).toEqual({ installed: false, helperPresent: false });
  });

  it('用户的组与 description 留着，文件不删', async () => {
    await mkdir(path.dirname(hooksFile()), { recursive: true });
    await writeFile(
      hooksFile(),
      JSON.stringify({
        description: 'my own hooks',
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
      }),
    );
    await installUserCapture({ home, version: '1.2.3' });
    await uninstallUserCapture({ home });

    const doc = await readHooks();
    expect(doc.description).toBe('my own hooks');
    expect(doc.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'say done' }] }]);
  });

  it('用户自写脚本（无 weave 标记）不删', async () => {
    await mkdir(path.dirname(scriptFile()), { recursive: true });
    await writeFile(scriptFile(), '// mine');
    await uninstallUserCapture({ home });
    expect(await readFile(scriptFile(), 'utf-8')).toBe('// mine');
  });
});

describe('stripProjectCapture', () => {
  it('清项目档的 weave 组，用户组留着', async () => {
    const project = path.join(home, 'proj');
    await mkdir(path.join(project, '.codex'), { recursive: true });
    await writeFile(
      path.join(project, '.codex', 'hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'node "/h/.codex/helpers/hook-handler.cjs"' }] },
            { hooks: [{ type: 'command', command: 'mine' }] },
          ],
        },
      }),
    );

    await stripProjectCapture(project);

    const doc = JSON.parse(await readFile(path.join(project, '.codex', 'hooks.json'), 'utf-8'));
    expect(doc.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'mine' }] }]);
  });
});

describe('sweepWeaveHookEvents', () => {
  it('非数组形状属用户，原样保留；清空的事件删键', () => {
    const swept = sweepWeaveHookEvents({
      Stop: [{ hooks: [{ type: 'command', command: 'node "/h/helpers/hook-handler.cjs"' }] }],
      Custom: { whatever: true },
    });
    expect(swept).toEqual({ Custom: { whatever: true } });
  });

  it('commandWindows 指向脚本也算 weave 组', () => {
    expect(
      captureGroupsPresent({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'x', commandWindows: 'node "C:\\h\\helpers\\hook-handler.cjs"' }] }],
        },
      }),
    ).toBe(true);
  });
});
