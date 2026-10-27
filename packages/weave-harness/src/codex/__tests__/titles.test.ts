import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexSessionTitleOf } from '../titles.js';

/**
 * 集成式测法：临时 CODEX_HOME 摆真 session_index.jsonl（append-only 行、
 * 最新条目胜——与宿主 find_thread_name_by_id 同判据）。
 */

describe('codexSessionTitleOf（session_index 从尾扫）', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'weave-codex-titles-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const index = () => join(home, '.codex', 'session_index.jsonl');
  let tick = 0;
  const writeIndex = (lines: string[]) => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(index(), lines.join('\n') + '\n');
    // mtime+size 是缓存指纹：显式错开 mtime 保证「重读」路径可测
    tick += 1;
    const t = new Date(Date.now() + tick * 1000);
    utimesSync(index(), t, t);
  };

  it('文件不存在 → null', () => {
    expect(codexSessionTitleOf('01a176ba', home)).toBeNull();
  });

  it('单条条目 → 返回 thread_name', () => {
    writeIndex(['{"id":"01a176ba","thread_name":"codex测试","updated_at":"2026-10-26T00:00:00Z"}']);
    expect(codexSessionTitleOf('01a176ba', home)).toBe('codex测试');
  });

  it('同 id 多行 → 最新条目胜（append 顺序）', () => {
    writeIndex([
      '{"id":"01a176ba","thread_name":"旧名","updated_at":"2026-10-26T00:00:00Z"}',
      '{"id":"ffffffff","thread_name":"别人","updated_at":"2026-10-26T00:01:00Z"}',
      '{"id":"01a176ba","thread_name":"新名","updated_at":"2026-10-26T00:02:00Z"}',
    ]);
    expect(codexSessionTitleOf('01a176ba', home)).toBe('新名');
  });

  it('最新条目为空串（宿主清除名字）→ null', () => {
    writeIndex([
      '{"id":"01a176ba","thread_name":"曾用名","updated_at":"2026-10-26T00:00:00Z"}',
      '{"id":"01a176ba","thread_name":"","updated_at":"2026-10-26T00:01:00Z"}',
    ]);
    expect(codexSessionTitleOf('01a176ba', home)).toBeNull();
  });

  it('坏行与非字符串字段跳过，不影响后续条目', () => {
    writeIndex([
      'not-json',
      '{"id":"01a176ba"}',
      '{"id":"01a176ba","thread_name":"好名","updated_at":"2026-10-26T00:00:00Z"}',
    ]);
    expect(codexSessionTitleOf('01a176ba', home)).toBe('好名');
  });

  it('查无此 id → null', () => {
    writeIndex(['{"id":"ffffffff","thread_name":"别人","updated_at":"2026-10-26T00:00:00Z"}']);
    expect(codexSessionTitleOf('01a176ba', home)).toBeNull();
  });

  it('文件变化后重读（mtime+size 指纹失效）', () => {
    writeIndex(['{"id":"01a176ba","thread_name":"v1","updated_at":"2026-10-26T00:00:00Z"}']);
    expect(codexSessionTitleOf('01a176ba', home)).toBe('v1');
    writeIndex(['{"id":"01a176ba","thread_name":"v2","updated_at":"2026-10-26T00:01:00Z"}']);
    expect(codexSessionTitleOf('01a176ba', home)).toBe('v2');
  });
});
