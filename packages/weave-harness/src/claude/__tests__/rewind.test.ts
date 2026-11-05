import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_REWIND, stepRewind, type RewindState } from '../rewind.js';

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

/** 一条普通 prompt：宿主自己的轮次计数是回退的唯一痕迹。 */
const prompt = (text: string, ts: string, promptIndex: number) => ({
  type: 'user',
  isSidechain: false,
  parentUuid: 'prev',
  turnPosition: { promptIndex, turnIndex: promptIndex },
  message: { role: 'user', content: text },
  timestamp: ts,
});

const at = (h: number) => `2026-11-04T0${h}:00:00.000Z`;

/** 一轮收尾笔（宿主正常收尾；被打断时是中断行）。 */
const turnDone = (ts: string) => ({ type: 'system', subtype: 'turn_duration', timestamp: ts });

describe('stepRewind', () => {
  const fresh = (): RewindState => ({ turns: [], prevP: null, turnEnded: false, marks: [] });

  it('正常递增（回退不存在）→ 无标记', () => {
    const s = fresh();
    stepRewind(s, JSON.stringify(prompt('a', at(1), 1)));
    stepRewind(s, JSON.stringify(prompt('b', at(2), 2)));
    stepRewind(s, JSON.stringify(prompt('c', at(3), 3)));
    expect(s.marks).toEqual([]);
  });

  it('退回最后一轮重发（计数相等 + 上一轮已收尾）→ 回退', () => {
    const s = fresh();
    stepRewind(s, JSON.stringify(prompt('a', at(1), 1)));
    stepRewind(s, JSON.stringify(turnDone(at(1))));
    stepRewind(s, JSON.stringify(prompt('b', at(2), 2)));
    stepRewind(s, JSON.stringify(turnDone(at(2))));
    stepRewind(s, JSON.stringify(prompt('b2', at(5), 2)));
    expect(s.marks).toEqual([{ at: at(5), boundaryAt: at(2) }]);
  });

  it('被打断的一轮同样算收尾（中断行）', () => {
    const s = fresh();
    stepRewind(s, JSON.stringify(prompt('a', at(1), 1)));
    stepRewind(s, JSON.stringify({ type: 'user', message: { content: '[Request interrupted by user]' }, timestamp: at(1) }));
    stepRewind(s, JSON.stringify(prompt('a2', at(4), 1)));
    expect(s.marks).toEqual([{ at: at(4), boundaryAt: at(1) }]);
  });

  it('weave / 别的会话注入的消息复用计数，不当作回退', () => {
    const s = fresh();
    stepRewind(s, JSON.stringify(prompt('a', at(1), 1)));
    stepRewind(s, JSON.stringify(turnDone(at(1))));
    stepRewind(s, JSON.stringify(prompt('[weave message] from=dashboard', at(2), 1)));
    stepRewind(s, JSON.stringify(turnDone(at(2))));
    stepRewind(s, JSON.stringify(prompt('a', at(3), 2)));
    expect(s.marks).toEqual([]);
  });

  it('同一轮里连发多条（计数相等）不算回退', () => {
    const s = fresh();
    stepRewind(s, JSON.stringify(prompt('a', at(1), 1)));
    stepRewind(s, JSON.stringify(prompt('b', at(2), 2)));
    stepRewind(s, JSON.stringify(prompt('b2', at(3), 2)));
    stepRewind(s, JSON.stringify(prompt('c', at(4), 3)));
    expect(s.marks).toEqual([]);
  });

  it('退到第一条之前：整段旧对话被退掉（boundaryAt = 第一条 prompt）', () => {
    const s = fresh();
    stepRewind(s, JSON.stringify(prompt('a', at(1), 1)));
    stepRewind(s, JSON.stringify(prompt('b', at(2), 2)));
    stepRewind(s, JSON.stringify(prompt('a', at(5), 1)));
    expect(s.marks).toEqual([{ at: at(5), boundaryAt: at(1) }]);
  });

  it('退到中间（p=3 → p=2）：boundaryAt = 旧状态第 2 轮，之后计数继续', () => {
    const s = fresh();
    stepRewind(s, JSON.stringify(prompt('a', at(1), 1)));
    stepRewind(s, JSON.stringify(prompt('b', at(2), 2)));
    stepRewind(s, JSON.stringify(prompt('c', at(3), 3)));
    stepRewind(s, JSON.stringify(prompt('b2', at(6), 2)));
    stepRewind(s, JSON.stringify(prompt('c2', at(7), 3)));
    expect(s.marks).toEqual([{ at: at(6), boundaryAt: at(2) }]);
  });

  it('压缩续跑的合成 prompt（计数重排）不当作回退', () => {
    const s = fresh();
    stepRewind(s, JSON.stringify(prompt('a', at(1), 1)));
    stepRewind(s, JSON.stringify(prompt('b', at(2), 2)));
    stepRewind(
      s,
      JSON.stringify(prompt('This session is being continued from a previous conversation: …', at(3), 1)),
    );
    expect(s.marks).toEqual([]);
  });

  it('没有 turnPosition 的行（工具结果、system、中断）一律跳过', () => {
    const s = fresh();
    stepRewind(s, JSON.stringify(prompt('a', at(1), 1)));
    stepRewind(s, JSON.stringify({ type: 'user', message: { content: '[Request interrupted by user]' }, timestamp: at(2) }));
    stepRewind(s, JSON.stringify({ type: 'user', isSidechain: true, turnPosition: { promptIndex: 1 }, timestamp: at(3) }));
    expect(s.marks).toEqual([]);
  });
});

describe('CLAUDE_REWIND.sessionRewinds', () => {
  it('增量读：第二次读只吃到新行，marks 不重复累积', async () => {
    const path = write([prompt('a', at(1), 1), prompt('b', at(2), 2)]);
    expect(await CLAUDE_REWIND.sessionRewinds({ sessionId: 's', transcriptPath: path })).toEqual([]);

    appendFileSync(path, JSON.stringify(prompt('a', at(5), 1)) + '\n');
    expect(await CLAUDE_REWIND.sessionRewinds({ sessionId: 's', transcriptPath: path })).toEqual([
      { at: at(5), boundaryAt: at(1) },
    ]);
    expect(await CLAUDE_REWIND.sessionRewinds({ sessionId: 's', transcriptPath: path })).toEqual([
      { at: at(5), boundaryAt: at(1) },
    ]);
  });

  it('多次回退各成一条（时间序）', async () => {
    const path = write([
      prompt('a', at(1), 1),
      prompt('b', at(2), 2),
      prompt('a2', at(5), 1),
      prompt('b2', at(6), 2),
      prompt('a3', at(8), 1),
    ]);
    expect(await CLAUDE_REWIND.sessionRewinds({ sessionId: 's', transcriptPath: path })).toEqual([
      { at: at(5), boundaryAt: at(1) },
      { at: at(8), boundaryAt: at(5) },
    ]);
  });

  it('路径未知 / 读不到 → null（不猜）', async () => {
    expect(await CLAUDE_REWIND.sessionRewinds({ sessionId: 's', transcriptPath: null })).toBeNull();
    expect(
      await CLAUDE_REWIND.sessionRewinds({ sessionId: 's', transcriptPath: join(dir, 'nope.jsonl') }),
    ).toBeNull();
  });
});
