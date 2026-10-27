import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_NARRATION } from '../narration.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weave-narration-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (lines: unknown[]): string => {
  const path = join(dir, 'sess.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
  return path;
};

const assistantEntry = (parts: unknown[], ts?: string, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  ...(ts ? { timestamp: ts } : {}),
  message: { id: 'msg_1', content: parts },
  ...extra,
});

const textPart = (t: string) => ({ type: 'text', text: t });
const toolPart = (name: string) => ({ type: 'tool_use', name, input: {} });
const thinkingPart = (t: string) => ({ type: 'thinking', thinking: t });

describe('CLAUDE_NARRATION.sessionNarration', () => {
  it('主链 assistant 的 text 分区按时间序全给（含一轮里的多段输出）', async () => {
    const path = write([
      assistantEntry([textPart('先说结论：改三处。')], '2026-10-27T08:21:03.192Z'),
      assistantEntry([toolPart('Edit')], '2026-10-27T08:21:07.000Z'),
      assistantEntry([textPart('记忆已更新。改造收尾完毕。')], '2026-10-27T08:21:12.464Z'),
    ]);
    const sets = await CLAUDE_NARRATION.sessionNarration({ sessionId: 's', transcriptPath: path });
    expect(sets).toHaveLength(2);
    expect(sets![0]).toEqual({ at: '2026-10-27T08:21:03.192Z', text: '先说结论：改三处。' });
    expect(sets![1]).toEqual({ at: '2026-10-27T08:21:12.464Z', text: '记忆已更新。改造收尾完毕。' });
  });

  it('同一条 assistant 消息拆成相邻多行时各段独立成条（宿主的分行习惯）', async () => {
    const path = write([
      { type: 'assistant', timestamp: '2026-10-27T08:00:00.000Z', message: { id: 'msg_x', content: [textPart('第一段。')] } },
      { type: 'assistant', timestamp: '2026-10-27T08:00:01.000Z', message: { id: 'msg_x', content: [textPart('第二段。')] } },
    ]);
    const sets = await CLAUDE_NARRATION.sessionNarration({ sessionId: 's', transcriptPath: path });
    expect(sets).toHaveLength(2);
  });

  it('thinking 分区与 tool_use 不算正文；纯工具行不产条目', async () => {
    const path = write([
      assistantEntry([thinkingPart('内部推理')], '2026-10-27T08:00:00.000Z'),
      assistantEntry([toolPart('Bash')], '2026-10-27T08:00:01.000Z'),
    ]);
    const sets = await CLAUDE_NARRATION.sessionNarration({ sessionId: 's', transcriptPath: path });
    expect(sets).toEqual([]);
  });

  it('sidechain（子代理）条目不进旁白', async () => {
    const path = write([
      assistantEntry([textPart('主链的话')], '2026-10-27T08:00:00.000Z'),
      assistantEntry([textPart('子代理的话')], '2026-10-27T08:00:01.000Z', { isSidechain: true }),
    ]);
    const sets = await CLAUDE_NARRATION.sessionNarration({ sessionId: 's', transcriptPath: path });
    expect(sets).toHaveLength(1);
    expect(sets![0]!.text).toBe('主链的话');
  });

  it('timestamp 缺失的条目 at=null 原样带出（消费方决定摆不摆）', async () => {
    const path = write([assistantEntry([textPart('没有时刻的一段')])]);
    const sets = await CLAUDE_NARRATION.sessionNarration({ sessionId: 's', transcriptPath: path });
    expect(sets).toEqual([{ at: null, text: '没有时刻的一段' }]);
  });

  it('转录不存在 / 路径 null → null（不猜）', async () => {
    expect(await CLAUDE_NARRATION.sessionNarration({ sessionId: 's', transcriptPath: null })).toBeNull();
    expect(
      await CLAUDE_NARRATION.sessionNarration({ sessionId: 's', transcriptPath: join(dir, 'missing.jsonl') }),
    ).toBeNull();
  });
});
