import { describe, expect, it } from 'vitest';
import { matchesMinute, minuteKey, nextRunAt, parseCron } from '../cron.js';

function at(text: string): Date {
  return new Date(text);
}

describe('parseCron', () => {
  it('非法表达式一律 null', () => {
    expect(parseCron('')).toBeNull();
    expect(parseCron('* * * *')).toBeNull();
    expect(parseCron('60 * * * *')).toBeNull();
    expect(parseCron('* * * * 9')).toBeNull();
    expect(parseCron('a * * * *')).toBeNull();
    expect(parseCron('*/0 * * * *')).toBeNull();
  });

  it('列表 / 区间 / 步进 / 周日的 7 归一成 0', () => {
    expect(parseCron('0,30 * * * *')?.minutes).toEqual([0, 30]);
    expect(parseCron('*/15 * * * *')?.minutes).toEqual([0, 15, 30, 45]);
    expect(parseCron('0 9-11 * * *')?.hours).toEqual([9, 10, 11]);
    expect(parseCron('0 0 * * 7')?.dows).toEqual([0]);
    expect(parseCron('0 0 * * 1-5')?.dows).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('matchesMinute', () => {
  it('分/时/日/月逐项命中', () => {
    const s = parseCron('30 9 * * *')!;
    expect(matchesMinute(s, at('2026-03-05T09:30:00'))).toBe(true);
    expect(matchesMinute(s, at('2026-03-05T09:31:00'))).toBe(false);
  });

  it('日与周同时受限 = OR 语义', () => {
    const s = parseCron('0 0 1 * 1')!;
    expect(matchesMinute(s, at('2026-03-01T00:00:00'))).toBe(true); // 1 号（也是周日）
    expect(matchesMinute(s, at('2026-03-02T00:00:00'))).toBe(true); // 周一
    expect(matchesMinute(s, at('2026-03-03T00:00:00'))).toBe(false); // 周二、非 1 号
  });
});

describe('nextRunAt', () => {
  it('同一分钟内跳过当前分钟', () => {
    const s = parseCron('* * * * *')!;
    expect(nextRunAt(s, at('2026-03-05T09:30:20'))).toBe(at('2026-03-05T09:31:00').toISOString());
  });

  it('逐日 / 逐月边界', () => {
    const daily = parseCron('0 9 * * *')!;
    expect(nextRunAt(daily, at('2026-03-05T10:00:00'))).toBe(
      at('2026-03-06T09:00:00').toISOString(),
    );
    const monthly = parseCron('0 0 1 * *')!;
    expect(nextRunAt(monthly, at('2026-01-15T00:00:00'))).toBe(
      at('2026-02-01T00:00:00').toISOString(),
    );
  });

  it('一年内无解 → null（2 月 30 日）', () => {
    expect(nextRunAt(parseCron('0 0 30 2 *')!, at('2026-01-01T00:00:00'))).toBeNull();
  });
});

describe('minuteKey', () => {
  it('本地分钟、零填充', () => {
    expect(minuteKey(at('2026-03-05T09:05:59'))).toBe('2026-03-05T09:05');
  });
});
