import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { logger } from '@weave/core';
import { executeInit } from '../init/executor';
import { parseHarnessFlag } from '../commands/init';
import { CodexInitTemplate } from '../init/harnesses/codex';
import type { PromptPort } from '../init/prompt';
import type { InitContext } from '@weave/harness';
import { t } from '../i18n';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'weave-harness5-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const BASE_OPTIONS = {
  targetDir: '' as string,
  force: false,
  interactive: false,
  preset: 'default' as const,
  components: {},
  hooks: {},
  skills: {},
  commands: {},
  agents: {},
  mcp: {},
};

/** 记录 multiselect 调用的假 PromptPort（返回值固定为 picked）。 */
function fakePrompt(picked: string[] = ['claude']) {
  const multiselect = vi.fn(
    async (_options: readonly string[], _defaults: readonly string[]) => [...picked],
  );
  const port = {
    confirm: async () => true,
    multiselect,
  } as unknown as PromptPort;
  return { port, multiselect };
}

/** 临时把 stdin/stdout 标成 TTY（executor 的交互闸），用完还原。 */
async function withTTY(run: () => Promise<void>): Promise<void> {
  const origIn = process.stdin.isTTY;
  const origOut = process.stdout.isTTY;
  (process.stdin as { isTTY?: boolean }).isTTY = true;
  (process.stdout as { isTTY?: boolean }).isTTY = true;
  try {
    await run();
  } finally {
    (process.stdin as { isTTY?: boolean }).isTTY = origIn;
    (process.stdout as { isTTY?: boolean }).isTTY = origOut;
  }
}

describe('parseHarnessFlag（--harness flag 解析）', () => {
  it('空/缺省 → undefined（交给交互/默认两级）', () => {
    expect(parseHarnessFlag('')).toBeUndefined();
    expect(parseHarnessFlag('   ')).toBeUndefined();
  });

  it('逗号列表 → 去重保序的合法项（大小写不敏感）', () => {
    expect(parseHarnessFlag('codex,claude')).toEqual(['codex', 'claude']);
    expect(parseHarnessFlag('claude,CLAUDE')).toEqual(['claude']);
  });

  it('部分非法 → warn 并忽略非法项，保留合法项', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(parseHarnessFlag('claude,foo')).toEqual(['claude']);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('全非法 → warn 后回落默认 [claude]', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(parseHarnessFlag('foo,bar')).toEqual(['claude']);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('三级优先级：--harness flag > prompt.multiselect() > 默认 [claude]', () => {
  it('flag 优先：给定 --harness 时不调用 multiselect', async () => {
    const prompt = fakePrompt(['claude']);
    const result = await executeInit(
      { ...BASE_OPTIONS, targetDir: tmpDir, interactive: true, harnesses: ['codex'] },
      prompt.port,
    );

    expect(prompt.multiselect).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.created.directories).toContain(path.join(tmpDir, '.codex'));
    expect(result.created.directories).not.toContain(path.join(tmpDir, '.claude'));
  });

  it('次级交互：无 flag 且 TTY 且 interactive → 调用 multiselect，结果生效', async () => {
    const prompt = fakePrompt(['claude', 'codex']);
    await withTTY(async () => {
      await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir, interactive: true }, prompt.port);
    });

    expect(prompt.multiselect).toHaveBeenCalledTimes(1);
    const config = await readFile(path.join(tmpDir, '.weave', 'config.yaml'), 'utf-8');
    expect(config).toContain('harnesses: ["claude","codex"]');
  });

  it('末级默认：无 flag 且非 TTY → 静默默认 [claude]，不调用 multiselect', async () => {
    const prompt = fakePrompt(['codex']);
    const result = await executeInit(
      { ...BASE_OPTIONS, targetDir: tmpDir, interactive: true },
      prompt.port,
    );

    expect(prompt.multiselect).not.toHaveBeenCalled();
    expect(result.created.directories).toContain(path.join(tmpDir, '.claude'));
    expect(result.created.directories).not.toContain(path.join(tmpDir, '.codex'));
  });

  it('末级默认：--no-interactive（interactive=false）→ 默认 [claude]，不调用 multiselect', async () => {
    const prompt = fakePrompt(['codex']);
    const result = await executeInit(
      { ...BASE_OPTIONS, targetDir: tmpDir, interactive: false },
      prompt.port,
    );

    expect(prompt.multiselect).not.toHaveBeenCalled();
    expect(result.created.directories).toContain(path.join(tmpDir, '.claude'));
    expect(result.created.directories).not.toContain(path.join(tmpDir, '.codex'));
  });

  it('默认路径：不带 --harness、非 TTY——config.yaml 记 harnesses: ["claude"]', async () => {
    await executeInit({ ...BASE_OPTIONS, targetDir: tmpDir });
    const config = await readFile(path.join(tmpDir, '.weave', 'config.yaml'), 'utf-8');
    expect(config).toContain('harnesses: ["claude"]');
  });
});

describe('CodexInitTemplate（仅显式选择 codex 才跑）', () => {
  it('executeInit(harnesses:["codex"])：建 .codex/skills 拷 skills，不建 .claude', async () => {
    const result = await executeInit({
      ...BASE_OPTIONS,
      targetDir: tmpDir,
      harnesses: ['codex'],
    });

    expect(result.success).toBe(true);
    expect(result.created.directories).toContain(path.join(tmpDir, '.codex'));
    expect(result.created.directories).toContain(path.join(tmpDir, '.codex', 'skills'));
    expect(result.created.directories).not.toContain(path.join(tmpDir, '.claude'));
    expect(
      result.created.files.some((f) => f.includes(path.join('.codex', 'skills'))),
    ).toBe(true);

    const config = await readFile(path.join(tmpDir, '.weave', 'config.yaml'), 'utf-8');
    expect(config).toContain('harnesses: ["codex"]');
  });

  it('无对等面的 6 步 skip(step, 无对等面)，顺序按 runSurface 骨架', async () => {
    const ctx: InitContext = {
      targetDir: tmpDir,
      force: false,
      interactive: false,
      preset: 'default',
      components: {},
      hooks: {},
      skills: {},
      commands: {},
      agents: {},
      mcp: {},
      platform: {
        os: 'linux',
        arch: 'x64',
        nodeVersion: 'v20.0.0',
        shell: 'bash',
        homeDir: '/home/test',
        configDir: '/home/test/.config',
      },
    };
    const pipeline = new CodexInitTemplate(ctx);
    await pipeline.runSurface();

    expect(pipeline.skipped).toEqual([
      'writeSettings',
      'writeMcp',
      'copyCommands',
      'copyAgents',
      'injectPluginTemplates',
      'writeHelpers',
    ]);
    expect(pipeline.skipReasons.get('writeSettings')).toBe(t('init.noPeerFace'));
    expect(pipeline.records.created.directories).toContain(path.join(tmpDir, '.codex'));
  });

  it('已有 skill 文件不覆写（与 claude 同 force 语义）', async () => {
    const skillPath = path.join(tmpDir, '.codex', 'skills', 'code-review', 'SKILL.md');
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(skillPath, '# user custom content');

    const result = await executeInit({
      ...BASE_OPTIONS,
      targetDir: tmpDir,
      harnesses: ['codex'],
    });

    expect(result.skipped).toContain(skillPath);
    expect(await readFile(skillPath, 'utf-8')).toBe('# user custom content');
  });
});
