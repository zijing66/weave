import { describe, expect, it } from 'vitest';
import { codexInterruptMarkerAt } from '../transcript';

/** 一条 rollout 中断行（实测 0.163：event_msg / turn_aborted，timestamp 在顶层）。 */
const abortLine = (at: string, reason = 'interrupted'): string =>
  JSON.stringify({
    timestamp: at,
    ordinal: 10,
    type: 'event_msg',
    payload: { type: 'turn_aborted', reason, duration_ms: 70_046 },
  });

describe('codexInterruptMarkerAt', () => {
  it('turn_aborted 行的时刻即中断时刻', () => {
    const tail = `${abortLine('2026-10-20T08:38:23.166Z')}\n`;
    expect(codexInterruptMarkerAt(tail)).toBe(Date.parse('2026-10-20T08:38:23.166Z'));
  });

  it('多条取最新', () => {
    const tail = [
      abortLine('2026-10-20T08:38:23.166Z'),
      abortLine('2026-10-20T09:01:00.000Z'),
    ].join('\n');
    expect(codexInterruptMarkerAt(tail)).toBe(Date.parse('2026-10-20T09:01:00.000Z'));
  });

  it('非 turn_aborted 的 event_msg 行不认', () => {
    const tail = `${JSON.stringify({
      timestamp: '2026-10-20T08:38:23.166Z',
      type: 'event_msg',
      payload: { type: 'task_complete', last_agent_message: null },
    })}\n`;
    expect(codexInterruptMarkerAt(tail)).toBeNull();
  });

  it('claude 的 user 条目标记不认（两套格式互不相交）', () => {
    const tail = `${JSON.stringify({
      type: 'user',
      timestamp: '2026-10-20T08:38:23.166Z',
      message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    })}\n`;
    expect(codexInterruptMarkerAt(tail)).toBeNull();
  });

  it('尾部半行 / 坏 JSON / 缺时间戳 → null（不猜）', () => {
    expect(codexInterruptMarkerAt('{"timestamp":"2026-10-20T08:38:2')).toBeNull();
    expect(codexInterruptMarkerAt('{broken\n')).toBeNull();
    expect(codexInterruptMarkerAt(`${JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted' } })}\n`)).toBeNull();
    expect(codexInterruptMarkerAt('')).toBeNull();
  });
});
