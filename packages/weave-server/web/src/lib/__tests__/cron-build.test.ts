import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CRON_FIELDS,
  cronFieldsFor,
  fromCronExpression,
  toCronExpression,
  type CronFields,
} from '../cron-build';

const fields = (over: Partial<CronFields>): CronFields => ({ ...DEFAULT_CRON_FIELDS, ...over });

describe('cron expression builder', () => {
  it('五种形态出 5 字段表达式', () => {
    expect(toCronExpression(fields({ mode: 'minutes', everyMinutes: 15 }))).toBe('*/15 * * * *');
    expect(toCronExpression(fields({ mode: 'hourly', minute: 5 }))).toBe('5 * * * *');
    expect(toCronExpression(fields({ mode: 'daily', minute: 30, hour: 8 }))).toBe('30 8 * * *');
    expect(
      toCronExpression(fields({ mode: 'weekly', minute: 0, hour: 9, weekdays: [5, 1, 1] })),
    ).toBe('0 9 * * 1,5');
    expect(toCronExpression(fields({ mode: 'monthly', minute: 0, hour: 3, dom: 15 }))).toBe(
      '0 3 15 * *',
    );
    expect(toCronExpression(fields({ mode: 'custom', custom: ' 0 9 * * 1-5 ' }))).toBe(
      '0 9 * * 1-5',
    );
  });

  it('越界值夹到合法范围', () => {
    expect(toCronExpression(fields({ mode: 'daily', minute: 99, hour: 42 }))).toBe('59 23 * * *');
    expect(toCronExpression(fields({ mode: 'minutes', everyMinutes: 0 }))).toBe('*/1 * * * *');
  });

  it('自家形态可反解回表单', () => {
    for (const f of [
      fields({ mode: 'minutes', everyMinutes: 20 }),
      fields({ mode: 'hourly', minute: 5 }),
      fields({ mode: 'daily', minute: 30, hour: 8 }),
      fields({ mode: 'weekly', minute: 0, hour: 9, weekdays: [1, 3] }),
      fields({ mode: 'monthly', minute: 0, hour: 3, dom: 15 }),
    ]) {
      expect(fromCronExpression(toCronExpression(f))).toEqual(f);
    }
  });

  it('认不出的表达式落 custom（原样保留）', () => {
    expect(fromCronExpression('0 9 * * 1-5')).toBeNull();
    expect(fromCronExpression('0 9 1 * *?')).toBeNull();
    expect(cronFieldsFor('0 9 * * 1-5')).toMatchObject({
      mode: 'custom',
      custom: '0 9 * * 1-5',
    });
    expect(cronFieldsFor(null)).toEqual(DEFAULT_CRON_FIELDS);
  });
});
