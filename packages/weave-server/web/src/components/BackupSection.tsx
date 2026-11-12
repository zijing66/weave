import { useCallback, useEffect, useState } from 'react';
import { DatabaseBackup, HardDriveDownload, Loader2 } from 'lucide-react';
import { api, type BackupStatusBundle } from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { errorText } from '@/lib/action-feedback';
import { Switch } from '@/components/ui/switch';
import { FieldHint } from '@/components/ui/field-hint';
import { NumberStepper } from '@/components/ui/number-stepper';
import { Tooltip } from '@/components/ui/tooltip';

/**
 * 每日自动备份设置段（设置页 data 区之后）：开关/时刻/历史域勾选 + 手动触发 +
 * 包清单。备份中的全屏 loading 盖在 App 层（BackupOverlay），这里只管配置面。
 * 引擎不在（503）= 整段不渲染（不摆空壳）。
 */

export function BackupSection() {
  const t = useT();
  const [bundle, setBundle] = useState<BackupStatusBundle | null>(null);
  const [available, setAvailable] = useState(true);
  const [running, setRunning] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const b = await api.getBackupStatus();
      setBundle(b);
      setRunning(b.status.running);
    } catch (e) {
      // 旧 daemon / CLI 装配没有引擎：面板收起，不给死开关
      if (String((e as Error).message ?? '').includes('503')) setAvailable(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 备份进行中轮询进度（1s；完成即刷新清单 + 收 loading）
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [running, refresh]);

  if (!available) return null;

  const s = bundle?.settings;
  const st = bundle?.status;

  const patch = async (p: Partial<NonNullable<typeof s>>): Promise<void> => {
    try {
      const r = await api.putBackupSettings({ ...(s ?? { enabled: true, hour: 1, includeHistory: false }), ...p });
      setBundle((cur) => (cur ? { ...cur, settings: r.settings } : cur));
    } catch (e) {
      console.warn('backup settings failed', errorText(e));
    }
  };

  const run = (): void => {
    setRunning(true);
    api
      .runBackup()
      .then(() => void refresh())
      .catch((e: unknown) => {
        setRunning(false);
        console.warn('backup run failed', errorText(e));
      });
  };

  return (
    <section id="settings-section-backup" data-settings-section="backup" className="scroll-mt-2 space-y-3">
      <div className="flex items-center gap-2">
        <DatabaseBackup className="h-3.5 w-3.5 text-neutral-500" />
        <h3 className="text-xs font-semibold text-neutral-200">{t('settings.backupTitle')}</h3>
      </div>

      <div className="space-y-1.5">
        <label className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-neutral-300">
            {t('settings.backupEnabled')}
            <FieldHint>{t('settings.backupEnabledHint')}</FieldHint>
          </span>
          <Switch checked={s?.enabled ?? true} onChange={(v) => void patch({ enabled: v })} />
        </label>

        <label className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-neutral-300">
            {t('settings.backupHour')}
            <FieldHint>{t('settings.backupHourHint')}</FieldHint>
          </span>
          <span className="flex items-center gap-2">
            <NumberStepper
              value={s?.hour ?? 1}
              min={0}
              max={23}
              onChange={(v) => void patch({ hour: v })}
              title={t('settings.backupHour')}
            />
            <span className="text-11 text-neutral-500">:00</span>
          </span>
        </label>

        <label className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-neutral-300">
            {t('settings.backupHistory')}
            <FieldHint>{t('settings.backupHistoryHint')}</FieldHint>
          </span>
          <Switch checked={s?.includeHistory ?? false} onChange={(v) => void patch({ includeHistory: v })} />
        </label>
      </div>

      {/* 手动触发 + 最近一次结果 */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={run}
          disabled={running}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-2.5 py-1 text-11 text-white hover:bg-blue-500 disabled:opacity-40"
        >
          {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <HardDriveDownload className="h-3 w-3" />}
          {t('settings.backupRunNow')}
        </button>
        {st?.lastResult && !running && (
          <span className="min-w-0 flex-1 truncate text-10 text-neutral-600">
            {t('settings.backupLastRun', {
              time: new Date(st.lastResult.file.match(/-(\d{4}-\d{2}-\d{2}-\d{6})/)?.[1]?.replace(/-(\d{2})-(\d{2})-(\d{2})$/, ' $1:$2:$3') ?? '').toLocaleString(),
              size: fmtBytes(st.lastResult.bytes),
            })}
          </span>
        )}
        {st?.lastError && !running && (
          <Tooltip label={st.lastError}>
            <span className="truncate text-10 text-red-400">{t('settings.backupLastError')}</span>
          </Tooltip>
        )}
      </div>

      {/* 包清单（新→旧，最多摆 7 份；空 = 一份还没有） */}
      {bundle && bundle.packages.length > 0 && (
        <ul className="space-y-0.5">
          {bundle.packages.slice(0, 7).map((pkg) => (
            <li key={pkg.name} className="flex items-center justify-between gap-2 rounded px-1.5 py-0.5 text-10 text-neutral-500 odd:bg-neutral-950/40">
              <span className="truncate font-mono">{pkg.name}</span>
              <span className="shrink-0 tabular-nums">{fmtBytes(pkg.bytes)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}
