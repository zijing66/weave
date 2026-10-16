import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setGlobalStatuslineDir } from '../../statusline/manager.js';
import { applyInitFile, detectInitFileUpdates, needsInit } from '../init-files.js';

/**
 * init 生成物的漂移自愈：不进 git 的自动代写刷新，会进 git 的只报不写。
 * 期望态经 harness 的 generateInitFiles（与 init 同一套生成器）。
 */

let projectDir: string;
let globalDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), 'weave-initfiles-'));
  globalDir = mkdtempSync(path.join(tmpdir(), 'weave-initfiles-g-'));
  setGlobalStatuslineDir(globalDir);
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(globalDir, { recursive: true, force: true });
});

function git(...args: string[]): void {
  execFileSync('git', ['-C', projectDir, ...args], { stdio: 'ignore' });
}

function writeConfig(overrides?: Record<string, unknown>): void {
  const runtimeConfig = {
    initVersion: '0.0.1',
    initTimestamp: new Date().toISOString(),
    preset: 'default',
    harnesses: ['claude'],
    components: {
      settings: true,
      skills: true,
      commands: false,
      agents: false,
      helpers: true,
      mcp: true,
      claudeMd: true,
      agentsMd: true,
    },
    ...overrides,
  };
  mkdirSync(path.join(projectDir, '.weave'), { recursive: true });
  writeFileSync(
    path.join(projectDir, '.weave', 'config.yaml'),
    Object.entries(runtimeConfig)
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join('\n') + '\n',
  );
}

function read(rel: string): string {
  return readFileSync(path.join(projectDir, ...rel.split('/')), 'utf-8');
}

const handlerRel = '.claude/helpers/hook-handler.cjs';

describe('detectInitFileUpdates', () => {
  it('盘上缺失 → 全部 outdated；非 git 仓库 → 全部 auto', async () => {
    writeConfig();
    const updates = await detectInitFileUpdates(projectDir);
    expect(updates.length).toBeGreaterThan(2);
    expect(updates.every((u) => u.outdated)).toBe(true);
    expect(updates.every((u) => u.syncClass === 'auto')).toBe(true);
    expect(needsInit(updates)).toBe(false);
  });

  it('期望态与盘上一致 → 不 outdated', async () => {
    writeConfig();
    for (const u of await detectInitFileUpdates(projectDir)) {
      await applyInitFile(u);
    }
    const after = await detectInitFileUpdates(projectDir);
    expect(after.filter((u) => u.outdated)).toEqual([]);
  });

  it('旧版 weave 生成物 → outdated，apply 复原到当前版本', async () => {
    writeConfig();
    mkdirSync(path.join(projectDir, '.claude', 'helpers'), { recursive: true });
    writeFileSync(path.join(projectDir, ...handlerRel.split('/')), '// @version weave@0.0.1\nold\n');

    const updates = await detectInitFileUpdates(projectDir);
    const handler = updates.find((u) => u.relPath === handlerRel)!;
    expect(handler.outdated).toBe(true);
    expect(handler.syncClass).toBe('auto');

    expect(await applyInitFile(handler)).toBe(true);
    const content = read(handlerRel);
    expect(content).toContain('@version weave@0.1.0');
    expect(content).not.toContain('0.0.1');
  });

  it('用户手写的同名文件（无 weave 标记）→ 不是 drift，apply 不碰', async () => {
    writeConfig();
    mkdirSync(path.join(projectDir, '.claude', 'helpers'), { recursive: true });
    writeFileSync(path.join(projectDir, ...handlerRel.split('/')), '// mine, hand written\n');

    const updates = await detectInitFileUpdates(projectDir);
    const handler = updates.find((u) => u.relPath === handlerRel)!;
    expect(handler.outdated).toBe(false);
    expect(handler.expectedContent).toBeNull();
    expect(await applyInitFile(handler)).toBe(false);
    expect(read(handlerRel)).toBe('// mine, hand written\n');
  });

  it('settings.json 是 merge 类：漂移只落在 weave 自有面，用户键保留', async () => {
    writeConfig();
    mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
    writeFileSync(
      path.join(projectDir, '.claude', 'settings.json'),
      JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine.cjs' }] }] } }, null, 2) + '\n',
    );

    const updates = await detectInitFileUpdates(projectDir);
    const settings = updates.find((u) => u.relPath === '.claude/settings.json')!;
    expect(settings.outdated).toBe(true);
    expect(settings.syncClass).toBe('auto');

    await applyInitFile(settings);
    const merged = JSON.parse(read('.claude/settings.json')) as Record<string, unknown>;
    expect(merged['theme']).toBe('dark');
    // weave 组并进来了，用户自己的 Stop 组仍在
    expect(Object.keys(merged['hooks'] as object).length).toBeGreaterThan(1);
    expect(JSON.stringify(merged['hooks'])).toContain('mine.cjs');

    // 幂等：再检测一次不再 outdated
    const after = await detectInitFileUpdates(projectDir);
    expect(after.find((u) => u.relPath === '.claude/settings.json')!.outdated).toBe(false);
  });

  it('config.yaml 的 hooks 落档生效：裁剪过的事件集不会被默认值顶回去', async () => {
    writeConfig({
      hooks: {
        preToolUse: true,
        postToolUse: false,
        userPromptSubmit: false,
        sessionStart: false,
        stop: false,
        subagentStop: false,
        notification: false,
        preCompact: false,
        sessionEnd: false,
        timeout: 5000,
        continueOnError: true,
      },
    });
    for (const u of await detectInitFileUpdates(projectDir)) await applyInitFile(u);

    const settings = JSON.parse(read('.claude/settings.json')) as { hooks: Record<string, unknown> };
    expect(Object.keys(settings.hooks)).toEqual(['PreToolUse']);
    expect((await detectInitFileUpdates(projectDir)).some((u) => u.outdated)).toBe(false);
  });

  it('会进 git 的 init 文件：manual，apply 拒写，needsInit 提醒', async () => {
    writeConfig();
    mkdirSync(path.join(projectDir, '.claude', 'helpers'), { recursive: true });
    writeFileSync(path.join(projectDir, ...handlerRel.split('/')), '// @version weave@0.0.1\nold\n');
    writeFileSync(path.join(projectDir, '.gitignore'), 'nothing-matches\n');
    git('init');
    git('add', '-f', '.gitignore');
    git('add', '-f', handlerRel);

    const updates = await detectInitFileUpdates(projectDir);
    const handler = updates.find((u) => u.relPath === handlerRel)!;
    expect(handler.syncClass).toBe('manual');
    expect(handler.outdated).toBe(true);
    expect(await applyInitFile(handler)).toBe(false);
    expect(read(handlerRel)).toContain('0.0.1');
    expect(needsInit(updates)).toBe(true);
  });
});
