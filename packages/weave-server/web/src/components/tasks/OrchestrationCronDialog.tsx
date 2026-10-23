import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useT } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/dict';
import { cn } from '@/lib/utils';
import {
  cronFieldsFor,
  toCronExpression,
  type CronFields,
  type CronMode,
} from '@/lib/cron-build';

/**
 * 定时触发的可视化构造：选一种形态（每 N 分钟 / 每小时 / 每天 / 每周 / 每月）
 * 出 5 字段 cron；自定义则原样交服务端的 `parseCron` 判对错——这里只挡「不是
 * 5 段」这种显然填错的。
 */

const MODES: { id: CronMode; label: MessageKey }[] = [
  { id: 'minutes', label: 'orch.cronModeMinutes' },
  { id: 'hourly', label: 'orch.cronModeHourly' },
  { id: 'daily', label: 'orch.cronModeDaily' },
  { id: 'weekly', label: 'orch.cronModeWeekly' },
  { id: 'monthly', label: 'orch.cronModeMonthly' },
  { id: 'custom', label: 'orch.cronModeCustom' },
];

const DOWS: { id: number; label: MessageKey }[] = [
  { id: 0, label: 'orch.dowSun' },
  { id: 1, label: 'orch.dowMon' },
  { id: 2, label: 'orch.dowTue' },
  { id: 3, label: 'orch.dowWed' },
  { id: 4, label: 'orch.dowThu' },
  { id: 5, label: 'orch.dowFri' },
  { id: 6, label: 'orch.dowSat' },
];

/** 数字输入（空串按 0 处理，出表达式时由 `toCronExpression` 夹到合法区间）。 */
function Num({
  value,
  min,
  max,
  label,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  label: string;
  onChange: (n: number) => void;
}) {
  return (
    <label className="flex shrink-0 items-center gap-1 text-11 text-neutral-400">
      <span className="sr-only">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        aria-label={label}
        title={label}
        onChange={(e) => onChange(Number.parseInt(e.target.value, 10) || 0)}
        className="w-14 rounded border border-edge/[0.1] bg-neutral-950 px-1.5 py-1 text-xs text-neutral-100 focus:border-blue-500/40 focus:outline-none"
      />
    </label>
  );
}

