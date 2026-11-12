import { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { DatabaseBackup, Loader2 } from 'lucide-react';
import { api, type BackupProgress } from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';

/**
 * 备份中全屏遮罩（App 层常挂）：轮询 /backup/status，running 即盖全屏——
 * 备份要写库 + 打大包，期间界面操作的结果可能被包过期的快照盖掉。进度
 * 显示 phase + 百分比 + 剩余估算（ETA 为 null 只摆 spinner，不编数字）。
 * 完成/出错即散；轮询失败连续多拍也散（daemon 重启中，不该焊屏）。
 */

const POLL_MS = 1000;
const MAX_POLL_FAILURES = 5;

export function BackupOverlay() {
  const t = useT();
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [visible, setVisible] = useState(false);
  const failures = useRefCount();

  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      try {
        const b = await api.getBackupStatus();
        if (!alive) return;
        failures.reset();
        setVisible(b.status.running);
        setProgress(b.status.progress);
      } catch {
        if (!alive) return;
        if (visible && failures.bump() >= MAX_POLL_FAILURES) setVisible(false);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [visible]);

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

/** 连续失败计数（组件内小状态；重挂即清零）。 */
function useRefCount(): { bump(): number; reset(): void } {
  const ref = useRef({ n: 0 });
  return {
    bump: () => ++ref.current.n,
    reset: () => {
      ref.current.n = 0;
    },
  };
}
