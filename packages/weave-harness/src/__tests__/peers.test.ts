import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveClaudePeer } from '../claude/peers.js';

/** peer 注册表寻址面：只认 <pid>.json 命名、坏行跳过、name 缺失不当命中。 */
describe('resolveClaudePeer', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'weave-peers-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('sessionId 命中 → 注册名', () => {
    writeFileSync(
      join(dir, '3116.json'),
      JSON.stringify({ pid: 3116, sessionId: 'sid-a', name: 'weave功能规划' }),
      'utf8',
    );
    expect(resolveClaudePeer('sid-a', dir)).toEqual({ name: 'weave功能规划' });
  });

  it('查无登记 → null（未开或已死）', () => {
    writeFileSync(
      join(dir, '28888.json'),
      JSON.stringify({ pid: 28888, sessionId: 'sid-b', name: 'weave-spike-target' }),
      'utf8',
    );
    expect(resolveClaudePeer('sid-a', dir)).toBeNull();
  });

  it('目录不存在 → null；坏 JSON 行跳过不抛', () => {
    expect(resolveClaudePeer('sid-a', join(dir, 'nope'))).toBeNull();
    writeFileSync(join(dir, '1.json'), 'not json', 'utf8');
    expect(resolveClaudePeer('sid-a', dir)).toBeNull();
  });

  it('非 <pid>.json 命名与 name 缺失的行不当命中', () => {
    writeFileSync(join(dir, 'readme.txt'), JSON.stringify({ sessionId: 'sid-a', name: 'x' }), 'utf8');
    writeFileSync(join(dir, '2.json'), JSON.stringify({ pid: 2, sessionId: 'sid-a' }), 'utf8');
    expect(resolveClaudePeer('sid-a', dir)).toBeNull();
  });
});
