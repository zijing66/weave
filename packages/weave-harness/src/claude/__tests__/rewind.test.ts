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

/** 普通 last-prompt 行（每轮都写，不是回退）。 */
const lastPrompt = (prompt: string, leaf: string) => ({
  type: 'last-prompt',
  lastPrompt: prompt,
  leafUuid: leaf,
});

/** rewind 锚点行（宿主 rewind 后追加；实测四键、无 timestamp）。 */
const rewindAnchor = (leaf: string) => ({
  type: 'last-prompt',
  lastPrompt: '被退掉的那条',
  leafUuid: leaf,
  rewound: true,
});

describe('parseRewindLine', () => {
  it('只认 rewound:true 的锚点；普通 last-prompt 行不算', () => {
    expect(parseRewindLine(JSON.stringify(rewindAnchor('u1')), '2026-10-28T01:00:00.000Z')).toEqual({
      at: '2026-10-28T01:00:00.000Z',
      boundaryAt: null,
    });
    expect(parseRewindLine(JSON.stringify(lastPrompt('hi', 'u1')), '2026-10-28T01:00:00.000Z')).toBeNull();
  });

  it('锚点行自身不带 timestamp：时刻取前面最近一条带 timestamp 行的（调用方喂）', () => {
    expect(parseRewindLine(JSON.stringify(rewindAnchor('u1')), null)).toBeNull();
  });

  it('坏 JSON / 非锚点行一律 null（尾部半行不是标记）', () => {
    expect(parseRewindLine('{"type":"last-prompt","rewo', '2026-10-28T01:00:00.000Z')).toBeNull();
    expect(parseRewindLine('{"type":"custom-title","customTitle":"x"}', '2026-10-28T01:00:00.000Z')).toBeNull();
  });
});

describe('CLAUDE_REWIND.sessionRewinds', () => {
  it('锚点时刻 = 锚点行之前最近一条带 timestamp 行（rewind 只能在最后活动之后）', async () => {
    const path = write([
      { type: 'user', timestamp: '2026-10-28T01:00:00.000Z', message: 'hi' },
      { type: 'assistant', timestamp: '2026-10-28T01:00:10.000Z', message: { content: [] } },
      // 元数据块（锚点行的近邻，都不带 timestamp）
      { type: 'custom-title', customTitle: 'x' },
      { type: 'mode' },
      rewindAnchor('u1'),
      { type: 'user', timestamp: '2026-10-28T01:05:00.000Z', message: 'again' },
    ]);
    expect(await CLAUDE_REWIND.sessionRewinds({ sessionId: 's', transcriptPath: path })).toEqual([
      { at: '2026-10-28T01:00:10.000Z', boundaryAt: null },
    ]);
  });

  it('多次回退各成一条（时间序）；没有回退 = 空数组', async () => {
    const path = write([
      { type: 'user', timestamp: '2026-10-28T01:00:00.000Z', message: 'a' },
      rewindAnchor('u1'),
      { type: 'user', timestamp: '2026-10-28T02:00:00.000Z', message: 'b' },
      rewindAnchor('u2'),
    ]);
    expect(await CLAUDE_REWIND.sessionRewinds({ sessionId: 's', transcriptPath: path })).toEqual([
      { at: '2026-10-28T01:00:00.000Z', boundaryAt: null },
      { at: '2026-10-28T02:00:00.000Z', boundaryAt: null },
    ]);

    const plain = write([lastPrompt('hi', 'u1')]);
    expect(await CLAUDE_REWIND.sessionRewinds({ sessionId: 's', transcriptPath: plain })).toEqual([]);
  });

  it('路径未知 / 读不到 → null（不猜）', async () => {
    expect(await CLAUDE_REWIND.sessionRewinds({ sessionId: 's', transcriptPath: null })).toBeNull();
    expect(
      await CLAUDE_REWIND.sessionRewinds({ sessionId: 's', transcriptPath: join(dir, 'nope.jsonl') }),
    ).toBeNull();
  });
});