export function OrchestrationCronDialog({
  expr,
  nextRunAt,
  onApply,
  onClear,
  onClose,
}: {
  /** 当前表达式（null = 不启用）。 */
  expr: string | null;
  /** 服务端算的下次触发时刻（只读提示）。 */
  nextRunAt: string | null;
  onApply: (expression: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [fields, setFields] = useState<CronFields>(() => cronFieldsFor(expr));
  const patch = (next: Partial<CronFields>): void => setFields((prev) => ({ ...prev, ...next }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const expression = toCronExpression(fields);
  const valid = fields.mode !== 'custom' || expression.split(/\s+/).length === 5;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-edge/[0.08] bg-neutral-900 p-3 shadow-mac"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 pb-2">
          <p className="min-w-0 truncate text-xs font-medium text-neutral-200">
            {t('orch.cronTitle')}
          </p>
          <button
            type="button"
            title={t('common.close')}
            aria-label={t('common.close')}
            onClick={onClose}
            className="rounded p-0.5 text-neutral-500 hover:text-neutral-200"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex flex-wrap gap-1 pb-2">
          {MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              onClick={() => patch({ mode: mode.id })}
              className={cn(
                'rounded-md border px-2 py-1 text-11 transition-colors',
                fields.mode === mode.id
                  ? 'border-teal-400/40 bg-teal-500/10 text-teal-200'
                  : 'border-edge/[0.08] text-neutral-400 hover:bg-edge/[0.06]',
              )}
            >
              {t(mode.label)}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 pb-2">
          {fields.mode === 'minutes' && (
            <>
              <span className="text-11 text-neutral-400">{t('orch.cronEvery')}</span>
              <Num
                value={fields.everyMinutes}
                min={1}
                max={59}
                label={t('orch.cronMinute')}
                onChange={(everyMinutes) => patch({ everyMinutes })}
              />
              <span className="text-11 text-neutral-400">{t('orch.cronMinutesUnit')}</span>
            </>
          )}
          {fields.mode === 'hourly' && (
            <>
              <span className="text-11 text-neutral-400">{t('orch.cronAt')}</span>
              <Num
                value={fields.minute}
                min={0}
                max={59}
                label={t('orch.cronMinute')}
                onChange={(minute) => patch({ minute })}
              />
              <span className="text-11 text-neutral-400">:00</span>
            </>
          )}
          {fields.mode === 'custom' && (
            <input
              value={fields.custom}
              onChange={(e) => patch({ custom: e.target.value })}
              placeholder="*/30 * * * *"
              className="w-full rounded border border-edge/[0.1] bg-neutral-950 px-2 py-1 font-mono text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
            />
          )}
          {(fields.mode === 'daily' ||
            fields.mode === 'weekly' ||
            fields.mode === 'monthly') && (
            <>
              {fields.mode === 'monthly' && (
                <>
                  <span className="text-11 text-neutral-400">{t('orch.cronDom')}</span>
                  <Num
                    value={fields.dom}
                    min={1}
                    max={31}
                    label={t('orch.cronDom')}
                    onChange={(dom) => patch({ dom })}
                  />
                </>
              )}
              <span className="text-11 text-neutral-400">{t('orch.cronAt')}</span>
              <Num
                value={fields.hour}
                min={0}
                max={23}
                label={t('orch.cronHour')}
                onChange={(hour) => patch({ hour })}
              />
              <span className="text-11 text-neutral-400">:</span>
              <Num
                value={fields.minute}
                min={0}
                max={59}
                label={t('orch.cronMinute')}
                onChange={(minute) => patch({ minute })}
              />
            </>
          )}
        </div>

        {fields.mode === 'weekly' && (
          <div className="flex flex-wrap gap-1 pb-2">
            {DOWS.map((dow) => {
              const on = fields.weekdays.includes(dow.id);
              return (
                <button
                  key={dow.id}
                  type="button"
                  title={t(dow.label)}
                  aria-pressed={on}
                  onClick={() =>
                    patch({
                      weekdays: on
                        ? fields.weekdays.filter((d) => d !== dow.id)
                        : [...fields.weekdays, dow.id],
                    })
                  }
                  className={cn(
                    'h-6 w-6 rounded-full border text-11 transition-colors',
                    on
                      ? 'border-teal-400/50 bg-teal-500/15 text-teal-200'
                      : 'border-edge/[0.1] text-neutral-500 hover:text-neutral-200',
                  )}
                >
                  {t(dow.label)}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-2 border-t border-edge/[0.06] pt-2">
          <code className="min-w-0 flex-1 truncate font-mono text-11 text-neutral-400">
            {expression || '—'}
          </code>
          {nextRunAt && (
            <span className="shrink-0 text-10 text-neutral-600">
              {t('orch.cronNext', { time: new Date(nextRunAt).toLocaleString() })}
            </span>
          )}
        </div>
        {!valid && <p className="pt-1 text-10 text-amber-400/80">{t('orch.cronInvalid')}</p>}

        <div className="flex items-center justify-end gap-2 pt-2.5">
          {expr && (
            <button
              type="button"
              onClick={onClear}
              className="rounded-md border border-edge/[0.1] px-2 py-1 text-11 text-neutral-300 transition-colors hover:bg-edge/[0.06]"
            >
              {t('orch.cronClear')}
            </button>
          )}
          <button
            type="button"
            disabled={!valid || expression.trim() === ''}
            onClick={() => onApply(expression)}
            className="rounded-md bg-teal-700/80 px-2.5 py-1 text-11 font-medium text-white transition-colors hover:bg-teal-600 disabled:opacity-40"
          >
            {t('orch.cronApply')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
