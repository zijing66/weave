import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prebuildDirsToPrune, resolvePackTargetPlatform } from './pack-weave.mjs';

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
