import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findProjectDirs } from '../commands/scan';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'weave-scan-detect-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('scan 经 Detector 识别 harness', () => {
  it('.codex 命中：codex-only 项目可注册（批 5 扩面）', async () => {
    await mkdir(path.join(tmpDir, '.codex'));
    expect(await findProjectDirs(tmpDir)).toEqual([tmpDir]);
  });

  it('AGENTS.md 命中（codex marker）', async () => {
    await writeFile(path.join(tmpDir, 'AGENTS.md'), '# agents\n');
    expect(await findProjectDirs(tmpDir)).toEqual([tmpDir]);
  });

  it('.weave 命中（存量判定不变）', async () => {
    await mkdir(path.join(tmpDir, '.weave'));
    expect(await findProjectDirs(tmpDir)).toEqual([tmpDir]);
  });

  it('.claude 命中（存量判定不变）', async () => {
    await mkdir(path.join(tmpDir, '.claude'));
    expect(await findProjectDirs(tmpDir)).toEqual([tmpDir]);
  });

  it('无 marker 的目录不注册，并递归找子目录中的 marker', async () => {
    await mkdir(path.join(tmpDir, 'pkg'));
    expect(await findProjectDirs(tmpDir)).toEqual([]);
    await mkdir(path.join(tmpDir, 'pkg', '.claude'));
    expect(await findProjectDirs(tmpDir)).toEqual([path.join(tmpDir, 'pkg')]);
  });
});
