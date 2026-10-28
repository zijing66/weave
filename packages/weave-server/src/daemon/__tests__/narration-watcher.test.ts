import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NarrationWatcher, type NarrationUpdatedFrame } from '../narration-watcher.js';
import { CLAUDE_NARRATION } from '@weavecode/harness';

/** 等一拍（debounce 500ms）+ 泵完。 */
const tick = (ms = 650): Promise<void> => new Promise((r) => setTimeout(r, ms));

const dirs: string[] = [];

describe('NarrationWatcher', () => {
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('增量读：只广播新认出的段，半行 carry 等下一拍', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nwatch-'));
    dirs.push(dir);
    const file = path.join(dir, 't.jsonl');
    writeFileSync(file, '');
    const frames: NarrationUpdatedFrame[] = [];
    const bus = {
      subscribe: (_l: unknown) => () => {},
      emit: (m: unknown) => frames.push(m as NarrationUpdatedFrame),
    } as never;
    const watcher = new NarrationWatcher(
      bus,
      () => CLAUDE_NARRATION,
      () => file,
      () => 'claude',
    );
    // 首拍：建游标（不广播历史）
    writeFileSync(file, '{"type":"assistant","timestamp":"2026-10-27T10:00:00Z","message":{"content":[{"type":"text","text":"第一段"}]}}\n');
    await watcher.pumpForTest();
    expect(frames).toHaveLength(0);
    // 第二拍：追加一条完整行 + 一条半行——只广播完整那条
    const seg = '{"type":"assistant","timestamp":"2026-10-27T10:00:05Z","message":{"content":[{"type":"text","text":"第二段"}]}}\n';
    const half = '{"type":"assistant","timestamp":"2026-10-27T10:00:06Z","mess';
    writeFileSync(file, seg + half, { flag: 'a' });
    await watcher.pumpForTest();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.segs).toEqual([{ at: '2026-10-27T10:00:05Z', text: '第二段' }]);
    // 第三拍：半行补齐——补齐后的行照常认出
    writeFileSync(file, 'age":{"content":[{"type":"text","text":"第三段"}]}}\n', { flag: 'a' });
    await watcher.pumpForTest();
    expect(frames).toHaveLength(2);
    expect(frames[1]!.segs).toEqual([{ at: '2026-10-27T10:00:06Z', text: '第三段' }]);
  });

  it('路径切换（压缩重建/resume 换文件）→ 游标作废重读、不广播历史', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nwatch-'));
    dirs.push(dir);
    const a = path.join(dir, 'a.jsonl');
    const b = path.join(dir, 'b.jsonl');
    writeFileSync(a, '{"type":"assistant","timestamp":"2026-10-27T10:00:00Z","message":{"content":[{"type":"text","text":"旧文件"}]}}\n');
    writeFileSync(b, '{"type":"assistant","timestamp":"2026-10-27T10:01:00Z","message":{"content":[{"type":"text","text":"新文件"}]}}\n');
    const frames: NarrationUpdatedFrame[] = [];
    const bus = {
      subscribe: (_l: unknown) => () => {},
      emit: (m: unknown) => frames.push(m as NarrationUpdatedFrame),
    } as never;
    let cur = a;
    const watcher = new NarrationWatcher(
      bus,
      () => CLAUDE_NARRATION,
      () => cur,
      () => 'claude',
    );
    await watcher.pumpForTest();
    cur = b;
    await watcher.pumpForTest();
    expect(frames).toHaveLength(0); // 换文件重读不广播历史段
  });

  it('文件被截断（size < offset）→ 游标作废重读', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nwatch-'));
    dirs.push(dir);
    const file = path.join(dir, 't.jsonl');
    writeFileSync(file, 'x'.repeat(100));
    const frames: NarrationUpdatedFrame[] = [];
    const bus = {
      subscribe: (_l: unknown) => () => {},
      emit: (m: unknown) => frames.push(m as NarrationUpdatedFrame),
    } as never;
    const watcher = new NarrationWatcher(
      bus,
      () => CLAUDE_NARRATION,
      () => file,
      () => 'claude',
    );
    await watcher.pumpForTest();
    writeFileSync(file, ''); // 截断
    await watcher.pumpForTest();
    expect(frames).toHaveLength(0);
    expect(statSync(file).size).toBe(0);
  });
});
