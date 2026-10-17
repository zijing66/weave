import { describe, it, expect } from 'vitest';
import { currentModeAt, currentModelAt, interruptMarkerAt } from '../transcript.js';

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
