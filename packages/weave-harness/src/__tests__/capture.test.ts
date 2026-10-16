import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CLAUDE_CAPTURE,
  captureGroupsPresent,
  captureHookGroup,
  generateHookHandler,
  groupIsWeave,
  installUserCapture,
  readUserCapture,
  stripProjectCapture,
  sweepWeaveHookEvents,
  uninstallUserCapture,
} from '../claude/capture.js';
import { HARNESS_EVENTS, INJECTABLE_EVENTS, TERMINAL_LOCATOR_ENV_KEYS } from '@weavecode/core';

function tempHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'weave-capture-'));
}

/** 用户自己的 hook 组（无 hook-handler 路径段）——清扫必须原样保留。 */
const USER_GROUP = [{ matcher: 'Write', hooks: [{ type: 'command', command: 'node ./mine.cjs' }] }];

/** 真实形 helpersDir：marker 判据按 `.claude/helpers/hook-handler.cjs` 路径段匹配。 */
const HD = path.join('proj', '.claude', 'helpers');

describe('captureHookGroup 组形（项目档与 user 档同形）', () => {
  const helpersDir = path.join('proj', '.claude', 'helpers');

  it('生成的 hook-handler 上报会话 inbox 凭据（env 名取自 claude 规格，不手抄）', () => {
    const script = generateHookHandler('0.0.0-test');
    expect(script).toContain('CLAUDE_CODE_MESSAGING_SOCKET');
    expect(script).toContain('CLAUDE_CODE_MESSAGING_TOKEN');
    // 旁路字段进 inbox 行（不进 report/payload —— daemon 侧只放内存）
    expect(script).toContain('messaging: messagingEnv()');
  });

  it('生成的 hook-handler 上报终端 pane 定位键（键名取自 core 表，不手抄）', () => {
    const script = generateHookHandler('0.0.0-test');
    for (const key of TERMINAL_LOCATOR_ENV_KEYS) expect(script).toContain(JSON.stringify(key));
    expect(script).toContain('terminal: terminalEnv()');
  });

  it('七事件全形：matcher=* + 三层结构 + 命令指向 helpers 下的 hook-handler.cjs', () => {
    const group = captureHookGroup('PostToolUse', helpersDir)[0] as Record<string, unknown>;
    expect(group['matcher']).toBe('*');
    const inner = group['hooks'] as Array<Record<string, unknown>>;
    expect(inner).toHaveLength(1);
    expect(inner[0]!['type']).toBe('command');
    expect(String(inner[0]!['command'])).toContain('hook-handler.cjs');
  });

  it('async 分类与 INJECTABLE_EVENTS.claude 同源：不可注入事件 async:true', () => {
    for (const event of HARNESS_EVENTS.claude) {
      const group = captureHookGroup(event, helpersDir)[0] as Record<string, unknown>;
      const inner = group['hooks'] as Array<Record<string, unknown>>;
      const injectable = (INJECTABLE_EVENTS.claude as readonly string[]).includes(event);
      expect(inner[0]!['async']).toBe(injectable ? undefined : true);
    }
  });

  it('Windows 分隔符归一后仍命中判据（groupIsWeave 两侧都归一）', () => {
    const winDir = 'D:\\proj\\.claude\\helpers';
    const group = captureHookGroup('Stop', winDir)[0];
    expect(groupIsWeave(group)).toBe(true);
    expect(groupIsWeave(USER_GROUP[0])).toBe(false);
  });
});

describe('sweepWeaveHookEvents 清扫', () => {
  it('只清 weave 组；用户组保留；事件清空删键；hooks 清空返回 undefined', () => {
    const hooks = {
      PostToolUse: [...captureHookGroup('PostToolUse', HD), ...USER_GROUP],
      Stop: captureHookGroup('Stop', HD),
      SessionStart: USER_GROUP,
    };
    const swept = sweepWeaveHookEvents(hooks)!;
    expect(swept['PostToolUse']).toEqual(USER_GROUP);
    expect(swept['Stop']).toBeUndefined();
    expect(swept['SessionStart']).toEqual(USER_GROUP);
    expect(sweepWeaveHookEvents({ Stop: captureHookGroup('Stop', HD) })).toBeUndefined();
  });

  it('非数组形状属用户数据，原样保留', () => {
    const swept = sweepWeaveHookEvents({ weird: 'user-shape' })!;
    expect(swept['weird']).toBe('user-shape');
  });
});

