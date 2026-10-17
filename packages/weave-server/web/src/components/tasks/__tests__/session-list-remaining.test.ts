import { describe, it, expect } from 'vitest';
import type { SessionRow } from '@/lib/api';
import { zh } from '@/i18n/dict';
import { makeT } from '@/i18n/t';
import { lastSeenLabel, remainingLabel, remainingMsOf } from '../SessionList';

const t = makeT(zh, zh);

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const row = (over: Partial<SessionRow>): SessionRow => ({
  sessionId: 's',
  projectId: 1,
  title: null,
  pendingTitle: null,
  lastSeenAt: '2026-10-17T00:00:00.000Z',
  createdAt: '2026-10-17T00:00:00.000Z',
  ...over,
});

const at = (iso: string) => Date.parse(iso);

/**
 * 剩余存活倒计时口径：剩余 = 期限 − 现在，但「现在」落后于刚写入的 lastSeenAt
 * 时封顶到本行自己的窗——否则新行首帧把整窗算多一截（90 天显示成 91、1 小时
 * 显示成 2 小时），下一拍 tick 到位又掉回名义值（「马上就变成一个小时」）。
 */

describe('remainingMsOf（剩余存活）', () => {
  it('now 落后于刚写入的 lastSeenAt：封顶到整窗，不把陈旧 tick 算进去', () => {
    const s = row({
      lastSeenAt: '2026-10-17T00:00:00.000Z',
      autoDeleteAt: '2026-10-17T01:00:00.000Z',
    });
    // now 比 lastSeenAt 早 30s（30s tick 没跟上新行）——剩余应恰为 1 小时
    expect(remainingMsOf(s, at('2026-09-17T23:59:30.000Z'))).toBe(HOUR);
  });

  it('now 在 lastSeenAt 之后：窗 − 已过', () => {
    const s = row({
      lastSeenAt: '2026-10-17T00:00:00.000Z',
      autoDeleteAt: '2026-10-17T01:00:00.000Z',
    });
    expect(remainingMsOf(s, at('2026-10-17T00:00:05.000Z'))).toBe(HOUR - 5_000);
  });

  it('无期限的行不算剩余', () => {
    expect(remainingMsOf(row({ autoDeleteAt: null }), Date.now())).toBe(0);
  });
});

describe('remainingLabel（倒计时文案）', () => {
  it('整窗首帧就是名义值：90 天 / 1 小时', () => {
    expect(remainingLabel(t, 90 * DAY)).toBe('90 天后自动移除');
    expect(remainingLabel(t, HOUR)).toBe('1 小时后自动移除');
  });

  it('同量不换档：1 小时不跳「60 分钟」、1 天不跳「24 小时」', () => {
    expect(remainingLabel(t, HOUR - 5_000)).toBe('1 小时后自动移除');
    expect(remainingLabel(t, 59 * MIN)).toBe('59 分钟后自动移除');
    expect(remainingLabel(t, DAY - MIN)).toBe('1 天后自动移除');
    expect(remainingLabel(t, 23 * HOUR)).toBe('23 小时后自动移除');
  });

  it('不足一分钟即「即将自动移除」；已过期同档', () => {
    expect(remainingLabel(t, 60_000)).toBe('1 分钟后自动移除');
    expect(remainingLabel(t, 59_000)).toBe('即将自动移除');
    expect(remainingLabel(t, 30_000)).toBe('即将自动移除');
    expect(remainingLabel(t, -1)).toBe('即将自动移除');
  });
});

describe('lastSeenLabel', () => {
  // 固定「现在」= 本地 2026-10-15 14:30，跨天档才可断言。
  const NOW = new Date(2026, 9, 15, 14, 30).getTime();
  const iso = (...args: [number, number, number, number?, number?]): string =>
    new Date(...args).toISOString();

  it('当天只给时刻', () => {
    expect(lastSeenLabel(t, iso(2026, 9, 15, 9, 5), NOW)).toBe(
      new Date(2026, 9, 15, 9, 5).toLocaleTimeString(),
    );
  });

  it('昨天标「昨天」', () => {
    expect(lastSeenLabel(t, iso(2026, 9, 14, 23, 50), NOW)).toBe('昨天');
  });

  it('更早补日期（同年不带年份）', () => {
    expect(lastSeenLabel(t, iso(2026, 9, 10), NOW)).toBe('10/10');
  });

  it('往年带年份', () => {
    expect(lastSeenLabel(t, iso(2025, 11, 30), NOW)).toBe('2025/12/30');
  });
});
