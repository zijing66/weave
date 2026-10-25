import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { logger } from '@weavecode/core';
import { ensureHarnessInstalled, prewriteTrust, type ProvisionIo } from '../init/provision';
import type { PromptPort } from '../init/prompt';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'weave-provision-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** 假 PromptPort：confirm 返回固定值并记录调用。 */
function fakePrompt(confirmAnswer: boolean): { port: PromptPort; confirm: ReturnType<typeof vi.fn> } {
  const confirm = vi.fn(async (_q: string, _d?: string) => confirmAnswer);
  return {
    port: { confirm, multiselect: vi.fn(async <T extends string>(_o: readonly T[], d: readonly T[]) => [...d]) } as unknown as PromptPort,
    confirm,
  };
}

/** ProvisionIo 桩：versionOf 按表回答（runInstall 后按 command 里的包名落版本），runInstall 记录调用。 */
function fakeIo(versions: Record<string, string | null> = {}) {
  const installs: string[] = [];
  const table: Record<string, string | null> = { ...versions };
  const io: ProvisionIo = {
    versionOf: vi.fn(async (bin: string) => table[bin] ?? null),
    runInstall: vi.fn(async (command: string) => {
      installs.push(command);
      // 模拟「装上了」：下次复验能探到版本（哪个 bin 装上了由 command 判）
      if (command.includes('@anthropic-ai/claude-code')) table['claude'] = '2.1.296';
      if (command.includes('@openai/codex')) table['codex'] = '0.164.0';
    }),
  };
  return { io, installs };
}

/** 临时把 stdin/stdout 标成 TTY（provision 的交互闸），用完还原。 */
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

describe('ensureHarnessInstalled（安装检测 + 一次确认代装）', () => {
  it('已装且版本达标 → 只报版本，不提问不安装', async () => {
    const { port, confirm } = fakePrompt(true);
    const { io, installs } = fakeIo({ claude: '2.1.296' });

    await ensureHarnessInstalled(['claude'], port, io);

    expect(confirm).not.toHaveBeenCalled();
    expect(installs).toEqual([]);
  });

  it('已装但低于 minVersion → 提示升级命令，不自动升级', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { port, confirm } = fakePrompt(true);
    const { io, installs } = fakeIo({ claude: '2.0.0' });

    await ensureHarnessInstalled(['claude'], port, io);

    expect(confirm).not.toHaveBeenCalled();
    expect(installs).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('2.0.0'));
  });

  it('未装 + confirm yes → 代跑安装命令并复验', async () => {
    const dim = vi.spyOn(logger, 'dim').mockImplementation(() => undefined);
    const success = vi.spyOn(logger, 'success').mockImplementation(() => undefined);
    const { port, confirm } = fakePrompt(true);
    const { io, installs } = fakeIo({ npm: '10.0.0' });

    await withTTY(async () => {
      await ensureHarnessInstalled(['claude'], port, io);
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toContain('claude');
    expect(installs).toEqual(['npm install -g @anthropic-ai/claude-code']);
    expect(dim).toHaveBeenCalledWith(expect.stringContaining('claude'));
    expect(success).toHaveBeenCalled();
  });

  it('未装 + confirm no → 只提示命令，不安装', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { port, confirm } = fakePrompt(false);
    const { io, installs } = fakeIo({ npm: '10.0.0' });

    await withTTY(async () => {
      await ensureHarnessInstalled(['codex'], port, io);
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(installs).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('npm install -g @openai/codex'));
  });

  it('非 TTY → 不提问不安装，只提示命令（安装是重操作，静默 true 不适用）', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { port, confirm } = fakePrompt(true); // 假 confirm 恒 true——非 TTY 仍不得安装
    const { io, installs } = fakeIo({});

    await ensureHarnessInstalled(['claude'], port, io);

    expect(confirm).not.toHaveBeenCalled();
    expect(installs).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('@anthropic-ai/claude-code'));
  });

  it('npm 缺失 → 提示手动命令，不提问不安装', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { port, confirm } = fakePrompt(true);
    const { io, installs } = fakeIo({});

    await withTTY(async () => {
      await ensureHarnessInstalled(['codex'], port, io);
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(installs).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('npm install -g @openai/codex'));
  });

  it('安装命令失败 → warn 复验提示，不抛出', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { port } = fakePrompt(true);
    const { io } = fakeIo({ npm: '10.0.0' });
    io.runInstall = vi.fn(async () => {
      throw new Error('exit 1');
    });

    await withTTY(async () => {
      await expect(ensureHarnessInstalled(['claude'], port, io)).resolves.toBeUndefined();
    });
    expect(warn).toHaveBeenCalled();
  });
});

describe('prewriteTrust（信任预写）', () => {
  it('claude：写入临时 HOME 的 ~/.claude.json', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'weave-provision-home-'));
    // os.homedir() 在 win32 认 USERPROFILE、posix 认 HOME——两边都指过去
    const savedHome = process.env.HOME;
    const savedProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      await prewriteTrust(['claude'], tmpDir);
      const raw = JSON.parse(await readFile(path.join(home, '.claude.json'), 'utf8')) as {
        projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
      };
      const expectedKey = path.resolve(tmpDir).replace(/\\/g, '/');
      expect(raw.projects[expectedKey]?.hasTrustDialogAccepted).toBe(true);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedProfile;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('codex：写入临时 CODEX_HOME 的 config.toml', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'weave-provision-codex-'));
    const saved = process.env.CODEX_HOME;
    // codexHome() 语义：CODEX_HOME 本身即 codex home（不再拼 .codex）
    process.env.CODEX_HOME = home;
    try {
      await prewriteTrust(['codex'], tmpDir);
      const text = await readFile(path.join(home, 'config.toml'), 'utf-8');
      expect(text).toContain('trust_level');
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('预写失败 → warn 且不抛（不阻断 init）', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    // 指到一个不可能的 HOME（把文件路径顶成一个已存在文件）制造写失败
    const blocker = path.join(tmpDir, 'blocker');
    await writeFile(blocker, 'x', 'utf8');
    const savedHome = process.env.HOME;
    const savedProfile = process.env.USERPROFILE;
    process.env.HOME = blocker;
    process.env.USERPROFILE = blocker;
    try {
      await expect(prewriteTrust(['claude'], tmpDir)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedProfile;
    }
  });
});
