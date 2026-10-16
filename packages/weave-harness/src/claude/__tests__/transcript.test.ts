import { describe, it, expect } from 'vitest';
import { interruptMarkerAt } from '../transcript.js';

const line = (o: unknown): string => JSON.stringify(o);

const marker = (ts: string, text = '[Request interrupted by user]'): string =>
  line({
    type: 'user',
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });

describe('interruptMarkerAt', () => {
  it('取最后一条标记的时刻', () => {
    const tail = [
      line({ type: 'assistant', timestamp: '2026-10-16T03:00:00.000Z' }),
      marker('2026-10-16T03:03:30.157Z'),
      line({ type: 'assistant', timestamp: '2026-10-16T03:04:00.000Z' }),
      marker('2026-10-16T03:05:00.000Z'),
    ].join('\n');
    expect(interruptMarkerAt(tail)).toBe(Date.parse('2026-10-16T03:05:00.000Z'));
  });

  it('工具用中被中断的变体同样算', () => {
    const tail = marker('2026-10-16T03:00:00.000Z', '[Request interrupted by user for tool use]');
    expect(interruptMarkerAt(tail)).toBe(Date.parse('2026-10-16T03:00:00.000Z'));
  });

  it('没有标记、半行、坏行、以及「正文里提到这句话」都不算', () => {
    expect(interruptMarkerAt('')).toBeNull();
    expect(interruptMarkerAt(line({ type: 'assistant', timestamp: '' }))).toBeNull();
    expect(interruptMarkerAt('{"type":"user","timestamp":"2026-10-16T03')).toBeNull();
    expect(
      interruptMarkerAt(
        line({
          type: 'assistant',
          timestamp: '2026-10-16T03:00:00.000Z',
          message: { content: [{ type: 'text', text: '看到 [Request interrupted by user] 就判中断' }] },
        }),
      ),
    ).toBeNull();
    // user 消息里句中出现（不是开头）也不当标记
    expect(
      interruptMarkerAt(
        line({
          type: 'user',
          timestamp: '2026-10-16T03:00:00.000Z',
          message: { content: '问：什么叫 [Request interrupted by user]？' },
        }),
      ),
    ).toBeNull();
  });
});
