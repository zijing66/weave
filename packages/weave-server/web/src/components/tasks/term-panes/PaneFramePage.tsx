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

import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { TerminalView } from '@/components/TerminalView';
import { useT } from '@/i18n/I18nProvider';
import { api } from '@/lib/api';
import { ConversationPane } from './ConversationPane';
import { paneSync } from './pane-sync';
import {
  type FrameView,
  type PaneTransfer,
  adjustFrameWeights,
  attachFrameView,
  detachFrameView,
  finishPaneFrame,
  frameLayoutOf,
  readPaneTransfer,
  subscribePaneFrames,
  viewIdOf,
} from './pane-transfer';
import { layoutGeometry } from './pane-layout';

export function PaneFramePage() {
  const t = useT();
  const [claim] = useState<PaneTransfer | null>(() => readPaneTransfer());
  // 记录可能被主窗改（贴终端 pane）→ 订阅常读最新一份；claim 只定身份
  const [frame, setFrame] = useState<PaneTransfer | null>(claim);

  // 记录被外部改写（主窗贴 pane / returning）/ 删除（源窗异常清理）
  useEffect(() => {
    if (!claim) return;
    return subscribePaneFrames(() => {
      const cur = readPaneTransfer(claim.frameId);
      if (!cur) window.close();
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

  // 卸载完成后确认归还 + 自关（window.close 可能被拦，留着也不重复显示——
  // 记录已删，源窗已恢复本地显示；presence 互斥兜底）
  useEffect(() => {
    if (frame || !claim) return;
    finishPaneFrame(claim.frameId);
    window.close();
  }, [frame, claim]);

  // 初始就认领不到（手开 /pane-frame）：直接关；关不掉就留一句可读的空态
  useEffect(() => {
    if (!claim) window.close();
  }, [claim]);

  const geo = useMemo(() => (frame ? layoutGeometry(frameLayoutOf(frame) ?? { kind: 'pane', paneId: Object.keys(frame.views)[0] ?? '' }) : null), [frame]);

  if (!frame || !geo) {
    return <p className="m-auto animate-pulse text-xs text-neutral-600">…</p>;
  }

  return (
    <div className="flex h-dvh flex-col bg-neutral-950 p-1">
      <div className="flex shrink-0 items-center gap-2 border-b border-edge/[0.06] bg-neutral-900/80 px-2 py-1 text-xs text-neutral-400">
        <span className="min-w-0 truncate font-medium text-neutral-300">{frame.projectLabel}</span>
        <FrameHeaderActions frame={frame} />
        <button
          type="button"
          aria-label="close"
          onClick={() => setFrame(null)}
          className="self-center rounded p-1 text-neutral-500 transition-colors hover:bg-edge/[0.06] hover:text-neutral-200"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="relative min-h-0 flex-1 select-none">
        {geo.panes.map((rect) => {
          const view = frame.views[rect.paneId];
          if (!view) return null;
          return (
            <div
              key={rect.paneId}
              className="absolute flex flex-col overflow-hidden rounded-md border border-edge/[0.08]"
              style={{
                left: `${rect.x * 100}%`,
                top: `${rect.y * 100}%`,
                width: `${rect.w * 100}%`,
                height: `${rect.h * 100}%`,
              }}
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
            </div>
          );
        })}
        {/* 分隔条（不持 xterm 状态，可重挂）：与主窗 TerminalPanes 同款 */}
        {geo.seps.map((sep) => (
          <div
            key={sep.key}
            role="separator"
            className={
              'absolute z-20 touch-none ' +
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
            }}
            onPointerCancel={(e) => {
              delete (e.currentTarget as HTMLElement).dataset.px;
            }}
          />
        ))}
      </div>
    </div>
  );
}

/** 头部动作区：当前焦点会话（种子会话）的终端切换——主窗终端按钮与本窗按钮
 *  写同一份 storage 记录（attachFrameView 幂等），多窗不冲突。 */
function FrameHeaderActions({ frame }: { frame: PaneTransfer }) {
  const t = useT();
  const [session, setSession] = useState<{ webInstanceId: string | null } | null>(null);
  const convId = viewIdOf(frame.seedSessionId, 'conversation');
  const termId = viewIdOf(frame.seedSessionId, 'terminal');
  const hasConv = !!frame.views[convId];
  const hasTerm = !!frame.views[termId];

  useEffect(() => {
    let alive = true;
    api
      .listSessions(frame.projectId)
      .then((r) => {
        if (!alive) return;
        const row = r.sessions.find((s) => s.sessionId === frame.seedSessionId);
        if (row) setSession({ webInstanceId: row.webInstanceId ?? null });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [frame.projectId, frame.seedSessionId]);

  const toggle = (): void => {
    if (hasTerm) {
      detachFrameView(frame.frameId, termId);
      return;
    }
    const inst = session?.webInstanceId;
    if (!inst) return;
    attachFrameView(frame.frameId, {
      kind: 'terminal',
      instanceId: inst,
      label: frame.label,
      sessionId: frame.seedSessionId,
    });
  };

  if (!hasConv || !(hasTerm || session?.webInstanceId)) return null;
  return (
    <button
      type="button"
      aria-label={hasTerm ? t('tasks.paneShowConversation') : t('tasks.paneShowTerminal')}
      onClick={toggle}
      className="inline-flex shrink-0 items-center gap-1 rounded border border-edge/[0.08] px-1.5 py-0.5 text-10 text-neutral-400 transition-colors hover:border-edge/[0.16] hover:text-neutral-200"
    >
      {hasTerm ? t('tasks.paneShowConversation') : t('tasks.paneShowTerminal')}
    </button>
  );
}
