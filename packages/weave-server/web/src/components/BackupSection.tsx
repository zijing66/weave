import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArchiveRestore, DatabaseBackup, HardDriveDownload, Loader2, X } from 'lucide-react';
import { api, type BackupStatusBundle } from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { errorText } from '@/lib/action-feedback';
import { useToast } from '@/components/Toast';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { FieldHint } from '@/components/ui/field-hint';
import { NumberStepper } from '@/components/ui/number-stepper';
import { Tooltip } from '@/components/ui/tooltip';

/**
 * 每日自动备份设置段（设置页 data 区之后）：开关/时刻/历史域勾选 + 手动触发 +
 * 包清单（可滚）+ 还原（文字确认弹窗）。备份中的全屏 loading 盖在 App 层
 * （BackupOverlay），这里只管配置面。引擎不在（503）= 整段不渲染（不摆空壳）。
 */

/** 与服务端 RESTORE_CONFIRM_TEXT 一致的确认词（用户须原样输入）。 */
const RESTORE_CONFIRM_TEXT = '恢复备份';

export function BackupSection() {
  const t = useT();
  const { show } = useToast();
  const [bundle, setBundle] = useState<BackupStatusBundle | null>(null);
  const [available, setAvailable] = useState(true);
  const [running, setRunning] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

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
      const r = await api.putBackupSettings({
        ...(s ?? { enabled: true, hour: 1, includeHistory: false, retentionDays: 7 }),
        ...p,
      });
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

  const openRestore = (name: string): void => {
    setRestoreTarget(name);
    setConfirmText('');
    setRestoreError(null);
  };

  const runRestore = async (): Promise<void> => {
    if (!restoreTarget || confirmText.trim() !== RESTORE_CONFIRM_TEXT) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      const r = await api.restoreBackup(restoreTarget, confirmText.trim());
      setRestoreTarget(null);
      // 200 即安全备份已成 + 停机链已启动：daemon 重启时覆写。提示用户等重启。
      show('success', r.restarted ? t('settings.restoreScheduled') : t('settings.restorePendingManual'));
    } catch (e) {
      setRestoreError(errorText(e));
    } finally {
      setRestoring(false);
    }
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

        <label className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-neutral-300">
            {t('settings.backupRetention')}
            <FieldHint>{t('settings.backupRetentionHint')}</FieldHint>
          </span>
          <NumberStepper
            value={s?.retentionDays ?? 7}
            min={1}
            max={365}
            onChange={(v) => void patch({ retentionDays: v })}
            title={t('settings.backupRetention')}
          />
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
              time: stampLabel(st.lastResult.file),
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

      {/* 包清单（新→旧；max-h + 滚动——包攒到 30+ 份时列表会顶爆设置弹窗） */}
      {bundle && bundle.packages.length > 0 && (
        <ul className="max-h-48 space-y-0.5 overflow-y-auto pr-1">
          {bundle.packages.map((pkg) => (
            <li key={pkg.name} className="flex items-center justify-between gap-2 rounded px-1.5 py-0.5 text-10 text-neutral-500 odd:bg-neutral-950/40">
              <span className="truncate font-mono">{pkg.name}</span>
              <span className="flex shrink-0 items-center gap-1.5">
                <span className="tabular-nums">{fmtBytes(pkg.bytes)}</span>
                <button
                  type="button"
                  onClick={() => openRestore(pkg.name)}
                  disabled={running}
                  className="rounded px-1.5 py-0.5 text-10 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-40"
                >
                  {t('settings.restore')}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <RestoreConfirmDialog
        open={restoreTarget !== null}
        packageName={restoreTarget ?? ''}
        confirmText={confirmText}
        onConfirmTextChange={setConfirmText}
        busy={restoring}
        error={restoreError}
        onConfirm={() => void runRestore()}
        onClose={() => setRestoreTarget(null)}
      />
    </section>
  );
}

/**
 * 还原确认弹窗：二次提醒 + 文字确认（须原样输入「恢复备份」，确认词旁给一键
 * 复制——防手打错字挡住真想还原的人）。说明覆盖范围与「重启后生效」的时序。
 */
function RestoreConfirmDialog(props: {
  open: boolean;
  packageName: string;
  confirmText: string;
  onConfirmTextChange: (v: string) => void;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useT();
  if (!props.open) return null;
  const confirmed = props.confirmText.trim() === RESTORE_CONFIRM_TEXT;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 lg:p-6">
      <div className="absolute inset-0 bg-black/60" onClick={props.onClose} />
      <div className="relative w-[420px] max-w-full rounded-2xl border border-edge/[0.08] bg-neutral-900 shadow-mac overflow-hidden flex flex-col">
        <header className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-edge/[0.06] frosted">
          <ArchiveRestore className="h-4 w-4 text-amber-400" />
          <span className="text-sm font-semibold text-neutral-200">{t('settings.restoreTitle')}</span>
          <Tooltip label={t('common.close')} className="ml-auto">
            <button
              onClick={props.onClose}
              className="p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800"
            >
              <X className="h-4 w-4" />
            </button>
          </Tooltip>
        </header>
        <div className="px-4 py-4 space-y-3">
          <p className="text-xs leading-relaxed text-neutral-400">{t('settings.restoreWarning')}</p>
          <p className="truncate rounded bg-neutral-950 border border-edge/[0.06] px-2 py-1 font-mono text-11 text-neutral-300">
            {props.packageName}
          </p>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-11 text-neutral-500">{t('settings.restoreConfirmLabel')}</span>
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(RESTORE_CONFIRM_TEXT)}
                className="rounded px-1.5 py-0.5 text-10 text-blue-300 hover:bg-blue-500/10"
              >
                {t('settings.restoreCopyWord')}
              </button>
            </div>
            <Input
              type="text"
              value={props.confirmText}
              onChange={(e) => props.onConfirmTextChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && confirmed && !props.busy) props.onConfirm();
              }}
              autoFocus
              spellCheck={false}
              placeholder={RESTORE_CONFIRM_TEXT}
              className="min-w-0 w-full cursor-text rounded-lg bg-neutral-800 border border-edge/[0.08] px-2.5 py-1.5 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          {props.error && <p className="text-11 text-red-400">{props.error}</p>}
        </div>
        <footer className="shrink-0 border-t border-edge/[0.06] px-4 py-2.5 flex items-center justify-end gap-2 frosted">
          <button
            onClick={props.onClose}
            className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={props.onConfirm}
            disabled={!confirmed || props.busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs text-white hover:bg-red-500 disabled:opacity-40"
          >
            {props.busy && <Loader2 className="h-3 w-3 animate-spin" />}
            {t('settings.restoreGo')}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/** 包名时刻戳（`weave-backup-YYYY-MM-DD-HH-MM-SS.tar.gz`，旧形 HHmmss 也认）→ 本地时刻；认不出回包名原文。 */
function stampLabel(file: string): string {
  const m = file.match(/-(\d{4})-(\d{2})-(\d{2})-(\d{2})-?(\d{2})-?(\d{2})\.tar\.gz$/);
  if (!m) return file;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Number(y), Number(mo)! - 1, Number(d), Number(h), Number(mi), Number(s)).toLocaleString();
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}
