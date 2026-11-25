/**
 * Web 终端分屏容器（panel = 右栏 / overlay = 全屏弹层，都在主窗内）。
 * 全部 pane 以稳定 key 绝对定位渲染在同一层：split/拖拽/重排只改坐标，
 * **绝不 unmount xterm**（否则 detach→attach→重放→gap 闪烁）。
 * 拖拽 = pane 头部按住；同窗内四象限落点（中心 = 换位）；拖出本窗内容区
 * 松手 = 弹出独立终端页（独立路由 /pane，**单独页面、不再分屏**），原 pane 位置
 * 留占位卡 + 切回按钮（reclaim 归还；持窗失联自动恢复本地显示）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, RotateCcw, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useT } from '@/i18n/I18nProvider';
import { TerminalView } from '@/components/TerminalView';
import { type DropSide, type PaneRect, layoutGeometry } from './pane-layout';
import {
  adjustPaneWeights,
  closePane,
  focusPane,
  movePane,
  openPane,
  type PaneRecord,
  type PaneSlot,
  setPanePopped,
  useTermPanes,
} from './term-pane-store';
import { paneSync, type RemoteDrag } from './pane-sync';
import { openPaneFrame, reclaimPaneFrame } from './pane-transfer';
import { getTermPaneState } from './term-pane-store';

interface LocalDrag {
  paneId: string;
  over: { target: string; side: DropSide } | null;
}

export function TerminalPanes({ slot, projectId }: { slot: PaneSlot; projectId?: number }) {
  const t = useT();
  const state = useTermPanes();
  const holder = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<LocalDrag | null>(null);
  const [remoteDrag, setRemoteDrag] = useState<RemoteDrag | null>(null);
  /** 分隔条拖动中：关位置过渡（权重连续更新，吃过渡会发黏） */
  const [sepDrag, setSepDrag] = useState(false);
  const dragRef = useRef<LocalDrag | null>(null);

  const panes = useMemo(
    () =>
      Object.values(state.panes).filter(
        (p) => p.slot === slot && (projectId === undefined || p.projectId === undefined || p.projectId === projectId),
      ),
    [state.panes, slot, projectId],
  );
  const layout = state.layouts[slot];
  const geo = useMemo(() => (layout ? layoutGeometry(layout) : null), [layout]);

  // presence：本窗在显实例（跨窗互斥判据；弹出的不算——显示权在独立页那边）
  useEffect(() => {
    paneSync.start();
    paneSync.setInstances(
      Object.values(state.panes)
        .filter((p) => !p.poppedOut)
        .map((p) => p.instanceId),
    );
  }, [state.panes]);

  // 弹出页关闭后 openPaneFrame 会删掉对应 storage 记录；主窗据此恢复原 pane。
  useEffect(() => {
    const sync = () => {
      for (const pane of Object.values(getTermPaneState().panes)) {
        if (!pane.poppedOut || !pane.poppedWinId) continue;
        try {
          if (!localStorage.getItem(`weave:pane-frame:${pane.poppedWinId}`)) setPanePopped(pane.paneId, null);
        } catch {
          // storage 不可用时保留占位，不误挂回第二个 TerminalView。
        }
      }
    };
    window.addEventListener('storage', sync);
    window.addEventListener('weave:pane-frames-changed', sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener('weave:pane-frames-changed', sync);
    };
  }, []);

  const beginDrag = useCallback(
    (paneId: string, e: React.PointerEvent) => {
      // 按钮上的按下不启动拖拽：pointer capture 会把后续 click 吃掉，关不掉 pane
      if ((e.target as HTMLElement).closest('button')) return;
      if (!geo) return;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const next: LocalDrag = { paneId, over: null };
      dragRef.current = next;
      setDrag(next);
    },
    [geo],
  );

  const hitTest = useCallback(
    (clientX: number, clientY: number): { target: string; side: DropSide } | null => {
      if (!geo || !holder.current) return null;
      const box = holder.current.getBoundingClientRect();
      const x = (clientX - box.left) / box.width;
      const y = (clientY - box.top) / box.height;
      let target: PaneRect | null = null;
      for (const rect of geo.panes) {
        if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) {
          target = rect;
          break;
        }
      }
      if (!target) return null;
      const dx = (x - target.x) / target.w - 0.5;
      const dy = (y - target.y) / target.h - 0.5;
      if (Math.abs(dx) < 0.18 && Math.abs(dy) < 0.18) return { target: target.paneId, side: 'center' };
      if (Math.abs(dx) > Math.abs(dy)) return { target: target.paneId, side: dx > 0 ? 'right' : 'left' };
      return { target: target.paneId, side: dy > 0 ? 'bottom' : 'top' };
    },
    [geo],
  );

  const onDragMove = useCallback(
    (paneId: string, e: React.PointerEvent) => {
      const cur = dragRef.current;
      if (!cur || cur.paneId !== paneId) return;
      paneSync.broadcastDragPoint(e.screenX, e.screenY);
      const over = hitTest(e.clientX, e.clientY);
      // 落在自己身上：无有效落点（self 的 center 换位也是无操作）
      const valid = over && over.target !== paneId ? over : null;
      const next = { paneId, over: valid };
      dragRef.current = next;
      setDrag(next);
    },
    [hitTest],
  );

  /** 弹出到独立框架页：把该 pane 贴成框架页的**终端**视图（会话对话不跟着走，
   *  PaneFramePage 按视图 kind 渲染 TerminalView）；本 pane 立即转占位。
   *  弹窗被拦保持本地显示。openPaneFrame 要求 seed 一个 conversation 视图——
   *  用 pane 自己绑的会话（没有绑定的 overlay shell 才落 sessionId=paneId 的
   *  纯终端 seed，弹出页只显示终端视图）。 */
  const popout = useCallback(
    (pane: PaneRecord): void => {
      try {
        const frameId = openPaneFrame(
          {
            projectId: pane.projectId ?? 0,
            projectLabel: pane.label,
            sessionId: pane.sessionId ?? pane.paneId,
            label: pane.label,
            terminalInstance: pane.instanceId,
          },
          'width=900,height=620',
        );
        setPanePopped(pane.paneId, frameId);
      } catch {
        // 浏览器拦了弹窗：pane 留在本地，不转占位
      }
    },
    [],
  );

  const onDragEnd = useCallback(
    (paneId: string, e: React.PointerEvent) => {
      const cur = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      paneSync.endDrag();
      if (!cur) return;
      const pane = state.panes[paneId];
      if (!pane) return;
      // 拖出本窗内容区：落在另一个框架页窗口上 = 投放进去（对方接单才让位）；
      // 没人接（空白桌面 / 超上限 / 项目不符）= 弹出独立终端页
      const win = paneSync.windowAt(e.screenX, e.screenY);
      if (win && !win.self) {
        void paneSync
          .offerDrop(win.winId, {
            screenX: e.screenX,
            screenY: e.screenY,
            projectId: pane.projectId,
            view: {
              kind: 'terminal',
              instanceId: pane.instanceId,
              label: pane.label,
              sessionId: pane.sessionId ?? pane.paneId,
            },
          })
          .then((accepted) => {
            if (accepted) closePane(pane.paneId);
            else popout(pane);
          });
        return;
      }
      if (!win) {
        popout(pane);
        return;
      }
      if (cur.over && cur.over.target !== paneId) movePane(paneId, cur.over.target, cur.over.side);
    },
    [state.panes, popout],
  );

  /** 切回：把 storage 记录置 returning，持窗卸载视图后删记录；上面的 storage
   *  监听见记录消失即恢复本地显示（不会双挂同一终端实例）。 */
  const reclaim = useCallback(
    (pane: PaneRecord): void => {
      if (!pane.poppedWinId) return;
      reclaimPaneFrame(pane.poppedWinId);
    },
    [],
  );

  // 远端拖拽指针是否落在本窗内容区（接缝预览：拖出提示即将弹出）
  const remoteOver = useMemo(() => {
    if (!remoteDrag) return false;
    const b = {
      x: window.screenX + Math.max(0, (window.outerWidth - window.innerWidth) / 2),
      y: window.screenY + (window.outerHeight - window.innerHeight),
    };
    return (
      remoteDrag.screenX >= b.x &&
      remoteDrag.screenX <= b.x + window.innerWidth &&
      remoteDrag.screenY >= b.y &&
      remoteDrag.screenY <= b.y + window.innerHeight
    );
  }, [remoteDrag]);

  useEffect(() => paneSync.onRemoteDrag(setRemoteDrag), []);

  // 跨窗投放的接收端（只面板槽接；同项目才接）：拖进来的终端落成同一槽位的一格
  useEffect(() => {
    if (slot !== 'panel') return;
    return paneSync.onDropOffer((offer) => {
      if (offer.view.kind !== 'terminal') return false;
      if (projectId !== undefined && offer.projectId !== undefined && offer.projectId !== projectId) return false;
      const r = openPane(
        {
          instanceId: offer.view.instanceId,
          label: offer.view.label,
          slot,
          sessionId: offer.view.sessionId,
          projectId: offer.projectId ?? projectId,
        },
        { fromDrop: true },
      );
      return r.ok || r.reason === 'duplicate';
    });
  }, [slot, projectId]);

  if (!geo || panes.length === 0) return null;

  const activePane = state.active[slot];

  return (
    <div ref={holder} className="relative min-h-0 min-w-0 flex-1 select-none">
      {geo.panes.map((rect) => {
        const pane = state.panes[rect.paneId];
        if (!pane || pane.slot !== slot) return null;
        return (
          <div
            key={rect.paneId}
            className={cn(
              'absolute flex flex-col overflow-hidden rounded-md border bg-black/90',
              activePane === rect.paneId ? 'border-blue-500/50' : 'border-edge/[0.2]',
              sepDrag ? 'transition-none' : 'transition-[left,top,width,height] duration-150 ease-out',
              drag?.paneId === rect.paneId && 'opacity-60',
            )}
            style={{
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.w * 100}%`,
              height: `${rect.h * 100}%`,
            }}
            onPointerDown={() => focusPane(rect.paneId)}
          >
            <div
              className={cn(
                'flex shrink-0 items-center justify-between gap-2 border-b border-edge/[0.06] bg-neutral-900/80 px-2 py-1 text-xs text-neutral-300',
                !pane.poppedOut && 'cursor-grab active:cursor-grabbing',
              )}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                beginDrag(rect.paneId, e);
              }}
              onPointerMove={(e) => onDragMove(rect.paneId, e)}
              onPointerUp={(e) => void onDragEnd(rect.paneId, e)}
              onPointerCancel={(e) => void onDragEnd(rect.paneId, e)}
            >
              <span className="truncate font-medium">{pane.label}</span>
              <span className="flex items-center gap-0.5">
                {!pane.poppedOut && slot === 'overlay' && (
                  <button
                    type="button"
                    aria-label={t('tasks.panePopout')}
                    onClick={() => popout(pane)}
                    className="rounded p-0.5 text-neutral-500 transition-colors hover:bg-edge/[0.06] hover:text-neutral-200"
                  >
                    <ExternalLink className="size-3.5" />
                  </button>
                )}
                {pane.poppedOut && (
                  <button
                    type="button"
                    aria-label={t('tasks.paneReclaim')}
                    onClick={() => reclaim(pane)}
                    className="rounded p-0.5 text-neutral-500 transition-colors hover:bg-edge/[0.06] hover:text-neutral-200"
                  >
                    <RotateCcw className="size-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  aria-label={t('tasks.webTerminalClose')}
                  onClick={() => closePane(rect.paneId)}
                  className="rounded p-0.5 text-neutral-500 transition-colors hover:bg-edge/[0.06] hover:text-neutral-200"
                >
                  <X className="size-4" />
                </button>
              </span>
            </div>
            {pane.poppedOut ? (
              // 占位卡：终端在独立窗口里跑，这里只留位置与切回入口
              <button
                type="button"
                onClick={() => reclaim(pane)}
                className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 border border-dashed border-edge/[0.12] text-neutral-600 transition-colors hover:border-blue-500/40 hover:text-neutral-400"
              >
                <ExternalLink className="size-5" />
                <span className="text-xs">{t('tasks.panePoppedOut')}</span>
                <span className="rounded bg-blue-500/20 px-2 py-0.5 text-xs text-blue-300">
                  {t('tasks.paneReclaim')}
                </span>
              </button>
            ) : (
              <div className="relative min-h-0 flex-1">
                <TerminalView instanceId={pane.instanceId} initialCommand={pane.initialCommand} />
                {/* 本窗拖拽的落点预览（四象限高亮） */}
                {drag?.over?.target === rect.paneId && drag.over.side !== 'center' && (
                  <div
                    className={cn(
                      'pointer-events-none absolute z-10 flex items-center justify-center bg-blue-500/15 p-2 ring-1 ring-blue-400/60',
                      'transition-[left,top,width,height] duration-150 ease-out',
                      drag.over.side === 'left' && 'inset-y-0 left-0 w-1/2',
                      drag.over.side === 'right' && 'inset-y-0 right-0 w-1/2',
                      drag.over.side === 'top' && 'inset-x-0 top-0 h-1/2',
                      drag.over.side === 'bottom' && 'inset-x-0 bottom-0 h-1/2',
                    )}
                  >
                    <span className="max-w-full truncate rounded bg-blue-500/80 px-2 py-0.5 text-10 text-white shadow-mac">
                      {state.panes[drag.paneId]?.label ?? ''}
                    </span>
                  </div>
                )}
                {drag?.over?.target === rect.paneId && drag.over.side === 'center' && (
                  <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded ring-2 ring-blue-400/60">
                    <span className="max-w-full truncate rounded bg-blue-500/80 px-2 py-0.5 text-10 text-white shadow-mac">
                      {state.panes[drag.paneId]?.label ?? ''}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {/* 分隔条（不持 xterm 状态，可重挂） */}
      {geo.seps.map((sep) => (
        <div
          key={sep.key}
          role="separator"
          className={cn(
            'absolute z-20 touch-none',
            sep.dir === 'row' ? 'w-1.5 cursor-col-resize' : 'h-1.5 cursor-row-resize',
            'bg-transparent transition-colors hover:bg-blue-500/40 active:bg-blue-500/60',
          )}
          style={
            sep.dir === 'row'
              ? { left: `${sep.bx * 100}%`, top: `${sep.y * 100}%`, height: `${sep.h * 100}%`, transform: 'translateX(-50%)' }
              : { top: `${sep.by * 100}%`, left: `${sep.x * 100}%`, width: `${sep.w * 100}%`, transform: 'translateY(-50%)' }
          }
          onPointerDown={(e) => {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            e.stopPropagation();
            (e.currentTarget as HTMLElement).dataset.px = String(
              sep.dir === 'row' ? e.clientX : e.clientY,
            );
            setSepDrag(true);
          }}
          onPointerMove={(e) => {
            const el = e.currentTarget as HTMLElement;
            if (!el.dataset.px) return;
            const prev = Number(el.dataset.px);
            const now = sep.dir === 'row' ? e.clientX : e.clientY;
            el.dataset.px = String(now);
            const box = holder.current?.getBoundingClientRect();
            if (!box) return;
            const span = sep.dir === 'row' ? box.width : box.height;
            const delta = (now - prev) / span;
            if (delta !== 0) adjustPaneWeights(slot, sep.path, sep.index, delta);
          }}
          onPointerUp={(e) => {
            delete (e.currentTarget as HTMLElement).dataset.px;
            setSepDrag(false);
          }}
          onPointerCancel={(e) => {
            delete (e.currentTarget as HTMLElement).dataset.px;
            setSepDrag(false);
          }}
        />
      ))}
      {/* 拖出本窗的接缝提示：松手即弹出独立终端页 */}
      {remoteOver && (
        <div className="pointer-events-none absolute inset-1 z-30 flex items-center justify-center rounded-md ring-2 ring-blue-400/70">
          <span className="rounded bg-blue-500/85 px-2 py-1 text-xs font-medium text-white">
            {t('tasks.panePopoutRelease')}
          </span>
        </div>
      )}
    </div>
  );
}

/** overlay 全屏面（主窗弹层）：有 pane 才渲染。 */
export function TerminalPanesOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const state = useTermPanes();
  const count = Object.values(state.panes).filter((p) => p.slot === 'overlay').length;
  if (!open || count === 0) return null;
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-neutral-950/95 p-2 sm:p-4">
      <div className="flex items-center justify-end gap-2 pb-2">
        <button
          type="button"
          aria-label="close"
          onClick={onClose}
          className="rounded-md p-1 text-neutral-500 transition-colors hover:bg-edge/[0.06] hover:text-neutral-200"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <TerminalPanes slot="overlay" />
      </div>
    </div>
  );
}