describe('user 档采集安装/停用（§2.6 基石）', () => {
  let home: string;
  beforeEach(() => {
    home = tempHome();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const settingsFile = () => path.join(home, '.claude', 'settings.json');
  const readSettings = (): Record<string, unknown> =>
    JSON.parse(readFileSync(settingsFile(), 'utf-8')) as Record<string, unknown>;

  it('安装：写 user 级脚本 + user settings 七事件组；用户既有键/组不动', async () => {
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(
      settingsFile(),
      JSON.stringify({ model: 'opus', hooks: { PostToolUse: USER_GROUP } }),
      'utf-8',
    );
    await installUserCapture({ home, version: '9.9.9' });

    const settings = readSettings();
    expect(settings['model']).toBe('opus');
    const hooks = settings['hooks'] as Record<string, unknown[]>;
    expect(Object.keys(hooks).sort()).toEqual([...HARNESS_EVENTS.claude].sort());
    expect((hooks['PostToolUse'] as unknown[]).length).toBe(2); // 用户组 + weave 组
    expect(captureGroupsPresent(settings)).toBe(true);

    const script = readFileSync(path.join(home, '.claude', 'helpers', 'hook-handler.cjs'), 'utf-8');
    expect(script).toContain('@version weave@9.9.9');
  });

  it('读态：installed 判据 = user settings 有 weave 组；helperPresent 判据 = 脚本在', async () => {
    expect(await readUserCapture({ home })).toEqual({ installed: false, helperPresent: false });
    await installUserCapture({ home, version: '1.0.0' });
    expect(await readUserCapture({ home })).toEqual({ installed: true, helperPresent: true });
    // 半安装可见：组被清而脚本残留
    await uninstallUserCapture({ home });
    await installUserCapture({ home, version: '1.0.0' });
    writeFileSync(
      settingsFile(),
      JSON.stringify({ hooks: { PostToolUse: USER_GROUP } }),
      'utf-8',
    );
    expect(await readUserCapture({ home })).toEqual({ installed: false, helperPresent: true });
  });

  it('停用：清 weave 组（用户组/键保留）+ 删带标记的 user 级脚本；幂等', async () => {
    await installUserCapture({ home, version: '1.0.0' });
    await uninstallUserCapture({ home });

    const settings = readSettings();
    expect(captureGroupsPresent(settings)).toBe(false);
    expect(settings['hooks']).toBeUndefined();
    expect(await readUserCapture({ home })).toEqual({ installed: false, helperPresent: false });
    // 幂等：再来一次无副作用
    await expect(uninstallUserCapture({ home })).resolves.toBeUndefined();
  });

  it('重装（版本刷新）：旧 weave 组整体替换，不叠加', async () => {
    await installUserCapture({ home, version: '1.0.0' });
    await installUserCapture({ home, version: '2.0.0' });
    const hooks = readSettings()['hooks'] as Record<string, unknown[]>;
    expect((hooks['PostToolUse'] as unknown[]).length).toBe(1);
    const script = readFileSync(path.join(home, '.claude', 'helpers', 'hook-handler.cjs'), 'utf-8');
    expect(script).toContain('@version weave@2.0.0');
  });

  it('user settings 存在但不可解析 → 安装抛错（无法合并进去就不碰）', async () => {
    mkdirSync(path.dirname(settingsFile()), { recursive: true });
    writeFileSync(settingsFile(), 'not json', 'utf-8');
    await expect(installUserCapture({ home, version: '1.0.0' })).rejects.toThrow(/not parseable/);
    expect(readFileSync(settingsFile(), 'utf-8')).toBe('not json');
  });

  it('停用对坏文件不碰（组不可能在坏文件里，不动即目标态）', async () => {
    mkdirSync(path.dirname(settingsFile()), { recursive: true });
    writeFileSync(settingsFile(), 'not json', 'utf-8');
    await expect(uninstallUserCapture({ home })).resolves.toBeUndefined();
    expect(readFileSync(settingsFile(), 'utf-8')).toBe('not json');
  });

  it('表面兑现接口：CLAUDE_CAPTURE 三读写一清扫齐备', async () => {
    expect(CLAUDE_CAPTURE.harness).toBe('claude');
    await CLAUDE_CAPTURE.installUserCapture({ home, version: '1.0.0' });
    expect((await CLAUDE_CAPTURE.readUserCapture({ home })).installed).toBe(true);
    await CLAUDE_CAPTURE.uninstallUserCapture({ home });
    expect((await CLAUDE_CAPTURE.readUserCapture({ home })).installed).toBe(false);
  });
});

describe('stripProjectCapture 项目档去重（user 档接管时）', () => {
  it('清扫项目 settings 的 weave 组；用户组保留；缺文件 = no-op', async () => {
    const projectDir = tempHome();
    try {
      const file = path.join(projectDir, '.claude', 'settings.json');
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({
          hooks: { PostToolUse: [...captureHookGroup('PostToolUse', HD), ...USER_GROUP], Stop: captureHookGroup('Stop', HD) },
        }),
        'utf-8',
      );
      await stripProjectCapture(projectDir);
      const settings = JSON.parse(readFileSync(file, 'utf-8')) as {
        hooks: Record<string, unknown[]>;
      };
      expect(settings.hooks['PostToolUse']).toEqual(USER_GROUP);
      expect(settings.hooks['Stop']).toBeUndefined();
      // 幂等 + 缺文件 no-op
      await stripProjectCapture(projectDir);
      await stripProjectCapture(path.join(projectDir, 'never-inited'));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('generateHookHandler 版本标记', () => {
  it('脚本头带调用方传入的版本戳', () => {
    expect(generateHookHandler('3.2.1')).toContain('@version weave@3.2.1');
  });
});

describe('scriptHealth 诊断探针（哪一支生效 + 脚本会不会上报）', () => {
  let home: string;
  let projectDir: string;
  beforeEach(() => {
    home = tempHome();
    projectDir = mkdtempSync(path.join(tmpdir(), 'weave-proj-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  const projectScript = (content: string): void => {
    const file = path.join(projectDir, '.claude', 'helpers', 'hook-handler.cjs');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf-8');
  };

  it('user 档采集在 fire → 判 user 档脚本，版本/上报能力都读出来', async () => {
    await installUserCapture({ home, version: '1.2.3' });
    const health = await CLAUDE_CAPTURE.scriptHealth({ home, projectPath: projectDir });
    expect(health).toEqual({
      source: 'user',
      present: true,
      weaveOwned: true,
      generatedVersion: '1.2.3',
      reportsInbox: true,
      reportsPaneEnv: true,
    });
  });

  it('user 档未装 → 判项目档脚本', async () => {
    projectScript(generateHookHandler('0.1.0'));
    const health = await CLAUDE_CAPTURE.scriptHealth({ home, projectPath: projectDir });
    expect(health.source).toBe('project');
    expect(health.generatedVersion).toBe('0.1.0');
    expect(health.reportsInbox).toBe(true);
  });

  it('旧版生成物（带标记但不含凭据上报）→ reportsInbox false，即「脚本过期」', async () => {
    projectScript("// Generated by weave — do not edit manually.\n// @version weave@0.0.1\n'use strict';\n");
    const health = await CLAUDE_CAPTURE.scriptHealth({ home, projectPath: projectDir });
    expect(health).toMatchObject({
      source: 'project',
      present: true,
      weaveOwned: true,
      generatedVersion: '0.0.1',
      reportsInbox: false,
      reportsPaneEnv: false,
    });
  });

  it('用户自写脚本（无 weave 标记）→ weaveOwned false', async () => {
    projectScript('// my own hook\n');
    expect((await CLAUDE_CAPTURE.scriptHealth({ home, projectPath: projectDir })).weaveOwned).toBe(
      false,
    );
  });

  it('两处都没有 → 生效分支在、文件缺（present false），不猜有没有上报能力', async () => {
    const health = await CLAUDE_CAPTURE.scriptHealth({ home, projectPath: projectDir });
    // user 档未装 → 生效分支就是项目档；只是那份脚本不存在
    expect(health).toMatchObject({
      source: 'project',
      present: false,
      weaveOwned: false,
      reportsInbox: false,
      reportsPaneEnv: false,
    });
    // 不给 projectPath 又没装 user 档 = 没有可判的脚本
    expect((await CLAUDE_CAPTURE.scriptHealth({ home })).source).toBe('none');
  });
});
