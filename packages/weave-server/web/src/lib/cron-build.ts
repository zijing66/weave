/**
 * cron 表达式的可视化构造（纯函数，可单测）：五种常用形态出 5 字段表达式，
 * 自定义则原样透传。不做解析器——认得出自家生成的形态（改回来继续可视化），
 * 认不出的一律落 custom，由服务端的 `parseCron` 判对错。
 */

export type CronMode = 'minutes' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom';

export interface CronFields {
  mode: CronMode;
  /** minutes 模式：每 n 分钟（1..59）。 */
  everyMinutes: number;
  /** hourly / daily / weekly / monthly 的分（0..59）。 */
  minute: number;
  /** daily / weekly / monthly 的时（0..23）。 */
  hour: number;
  /** weekly 的星期（0 = 周日，多选；升序输出）。 */
  weekdays: number[];
  /** monthly 的日（1..31）。 */
  dom: number;
  /** custom 的原文。 */
  custom: string;
}

export const DEFAULT_CRON_FIELDS: CronFields = {
  mode: 'daily',
  everyMinutes: 30,
  minute: 0,
  hour: 9,
  weekdays: [1],
  dom: 1,
  custom: '',
};

export function toCronExpression(f: CronFields): string {
  switch (f.mode) {
    case 'minutes':
      return `*/${clamp(f.everyMinutes, 1, 59)} * * * *`;
    case 'hourly':
      return `${clamp(f.minute, 0, 59)} * * * *`;
    case 'daily':
      return `${clamp(f.minute, 0, 59)} ${clamp(f.hour, 0, 23)} * * *`;
    case 'weekly': {
      const days = [...new Set(f.weekdays)].sort((a, b) => a - b);
      const dow = days.length > 0 ? days.map((d) => clamp(d, 0, 6)).join(',') : '1';
      return `${clamp(f.minute, 0, 59)} ${clamp(f.hour, 0, 23)} * * ${dow}`;
    }
    case 'monthly':
      return `${clamp(f.minute, 0, 59)} ${clamp(f.hour, 0, 23)} ${clamp(f.dom, 1, 31)} * *`;
    case 'custom':
      return f.custom.trim();
  }
}

/** 表达式 → 表单态；认不出（含空串）返回 null，调用方自己决定回落到哪一档。 */
export function fromCronExpression(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, month, dow] = parts as [string, string, string, string, string];
  if (month !== '*') return null;

  const everyMinutes = /^\*\/(\d{1,2})$/.exec(min);
  if (everyMinutes && hour === '*' && dom === '*' && dow === '*') {
    return { ...DEFAULT_CRON_FIELDS, mode: 'minutes', everyMinutes: Number(everyMinutes[1]) };
  }
  if (!/^\d{1,2}$/.test(min)) return null;
  const minute = Number(min);
  if (minute > 59) return null;

  if (hour === '*' && dom === '*' && dow === '*') {
    return { ...DEFAULT_CRON_FIELDS, mode: 'hourly', minute };
  }
  if (!/^\d{1,2}$/.test(hour) || Number(hour) > 23) return null;
  const h = Number(hour);

  if (dom === '*' && dow === '*') {
    return { ...DEFAULT_CRON_FIELDS, mode: 'daily', minute, hour: h };
  }
  if (dom === '*' && /^(\d,?)+$/.test(dow)) {
    const weekdays = dow.split(',').map(Number);
    if (weekdays.some((d) => d > 6)) return null;
    return { ...DEFAULT_CRON_FIELDS, mode: 'weekly', minute, hour: h, weekdays };
  }
  if (/^\d{1,2}$/.test(dom) && dow === '*') {
    const day = Number(dom);
    if (day < 1 || day > 31) return null;
    return { ...DEFAULT_CRON_FIELDS, mode: 'monthly', minute, hour: h, dom: day };
  }
  return null;
}

/** 编排表单的初始态：有表达式就试着解读，认不出落 custom。 */
export function cronFieldsFor(expr: string | null): CronFields {
  if (!expr) return DEFAULT_CRON_FIELDS;
  return fromCronExpression(expr) ?? { ...DEFAULT_CRON_FIELDS, mode: 'custom', custom: expr };
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}
