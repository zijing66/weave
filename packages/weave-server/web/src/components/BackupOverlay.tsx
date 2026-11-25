import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { DatabaseBackup, Loader2 } from 'lucide-react';
import { api, type BackupProgress, type BackupStatus } from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { subscribePush, subscribeSseConnection, sseConnected } from '@/lib/sse';

/**
 * 备份中全屏遮罩（App 层常挂）：备份要写库 + 打大包，期间界面操作的结果可能被
 * 包过期的快照盖掉。进度显示 phase + 百分比 + 剩余估算（ETA 为 null 只摆 spinner，
 * 不编数字）。
 *
 * 状态走服务端 push（`backupStatus` 帧，装配处挂在引擎的 onChange 上），只在挂载
 * 与断线时各拉一次现状——常挂组件不轮询。SSE 断流即散屏（daemon 重启中，不该焊屏）。
 */
export function BackupOverlay() {
  const t = useT();
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let alive = true;
    const apply = (status: BackupStatus): void => {
      setVisible(status.running);
      setProgress(status.progress);
    };
    // 首拍：页面刷新后备份可能已经在跑（push 只在变动时才来）
    api
      .getBackupStatus(true)
      .then((b) => {
        if (alive) apply(b.status);
      })
      .catch(() => {});
    const offPush = subscribePush<{ status: BackupStatus }>('backupStatus', (p) => {
      if (p?.status) apply(p.status);
    });
    const offConn = subscribeSseConnection(() => {
      if (!sseConnected()) setVisible(false);
    });
    return () => {
      alive = false;
      offPush();
      offConn();
    };
  }, []);

  if (!visible) return null;

  return createPortal(
    <div className="fixed inset-0 z-[80] flex flex-col items-center justify-center gap-3 bg-black/70 backdrop-blur-sm" role="status">
      <div className="flex items-center gap-3 rounded-2xl border border-edge/[0.08] bg-neutral-900 px-8 py-6 shadow-mac">
        <DatabaseBackup className="h-5 w-5 text-blue-400" />
        <div className="min-w-44">
          <p className="flex items-center gap-2 text-sm font-medium text-neutral-100">
            <Loader2 className="h-4 w-4 animate-spin text-blue-300" />
            {t('settings.backupOverlayTitle')}
          </p>
          {progress && (
            <p className="mt-1 text-11 text-neutral-500">
              {t(`settings.backupPhase.${progress.phase}` as 'settings.backupPhase.tables')}
              {progress.ratio > 0 && ` · ${Math.round(progress.ratio * 100)}%`}
              {progress.etaSeconds != null &&
                ` · ${t('settings.backupEta', { n: progress.etaSeconds })}`}
            </p>
          )}
          {progress && (
            <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-neutral-800">
              <div
                className="h-full bg-mac-accent transition-all duration-500"
                style={{ width: `${Math.max(2, Math.round(progress.ratio * 100))}%` }}
              />
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
