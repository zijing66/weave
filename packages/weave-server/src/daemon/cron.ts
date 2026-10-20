/**
 * 5 字段 cron（分 时 日 月 周，本机时区，无秒/无 @macro）。解析器只在 server：
 * web 的 cron 构建器结构上只产出合法表达式，不镜像解析逻辑。
 * 日/周同时受限时按 vixie cron 的 OR 语义（任一命中即算）。
 */

export interface CronSchedule {
  minutes: number[];
  hours: number[];
  doms: number[];
  months: number[];
  dows: number[];
  domAny: boolean;
  dowAny: boolean;
}

const FIELDS: Array<{ min: number; max: number }> = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7 },
];

export function parseCron(expr: string): CronSchedule | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets: number[][] = [];
  for (let i = 0; i < 5; i++) {
    const set = parseField(parts[i]!, FIELDS[i]!.min, FIELDS[i]!.max);
    if (!set) return null;
    sets.push(set);
  }
  const dows = [...new Set(sets[4]!.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);
  return {
    minutes: sets[0]!,
    hours: sets[1]!,
    doms: sets[2]!,
    months: sets[3]!,
    dows,
    domAny: parts[2] === '*',
    dowAny: parts[4] === '*',
  };
}

function parseField(text: string, min: number, max: number): number[] | null {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const [rangeText, stepText] = part.split('/');
    if (rangeText === undefined) return null;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1 || step > max) return null;
    let from: number;
    let to: number;
    if (rangeText === '*') {
      from = min;
      to = max;
    } else if (rangeText.includes('-')) {
      const [a, b] = rangeText.split('-');
      from = Number(a);
      to = Number(b);
    } else {
      from = Number(rangeText);
      to = stepText === undefined ? from : max;
    }
    if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
    if (from < min || to > max || from > to) return null;
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out.size === 0 ? null : [...out].sort((a, b) => a - b);
}

function dayMatches(s: CronSchedule, at: Date): boolean {
  const domOk = s.doms.includes(at.getDate());
  const dowOk = s.dows.includes(at.getDay());
  if (s.domAny && s.dowAny) return true;
  if (s.domAny) return dowOk;
  if (s.dowAny) return domOk;
  return domOk || dowOk;
}

export function matchesMinute(s: CronSchedule, at: Date): boolean {
  return (
    s.minutes.includes(at.getMinutes()) &&
    s.hours.includes(at.getHours()) &&
    s.months.includes(at.getMonth() + 1) &&
    dayMatches(s, at)
  );
}

/** 下一次触发时刻（ISO）；一年内无解（如 2 月 30 日）→ null。 */
export function nextRunAt(s: CronSchedule, from: Date = new Date()): string | null {
  const at = new Date(from.getTime());
  at.setSeconds(0, 0);
  at.setMinutes(at.getMinutes() + 1);
  const limit = new Date(from.getTime() + 366 * 86_400_000);
  while (at <= limit) {
    if (!s.months.includes(at.getMonth() + 1)) {
      at.setMonth(at.getMonth() + 1, 1);
      at.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(s, at)) {
      at.setDate(at.getDate() + 1);
      at.setHours(0, 0, 0, 0);
      continue;
    }
    if (!s.hours.includes(at.getHours())) {
      at.setHours(at.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!s.minutes.includes(at.getMinutes())) {
      at.setMinutes(at.getMinutes() + 1, 0, 0);
      continue;
    }
    return at.toISOString();
  }
  return null;
}

/** 去重键：本地分钟（`last_cron_at` 落它，同一分钟只 fire 一次）。 */
export function minuteKey(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
