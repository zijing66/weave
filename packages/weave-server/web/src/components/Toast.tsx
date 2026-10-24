import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import {
  TOAST_HOLD_MS,
  addToast,
  removeToast,
  type ToastItem,
  type ToastKind,
} from '@/lib/feedback-core';

/**
 * 全局消息提示（toast）：此前错误只有 App 里一行小红字，且一旦滚走就看不见。
 * 现在所有一次性消息走这里——成功/失败/信息三态，右下角堆叠，自动消失，可手动关。
 * 队列规则与停留时长在 `lib/feedback-core.ts`（纯逻辑，可直接单测）。
 */

export type { ToastItem, ToastKind };

const STYLE: Record<ToastKind, { box: string; icon: React.ReactNode }> = {
  success: {
    box: 'border-emerald-500/30 bg-emerald-950/80 text-emerald-100',
    icon: <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-emerald-400" />,
  },
  error: {
    box: 'border-red-500/30 bg-red-950/80 text-red-100',
    icon: <XCircle className="mt-px h-3.5 w-3.5 shrink-0 text-red-400" />,
  },
  info: {
    box: 'border-edge/[0.08] bg-neutral-900/90 text-neutral-200',
    icon: <Info className="mt-px h-3.5 w-3.5 shrink-0 text-neutral-400" />,
  },
};

interface ToastApi {
  show: (kind: ToastKind, message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((list) => removeToast(list, id));
  }, []);

  const show = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextId.current++;
      setItems((list) => addToast(list, { id, kind, message }));
      setTimeout(() => dismiss(id), TOAST_HOLD_MS[kind]);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* bottom-20：让开右下角的 AI 助手悬浮按钮（bottom-4），两者同在右下角。
          left/right 双锚让宽度自动 = 视口−两侧偏移（zoom 下 vw/max-w 百分比
          基准都会错乱，双锚几何上不可能出屏）；items-end 保持右对齐。 */}
      <div className="pointer-events-none fixed bottom-20 left-4 right-4 z-[60] flex flex-col items-end gap-2">
        {items.map((item) => (
          <div
            key={item.id}
            role="status"
            className={`pointer-events-auto flex max-w-full items-start gap-2 rounded-lg border px-3 py-2 text-xs shadow-mac backdrop-blur ${STYLE[item.kind].box}`}
          >
            {STYLE[item.kind].icon}
            <span className="min-w-0 flex-1 break-words">{item.message}</span>
            <button
              type="button"
              onClick={() => dismiss(item.id)}
              className="shrink-0 rounded p-0.5 text-current/60 hover:text-current"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
