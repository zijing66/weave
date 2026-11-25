/**
 * 分屏框架页（独立路由 /pane-frame，**单独页面、不加载 dashboard**）。
 * 内容由 storage 传递（pane-transfer）：window.name 带 frameId，挂载即读
 * `weave:pane-frame:<frameId>` 认领描述符，认不到（过期、被删、直接手开）即自关。
 * 一个框架页 = **一个项目**的多 pane 面（wezterm 贴 pane 同款，≤6）：对话与该
 * 项目各会话的 Web 终端都贴进同一棵布局树——主窗终端按钮写入（attachFrameView）
 * 或本窗头部按钮切换；同一实例跨窗互斥仍由 presence 把关。
 * 切回 = 源窗把记录置 returning → 本页先卸视图（断终端 WS / 对话 SSE），再删
 * 记录（finishPaneFrame）、自关；源窗见记录消失才恢复原位显示，同一会话的对话
 * 绝不同时挂两处（终端实例由 presence 补刀）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TerminalView } from '@/components/TerminalView';
import { useT } from '@/i18n/I18nProvider';
import { ConversationPane } from './ConversationPane';
import { type RemoteDrag, paneSync } from './pane-sync';
import {
  type FrameView,
  type PaneTransfer,
  adjustFrameWeights,
  attachFrameView,
  detachFrameView,
  finishPaneFrame,
  frameLayoutOf,
  moveFrameView,
  readPaneTransfer,
  reclaimPaneFrame,
  subscribePaneFrames,
} from './pane-transfer';
import { type DropSide, layoutGeometry } from './pane-layout';

export function PaneFramePage() {
  const t = useT();
  const [claim] = useState<PaneTransfer | null>(() => readPaneTransfer());
  // 记录可能被主窗改（贴终端 pane）→ 订阅常读最新一份；claim 只定身份
  const [frame, setFrame] = useState<PaneTransfer | null>(claim);
  const holder = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{ paneId: string; over: { target: string; side: DropSide } | null } | null>(null);
  const dragRef = useRef<typeof drag>(null);
  const [remoteDrag, setRemoteDrag] = useState<RemoteDrag | null>(null);
  /** 分隔条拖动中：关掉位置过渡，否则每次权重更新都追着动画跑（发黏） */
  const [sepDrag, setSepDrag] = useState(false);

  // 记录被外部改写（主窗贴 pane / returning）/ 删除（源窗异常清理）。
  // returning = 主窗已切回（对话本体在主窗恢复显示）：先卸视图（断 WS / SSE）
  // 再走收尾删记录自关——不卸就是同一对话双挂两处。
  useEffect(() => {
    if (!claim) return;
    return subscribePaneFrames(() => {
      const cur = readPaneTransfer(claim.frameId);
      if (!cur || cur.state === 'returning') setFrame(null);
      else setFrame(cur);
    });
  }, [claim]);

  // 本窗在显实例（presence 互斥；对话视图不带实例）
  const shownInstances = useMemo(
    () =>
      frame
        ? Object.entries(frame.views)
            .filter(([, v]) => v.kind === 'terminal')
            .map(([, v]) => (v as Extract<FrameView, { kind: 'terminal' }>).instanceId)
        : [],
    [frame],
  );
  useEffect(() => {
    if (!claim || shownInstances.length === 0) return;
    paneSync.start();
    paneSync.setInstances(shownInstances);
  }, [claim, shownInstances]);

  // 跨窗拖拽/投放的两条腿：本窗无论有没有终端实例都要在通道上
  useEffect(() => {
    paneSync.start();
  }, []);
  useEffect(() => paneSync.onRemoteDrag(setRemoteDrag), []);

  // 卸载完成后确认归还 + 自关（window.close 可能被拦，留着也不重复显示——
  // 记录已删，源窗已恢复本地显示；presence 互斥兜底）。
  // 外层窗头已拆：pane 逐扇自关（对话头部 / 终端窄头的 X），最后一扇关掉 = 整窗收尾。
  useEffect(() => {
    if (!claim) return;
    if (frame && Object.keys(frame.views).length > 0) return;
    finishPaneFrame(claim.frameId);
    window.close();
  }, [frame, claim]);

  // 初始就认领不到（手开 /pane-frame）：直接关；关不掉就留一句可读的空态
  useEffect(() => {
    if (!claim) window.close();
  }, [claim]);

  const geo = useMemo(() => (frame ? layoutGeometry(frameLayoutOf(frame) ?? { kind: 'pane', paneId: Object.keys(frame.views)[0] ?? '' }) : null), [frame]);

  /** 屏幕坐标 → 本窗 client 坐标（paneSync.contentBounds 同一近似）。 */
  const clientOfScreen = (screenX: number, screenY: number) => ({
    x: screenX - (window.screenX + Math.max(0, (window.outerWidth - window.innerWidth) / 2)),
    y: screenY - (window.screenY + (window.outerHeight - window.innerHeight)),
  });

  const hitTest = (clientX: number, clientY: number): { target: string; side: DropSide } | null => {
    if (!geo || !holder.current) return null;
    const box = holder.current.getBoundingClientRect();
    const x = (clientX - box.left) / box.width;
    const y = (clientY - box.top) / box.height;
    let target: (typeof geo.panes)[number] | null = null;
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
  };

  const beginDrag = (paneId: string, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button,input,textarea,select,a,[contenteditable],[role=separator]')) return;
    // 拖拽区 = pane 头部一条（对话/终端两形态头部都是最上面那行）
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (e.clientY - box.top > 34) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const next = { paneId, over: null };
    dragRef.current = next;
    setDrag(next);
  };

  const onDragMove = (paneId: string, e: React.PointerEvent) => {
    const cur = dragRef.current;
    if (!cur || cur.paneId !== paneId) return;
    paneSync.broadcastDragPoint(e.screenX, e.screenY);
    const over = hitTest(e.clientX, e.clientY);
    const next = { paneId, over: over && over.target !== paneId ? over : null };
    dragRef.current = next;
    setDrag(next);
  };

  const onDragEnd = (paneId: string, e: React.PointerEvent) => {
    const cur = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    paneSync.endDrag();
    if (!cur || !frame) return;
    const win = paneSync.windowAt(e.screenX, e.screenY);
    if (!win || !win.self) {
      // 拖出本窗：问目标窗要不要（frame→frame 落进对方分屏；没人接就原地不动）
      const view = frame.views[paneId];
      if (win && view) {
        void paneSync
          .offerDrop(win.winId, { screenX: e.screenX, screenY: e.screenY, projectId: frame.projectId, view })
          .then((accepted) => {
            if (accepted) detachFrameView(frame.frameId, paneId);
          });
      }
      return;
    }
    if (cur.over && cur.over.target !== paneId) {
      moveFrameView(frame.frameId, paneId, cur.over.target, cur.over.side);
    }
  };

  // 跨窗投放的接收端：同项目才接，落点按指针所在象限（落点不在任何 pane 上 = 缺省侧插）
  useEffect(() => {
    return paneSync.onDropOffer((offer) => {
      const cur = readPaneTransfer(claim?.frameId ?? '');
      if (!cur || cur.state !== 'active') return false;
      if (offer.projectId !== undefined && offer.projectId !== cur.projectId) return false;
      const c = clientOfScreen(offer.screenX, offer.screenY);
      const over = hitTest(c.x, c.y);
      return attachFrameView(cur.frameId, offer.view, over?.target, over?.side).ok;
    });
    // hitTest 闭包依赖 geo；frame 变化时重订阅即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claim, geo]);

  const remoteHit = remoteDrag
    ? hitTest(clientOfScreen(remoteDrag.screenX, remoteDrag.screenY).x, clientOfScreen(remoteDrag.screenX, remoteDrag.screenY).y)
    : null;

  if (!frame || !geo) {
    return <p className="m-auto animate-pulse text-xs text-neutral-600">…</p>;
  }

  return (
    // h-full 不用 h-dvh：根 zoom（界面缩放）下视口单位被二次放大、页面下溢一段黑
    // （移动端「底部多余高度」）——html/body/#root 已钉 100%（index.css），走百分比链。
    <div className="flex h-full flex-col bg-neutral-950 p-1">
      {/* 无外层窗头：对话 pane 头部右上角 = 切回 + 关闭（功能按钮不混排）；
          终端 pane 走窄头 X。最后一扇关掉 = 整窗收尾。 */}
      <div ref={holder} className="relative min-h-0 flex-1">
        {geo.panes.map((rect) => {
          const view = frame.views[rect.paneId];
          if (!view) return null;
          return (
            <div
              key={rect.paneId}
              className={cn(
                'absolute flex flex-col overflow-hidden rounded-md border border-edge/[0.2]',
                sepDrag ? 'transition-none' : 'transition-[left,top,width,height] duration-150 ease-out',
                drag?.paneId === rect.paneId && 'opacity-60',
              )}
              style={{
                left: `${rect.x * 100}%`,
                top: `${rect.y * 100}%`,
                width: `${rect.w * 100}%`,
                height: `${rect.h * 100}%`,
              }}
              onPointerDown={(e) => beginDrag(rect.paneId, e)}
              onPointerMove={(e) => onDragMove(rect.paneId, e)}
              onPointerUp={(e) => onDragEnd(rect.paneId, e)}
              onPointerCancel={(e) => onDragEnd(rect.paneId, e)}
            >
              {view.kind === 'terminal' ? (
                <>
                  {/* 终端 pane 保留窄头：只有关闭（对话 pane 的关闭并进对话头部） */}
                  <div className="flex shrink-0 items-center gap-2 border-b border-edge/[0.06] bg-neutral-900/80 px-2 py-1 text-10 text-neutral-500">
                    <span className="min-w-0 truncate">{view.label}</span>
                    <button
                      type="button"
                      aria-label={t('tasks.paneClose')}
                      onClick={() => detachFrameView(frame.frameId, rect.paneId)}
                      className="ml-auto shrink-0 rounded p-0.5 text-neutral-600 transition-colors hover:bg-edge/[0.06] hover:text-neutral-300"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                  <TerminalView instanceId={view.instanceId} />
                </>
              ) : (
                <ConversationPane
                  sessionId={view.sessionId}
                  projectId={frame.projectId}
                  label={view.label}
                  projectLabel={frame.projectLabel}
                  onClose={() => detachFrameView(frame.frameId, rect.paneId)}
                  onFrameReclaim={() => reclaimPaneFrame(frame.frameId)}
                  onOpenTerminal={(instanceId: string) =>
                    attachFrameView(frame.frameId, {
                      kind: 'terminal',
                      instanceId,
                      label: view.label,
                      sessionId: view.sessionId,
                    })
                  }
                />
              )}
              {/* 落点预览：本窗拖拽（实心，带被拖 pane 标签 = 插入位）+ 别窗拖过来（虚线） */}
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
                    {frame.views[drag.paneId]?.label ?? ''}
                  </span>
                </div>
              )}
              {drag?.over?.target === rect.paneId && drag.over.side === 'center' && (
                <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded ring-2 ring-blue-400/60">
                  <span className="max-w-full truncate rounded bg-blue-500/80 px-2 py-0.5 text-10 text-white shadow-mac">
                    {frame.views[drag.paneId]?.label ?? ''}
                  </span>
                </div>
              )}
              {!drag && remoteHit?.target === rect.paneId && remoteHit.side !== 'center' && (
                <div
                  className={cn(
                    'pointer-events-none absolute z-10 bg-sky-500/10 outline outline-1 outline-dashed outline-sky-400/50',
                    'transition-[left,top,width,height] duration-150 ease-out',
                    remoteHit.side === 'left' && 'inset-y-0 left-0 w-1/2',
                    remoteHit.side === 'right' && 'inset-y-0 right-0 w-1/2',
                    remoteHit.side === 'top' && 'inset-x-0 top-0 h-1/2',
                    remoteHit.side === 'bottom' && 'inset-x-0 bottom-0 h-1/2',
                  )}
                />
              )}
              {!drag && remoteHit?.target === rect.paneId && remoteHit.side === 'center' && (
                <div className="pointer-events-none absolute inset-2 z-10 rounded outline outline-1 outline-dashed outline-sky-400/50" />
              )}
            </div>
          );
        })}
        {/* 分隔条（不持 xterm 状态，可重挂）：与主窗 TerminalPanes 同款 */}
        {geo.seps.map((sep) => (
          <div
            key={sep.key}
            role="separator"
            className={
              'absolute z-20 touch-none select-none ' +
              (sep.dir === 'row' ? 'w-1.5 cursor-col-resize' : 'h-1.5 cursor-row-resize') +
              ' bg-transparent transition-colors hover:bg-blue-500/40 active:bg-blue-500/60'
            }
            style={
              sep.dir === 'row'
                ? { left: `${sep.bx * 100}%`, top: `${sep.y * 100}%`, height: `${sep.h * 100}%`, transform: 'translateX(-50%)' }
                : { top: `${sep.by * 100}%`, left: `${sep.x * 100}%`, width: `${sep.w * 100}%`, transform: 'translateY(-50%)' }
            }
            onPointerDown={(e) => {
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              (e.currentTarget as HTMLElement).dataset.px = String(sep.dir === 'row' ? e.clientX : e.clientY);
              setSepDrag(true);
            }}
            onPointerMove={(e) => {
              const el = e.currentTarget as HTMLElement;
              if (!el.dataset.px) return;
              const prev = Number(el.dataset.px);
              const now = sep.dir === 'row' ? e.clientX : e.clientY;
              el.dataset.px = String(now);
              const box = el.parentElement?.getBoundingClientRect();
              if (!box) return;
              const span = sep.dir === 'row' ? box.width : box.height;
              const delta = (now - prev) / span;
              if (delta !== 0) adjustFrameWeights(frame.frameId, sep.path, sep.index, delta);
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
      </div>
    </div>
  );
}
