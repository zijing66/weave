import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_REWIND, parseRewindLine } from '../rewind.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weave-rewind-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (lines: unknown[]): string => {
  const path = join(dir, 'sess.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
};

/** 会话开头那条（parentUuid:null，不算 rewind）。 */
const firstRoot = (text: string, ts: string) => ({
  type: 'user',
  parentUuid: null,
  message: { role: 'user', content: text },
  timestamp: ts,
});

/** 普通续轮（parentUuid 指向前一行，经 attachment 桥接）。 */
const followUp = (text: string, ts: string, parent: string) => ({
  type: 'user',
  parentUuid: parent,
  message: { role: 'user', content: text },
  timestamp: ts,
});

/** rewind 后的新链根（下一次提交时宿主写；parentUuid:null + 自带 timestamp）。 */
const rewindRoot = (text: string, ts: string) => ({
  type: 'user',
  parentUuid: null,
  message: { role: 'user', content: text },
  timestamp: ts,
});

/** 普通 last-prompt 行（每轮都写，与 rewind 无关——旧文法的干扰项）。 */
const lastPrompt = (prompt: string, leaf: string) => ({
  type: 'last-prompt',
  lastPrompt: prompt,
  leafUuid: leaf,
});

/** explicit last-prompt 行（普通轮也写，不是 rewind 信号——旧文法的干扰项）。 */
const explicitPrompt = () => ({
  type: 'last-prompt',
  leafUuid: '00000000-0000-0000-0000-000000000000',
  explicit: true,
});

describe('parseRewindLine', () => {
  it('只认第 2 条及以后的 parentUuid:null user 行；会话开头那条不算', () => {
    expect(
      parseRewindLine(JSON.stringify(rewindRoot('again', '2026-10-28T02:00:00.000Z')), true),
    ).toEqual({ at: '2026-10-28T02:00:00.000Z', boundaryAt: null });
    expect(parseRewindLine(JSON.stringify(firstRoot('hi', '2026-10-28T01:00:00.000Z')), false)).toBeNull();
  });

  it('斜杠命令展开（command-message 开头）立根但不算 rewind', () => {
    const cmd = {
      type: 'user',
      parentUuid: null,
      message: { role: 'user', content: '<command-message>init</command-message>' },
      timestamp: '2026-10-28T01:30:00.000Z',
    };
    // 命令展开是第一个根：它自己不算 rewind……
    expect(parseRewindLine(JSON.stringify(cmd), false)).toBeNull();
    // ……但它立了根，其后的普通新链根就算 rewind
    expect(
      parseRewindLine(JSON.stringify(rewindRoot('again', '2026-10-28T02:00:00.000Z')), true),
    ).toEqual({ at: '2026-10-28T02:00:00.000Z', boundaryAt: null });
  });

  it('普通续轮（parentUuid 非空）/ 侧链 / 无 timestamp 一律 null', () => {
    expect(
      parseRewindLine(JSON.stringify(followUp('x', '2026-10-28T01:00:00.000Z', 'abc')), true),
    ).toBeNull();
    expect(
      parseRewindLine(JSON.stringify({ type: 'user', parentUuid: null, isSidechain: true, timestamp: 'x' }), true),
    ).toBeNull();
    expect(parseRewindLine(JSON.stringify({ type: 'user', parentUuid: null }), true)).toBeNull();
  });

  it('坏 JSON / 非 user 行一律 null（尾部半行不是标记）', () => {
    expect(parseRewindLine('{"type":"user","pare', true)).toBeNull();
    expect(parseRewindLine(JSON.stringify(explicitPrompt()), true)).toBeNull();
  });
});

describe('CLAUDE_REWIND.sessionRewinds', () => {
  it('rewind 痕迹 = 会话开头之外的新链根；时刻 = 该行自身 timestamp', async () => {
    const path = write([
      firstRoot('hi', '2026-10-28T01:00:00.000Z'),
      { type: 'assistant', timestamp: '2026-10-28T01:00:10.000Z', message: { content: [] } },
      // rewind 确认后下一次提交：explicit LP（干扰项）+ 新链根
      explicitPrompt(),
      lastPrompt('hi', 'deadbeef'),
      rewindRoot('again', '2026-10-28T02:00:00.000Z'),
      followUp('more', '2026-10-28T02:30:00.000Z', 'abc'),
    ]);
    expect(await CLAUDE_REWIND.sessionRewinds({ sessionId: 's', transcriptPath: path })).toEqual([
      { at: '2026-10-28T02:00:00.000Z', boundaryAt: null },
    ]);
  });

  it('多次回退各成一条（时间序）；没有回退 = 空数组', async () => {
    const path = write([
      firstRoot('a', '2026-10-28T01:00:00.000Z'),
      rewindRoot('b', '2026-10-28T02:00:00.000Z'),
      rewindRoot('c', '2026-10-28T03:00:00.000Z'),
    ]);
    expect(await CLAUDE_REWIND.sessionRewinds({ sessionId: 's', transcriptPath: path })).toEqual([
      { at: '2026-10-28T02:00:00.000Z', boundaryAt: null },
      { at: '2026-10-28T03:00:00.000Z', boundaryAt: null },
    ]);

    const plain = write([firstRoot('a', '2026-10-28T01:00:00.000Z'), followUp('b', '2026-10-28T01:01:00.000Z', 'x')]);
    expect(await CLAUDE_REWIND.sessionRewinds({ sessionId: 's', transcriptPath: plain })).toEqual([]);
  });

  it('路径未知 / 读不到 → null（不猜）', async () => {
    expect(await CLAUDE_REWIND.sessionRewinds({ sessionId: 's', transcriptPath: null })).toBeNull();
    expect(
      await CLAUDE_REWIND.sessionRewinds({ sessionId: 's', transcriptPath: join(dir, 'nope.jsonl') }),
    ).toBeNull();
  });
});
