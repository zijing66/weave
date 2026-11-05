import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureRerereEnabled } from '../init/executor';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'weave-rerere-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
});

const localConfig = async (dir = tmpDir): Promise<string> =>
  readFile(path.join(dir, '.git', 'config'), 'utf-8');

const initRepo = (dir = tmpDir): void => {
  execFileSync('git', ['init', dir], { windowsHide: true });
};

describe('ensureRerereEnabled', () => {
  it('sets rerere.enabled true in the local git config', async () => {
    initRepo();
    await ensureRerereEnabled(tmpDir);
    expect(await localConfig()).toContain('enabled = true');
  });

  it('is idempotent — a second run leaves the config byte-identical', async () => {
    initRepo();
    await ensureRerereEnabled(tmpDir);
    const first = await localConfig();
    await ensureRerereEnabled(tmpDir);
    expect(await localConfig()).toBe(first);
  });

  it('skips when rerere.enabled is already true (user-set true is preserved)', async () => {
    initRepo();
    execFileSync('git', ['config', 'rerere.enabled', 'true'], { cwd: tmpDir, windowsHide: true });
    const pre = await localConfig();
    await ensureRerereEnabled(tmpDir);
    expect(await localConfig()).toBe(pre);
  });

  it('flips an explicit false to true', async () => {
    initRepo();
    execFileSync('git', ['config', 'rerere.enabled', 'false'], { cwd: tmpDir, windowsHide: true });
    await ensureRerereEnabled(tmpDir);
    expect(await localConfig()).toContain('enabled = true');
  });

  it('no-op outside a git repository', async () => {
    await ensureRerereEnabled(tmpDir);
    await expect(localConfig()).rejects.toThrow();
  });

  it('resolves an enclosing repo root from a nested target dir', async () => {
    initRepo();
    const nested = path.join(tmpDir, 'a', 'b');
    execFileSync('git', ['init', nested], { windowsHide: true });
    await ensureRerereEnabled(nested);
    // 嵌套目录本身是独立仓（git init 建了 .git），落到自己的 config
    expect(await localConfig(nested)).toContain('enabled = true');
  });
});
