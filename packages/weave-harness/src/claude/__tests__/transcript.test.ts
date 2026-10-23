import { describe, it, expect } from 'vitest';
import {
  currentContextTokensAt,
  currentEffortAt,
  currentModeAt,
  currentModelAt,
  interruptMarkerAt,
} from '../transcript.js';

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

describe('currentModelAt', () => {
  it('取最后一条真跑过的模型；合成行不算', () => {
    const tail = [
      line({ type: 'assistant', message: { model: 'opus' } }),
      line({ type: 'assistant', message: { model: '<synthetic>' } }),
      line({ type: 'assistant', message: { model: 'ftm' } }),
    ].join('\n');
    expect(currentModelAt(tail)).toBe('ftm');
  });

  it('没有模型 / 坏行 / 空串一律 null（不猜）', () => {
    expect(currentModelAt('')).toBeNull();
    expect(currentModelAt(line({ type: 'assistant', message: {} }))).toBeNull();
    expect(currentModelAt('{"type":"assistant","message":{"model":')).toBeNull();
    expect(currentModelAt(line({ type: 'assistant', message: { model: '' } }))).toBeNull();
    // 只有合成行 = 这一段没真跑过模型
    expect(currentModelAt(line({ type: 'assistant', message: { model: '<synthetic>' } }))).toBeNull();
  });
});

describe('currentModeAt', () => {
  it('取最后一条 permissionMode（尾部按时间序，最后一条即最新）', () => {
    const tail = [
      line({ type: 'user', permissionMode: 'default' }),
      line({ type: 'assistant', permissionMode: 'plan' }),
      line({ type: 'user', permissionMode: 'bypassPermissions' }),
    ].join('\n');
    expect(currentModeAt(tail)).toBe('bypassPermissions');
  });

  it('没有该字段 / 坏行 / 非串一律 null（不猜）', () => {
    expect(currentModeAt('')).toBeNull();
    expect(currentModeAt(line({ type: 'user' }))).toBeNull();
    expect(currentModeAt('{"type":"user","permissionMode":')).toBeNull();
    expect(currentModeAt(line({ type: 'user', permissionMode: 3 }))).toBeNull();
    expect(currentModeAt(line({ type: 'user', permissionMode: '' }))).toBeNull();
  });
});

describe('currentEffortAt', () => {
  it('取最后一条顶层 effort 串（尾部按时间序，最后一条即最新）', () => {
    const tail = [
      line({ type: 'assistant', effort: 'low' }),
      line({ type: 'assistant', effort: 'high' }),
      line({ type: 'user' }),
    ].join('\n');
    expect(currentEffortAt(tail)).toBe('high');
  });

  it('工具参数里的 effort 不是事实：只认顶层字符串', () => {
    const tail = [
      line({ type: 'assistant', effort: 'medium' }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', input: { effort: 'max' } }] } }),
    ].join('\n');
    expect(currentEffortAt(tail)).toBe('medium');
  });

  it('没有该字段 / 坏行 / 非串一律 null（不猜）', () => {
    expect(currentEffortAt('')).toBeNull();
    expect(currentEffortAt(line({ type: 'assistant' }))).toBeNull();
    expect(currentEffortAt('{\"broken\":')).toBeNull();
    expect(currentEffortAt(line({ type: 'assistant', effort: { level: 'high' } }))).toBeNull();
  });
});

describe('currentContextTokensAt', () => {
  const usageLine = (usage: Record<string, unknown>): string =>
    line({ type: 'assistant', message: { model: 'ftm', usage } });

  it('取最后一条 assistant 的 usage 四项之和', () => {
    const tail = [
      usageLine({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 3000, cache_creation_input_tokens: 7 }),
      usageLine({ input_tokens: 2222, output_tokens: 4955, cache_read_input_tokens: 378880, cache_creation_input_tokens: 0 }),
    ].join('\n');
    expect(currentContextTokensAt(tail)).toBe(2222 + 4955 + 378880 + 0);
  });

  it('缺项按 0 计（cache_creation 常缺省）', () => {
    expect(currentContextTokensAt(usageLine({ input_tokens: 100, output_tokens: 5 }))).toBe(105);
  });

  it('没有 usage 的行跳过；全无 usage → null（不猜）', () => {
    const tail = [
      line({ type: 'assistant', message: { model: 'ftm' } }),
      line({ type: 'user', message: { content: 'hi' } }),
    ].join('\n');
    expect(currentContextTokensAt(tail)).toBeNull();
    expect(currentContextTokensAt('')).toBeNull();
    expect(currentContextTokensAt('{"type":"assistant","message":{"usage":')).toBeNull();
  });

  it('全零 usage 不算事实（合成/空轮）', () => {
    expect(currentContextTokensAt(usageLine({ input_tokens: 0, output_tokens: 0 }))).toBeNull();
  });
});
