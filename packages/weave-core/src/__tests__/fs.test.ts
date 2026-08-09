import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, writeFileIfAbsent, fileExists } from '../utils/fs';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'weave-fs-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('ensureDir', () => {
  it('creates nested directories recursively', async () => {
    const nested = path.join(tmpDir, 'a', 'b', 'c');
    await ensureDir(nested);
    expect(await fileExists(nested)).toBe(true);
  });

  it('is idempotent', async () => {
    await ensureDir(tmpDir);
    await expect(ensureDir(tmpDir)).resolves.toBeUndefined();
  });
});

describe('writeFileIfAbsent', () => {
  it('writes a new file and returns true', async () => {
    const f = path.join(tmpDir, 'new.txt');
    const wrote = await writeFileIfAbsent(f, 'hello', false);
    expect(wrote).toBe(true);
    expect(await fileExists(f)).toBe(true);
  });

  it('skips an existing file when force is false', async () => {
    const f = path.join(tmpDir, 'existing.txt');
    await writeFileIfAbsent(f, 'original', false);
    const wrote = await writeFileIfAbsent(f, 'overwritten', false);
    expect(wrote).toBe(false);
  });

  it('overwrites an existing file when force is true', async () => {
    const f = path.join(tmpDir, 'overwrite.txt');
    await writeFileIfAbsent(f, 'original', false);
    const wrote = await writeFileIfAbsent(f, 'new-content', true);
    expect(wrote).toBe(true);
  });

  it('creates parent directories automatically', async () => {
    const f = path.join(tmpDir, 'deep', 'path', 'file.txt');
    const wrote = await writeFileIfAbsent(f, 'content', false);
    expect(wrote).toBe(true);
    expect(await fileExists(f)).toBe(true);
  });
});

describe('fileExists', () => {
  it('returns true for an existing file', async () => {
    const f = path.join(tmpDir, 'real.txt');
    await writeFileIfAbsent(f, 'x', false);
    expect(await fileExists(f)).toBe(true);
  });

  it('returns false for a non-existent path', async () => {
    expect(await fileExists(path.join(tmpDir, 'nope.txt'))).toBe(false);
  });

  it('returns true for an existing directory', async () => {
    expect(await fileExists(tmpDir)).toBe(true);
  });
});
