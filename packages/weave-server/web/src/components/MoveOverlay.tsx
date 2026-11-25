import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderInput, Loader2, X } from 'lucide-react';
import { api, type MoveStatus } from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { errorText } from '@/lib/action-feedback';
import { useToast } from '@/components/Toast';
import { subscribePush, subscribeSseConnection, sseConnected } from '@/lib/sse';

/**
 * 迁移中全屏遮罩（App 层常挂）：状态走服务端 push（`moveStatus` 帧，装配处挂在
 * 引擎的 onChange 上），只在挂载与断线时各拉一次现状——常挂组件不轮询。
 *
 * 可退出三层（用户裁决「绝不允许卡死 loading」）：
 * ① 「取消迁移」按钮 → cancel API，等 running 落 false 自然散；
 * ② SSE 断流即散屏（daemon 重启中不焊屏）；
 * ③ 进度看门狗——ratio 60s 无变化自动散屏（引擎假死兜底；纯本地计时，不发请求）。
 * done → toast 成功 + 弹「删除旧目录？」确认（用户点了才删，关掉即留）；
 * lastError → toast 错误散屏（项目行原样，可重试）。
 */

/** 看门狗：progress.ratio 连续这么久没动 = 引擎假死，散屏。 */
const STALL_MS = 60_000;
const WATCHDOG_MS = 5_000;

export function MoveOverlay({ onSettled }: { onSettled?: (status: MoveStatus) => void }) {
  const t = useT();
  const { show } = useToast();
  const [status, setStatus] = useState<MoveStatus | null>(null);
  const [visible, setVisible] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const lastProgressAt = useRef(Date.now());
  const lastRatio = useRef(-1);
  /** settled 只发一次：done/error 落定那一拍。 */
  const settledRef = useRef(false);

  useEffect(() => {
    let alive = true;
    const apply = (s: MoveStatus): void => {
      setStatus(s);
      setVisible(s.running);
      // 进度看门狗：ratio 有动就续命
      const ratio = s.progress?.ratio ?? -1;
      if (ratio !== lastRatio.current) {
        lastRatio.current = ratio;
        lastProgressAt.current = Date.now();
      }
      if (settledRef.current || s.running) return;
      if (s.done || s.lastError) {
        settledRef.current = true;
        setVisible(false);
        setCancelling(false);
        if (s.done) {
          show('success', t('project.moveDone', { name: s.projectName ?? '' }));
          if (s.initError) show('error', t('project.moveInitFailed', { error: s.initError }));
        } else if (s.lastError === 'cancelled') {
          show('success', t('project.moveCancelled'));
        } else {
          show('error', t('project.moveFailed', { error: s.lastError ?? '' }));
        }
        onSettled?.(s);
      }
    };
    // 首拍：页面刷新后迁移可能已经在跑
    api
      .getMoveStatus()
      .then((r) => {
        if (alive) apply(r.status);
      })
      .catch((e) => {
        if (alive) show('error', t('project.movePollLost', { error: errorText(e) }));
      });
    const offPush = subscribePush<{ status: MoveStatus }>('moveStatus', (p) => {
      if (p?.status && alive) apply(p.status);
    });
    const offConn = subscribeSseConnection(() => {
      if (!sseConnected()) setVisible(false);
    });
    return () => {
      alive = false;
      offPush();
      offConn();
    };
  }, [show, t, onSettled]);

  // 进度看门狗（本地判活，不发请求）：running 且 ratio 长期不动 → 散屏
  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(() => {
      if (Date.now() - lastProgressAt.current > STALL_MS) {
        setVisible(false);
        show('error', t('project.moveStalled'));
        settledRef.current = true;
      }
    }, WATCHDOG_MS);
    return () => window.clearInterval(timer);
  }, [visible, show, t]);

  // 组件重挂（dev 热重载/路由切换）后 settled 门复位
  useEffect(() => {
    settledRef.current = false;
  }, []);

  const cancel = (): void => {
    setCancelling(true);
    api.cancelMoveProject().catch(() => setCancelling(false));
  };

  if (!visible || !status) return null;

  return createPortal(
    <div className="fixed inset-0 z-[80] flex flex-col items-center justify-center gap-3 bg-black/70 backdrop-blur-sm" role="status">
      <div className="flex items-center gap-3 rounded-2xl border border-edge/[0.08] bg-neutral-900 px-8 py-6 shadow-mac">
        <FolderInput className="h-5 w-5 text-blue-400" />
        <div className="min-w-72">
          <p className="flex items-center gap-2 text-sm font-medium text-neutral-100">
            <Loader2 className="h-4 w-4 animate-spin text-blue-300" />
            {t('project.moveOverlayTitle', { name: status.projectName ?? '' })}
          </p>
          <p className="mt-1 text-11 text-neutral-500">
            {t('project.moveFromTo', {
              from: status.fromPath ?? '',
              to: status.toPath ?? '',
            })}
          </p>
          {status.progress && (
            <p className="mt-1 text-11 text-neutral-500">
              {t(`project.movePhase.${status.progress.phase}` as 'project.movePhase.copy')}
              {status.progress.ratio > 0 && ` · ${Math.round(status.progress.ratio * 100)}%`}
              {status.progress.etaSeconds != null &&
                ` · ${t('settings.backupEta', { n: status.progress.etaSeconds })}`}
            </p>
          )}
          {status.progress && (
            <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-neutral-800">
              <div
                className="h-full bg-mac-accent transition-all duration-500"
                style={{ width: `${Math.max(2, Math.round(status.progress.ratio * 100))}%` }}
              />
            </div>
          )}
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              disabled={cancelling}
              onClick={cancel}
              className="flex items-center gap-1.5 rounded-lg border border-edge/[0.12] px-2.5 py-1 text-11 text-neutral-400 transition-colors hover:border-edge/[0.24] hover:text-neutral-200 disabled:opacity-60"
            >
              {cancelling ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
              {t(cancelling ? 'project.moveCancelling' : 'project.moveCancel')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
