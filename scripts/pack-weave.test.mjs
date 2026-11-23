import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { manifestGaps, prebuildDirsToPrune, resolvePackTargetPlatform } from './pack-weave.mjs';

test('resolvePackTargetPlatform 默认 = 当前平台', () => {
  assert.equal(resolvePackTargetPlatform(undefined, 'win32', 'x64'), 'win32-x64');
});

test('resolvePackTargetPlatform 显式与 all', () => {
  assert.equal(resolvePackTargetPlatform('darwin-arm64'), 'darwin-arm64');
  assert.equal(resolvePackTargetPlatform('all'), 'all');
  assert.equal(resolvePackTargetPlatform(' auto ', 'linux', 'arm64'), 'linux-arm64');
  assert.throws(() => resolvePackTargetPlatform('nonsense'));
});

test('prebuildDirsToPrune 只删非目标平台前缀', () => {
  const dirs = ['win32-x64', 'win32-arm64', 'darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'readme.md'];
  assert.deepEqual(prebuildDirsToPrune(dirs, 'win32-x64'), ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']);
  assert.deepEqual(prebuildDirsToPrune(dirs, 'all'), []);
});

test('prebuildDirsToPrune 非法名不删、no-op', () => {
  assert.deepEqual(prebuildDirsToPrune(['weird'], 'win32-x64'), []);
  assert.deepEqual(prebuildDirsToPrune([], 'win32-x64'), []);
});

test('manifestGaps：main/types/bin/exports 指到的文件缺了就报，齐了返回空', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pack-gap-'));
  try {
    mkdirSync(path.join(dir, 'dist'), { recursive: true });
    writeFileSync(path.join(dir, 'dist', 'index.js'), '');
    writeFileSync(path.join(dir, 'dist', 'index.d.ts'), '');
    writeFileSync(path.join(dir, 'cli.js'), '');
    const full = {
      main: 'dist/index.js',
      types: 'dist/index.d.ts',
      bin: { weave: 'cli.js' },
      exports: { '.': { import: 'dist/index.js', default: 'dist/index.js' } },
    };
    assert.deepEqual(manifestGaps(full, dir), []);
    // types 文件没拷出来（tsc 不产 .d.ts 的那类漏）→ 报缺
    rmSync(path.join(dir, 'dist', 'index.d.ts'), { force: true });
    assert.deepEqual(manifestGaps(full, dir), ['dist/index.d.ts']);
    // bin 缺
    rmSync(path.join(dir, 'cli.js'), { force: true });
    assert.deepEqual(manifestGaps(full, dir), ['dist/index.d.ts', 'cli.js']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
