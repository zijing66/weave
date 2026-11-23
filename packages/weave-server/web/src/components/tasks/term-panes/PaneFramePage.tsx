/**
 * 分屏框架页（独立路由 /pane，**单独页面、不加载 dashboard**）。
 * 内容由 storage 传递（pane-transfer）：window.name 带 frameId，挂载即读
 * `weave:pane-frame:<frameId>` 认领描述符，认不到（过期、被删、直接手开
 * /pane）即自关。切回 = 源窗把记录置 returning → 本页先卸视图（断终端
 * WS / 对话 SSE），再删记录（finishPaneFrame）、自关；源窗见记录消失才
 * 恢复原位显示，保证同一实例绝不同时挂两处。数据源独立：终端 = 各自的
 * /terminals/ws，对话 = 本页自己的 SSE + Query 缓存。
 */

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { TerminalView } from '@/components/TerminalView';
import { ConversationPane } from './ConversationPane';
import { paneSync } from './pane-sync';
import {
  finishPaneFrame,
  readPaneTransfer,
  subscribePaneFrames,
  type PaneTransfer,
} from './pane-transfer';

export function PaneFramePage() {
  const [claim] = useState<PaneTransfer | null>(() => readPaneTransfer());
  const [pane, setPane] = useState<PaneTransfer | null>(claim);

  // 本页显示终端时的跨窗互斥（presence）
  useEffect(() => {
    if (!claim || claim.kind !== 'terminal') return;
    paneSync.start();
    paneSync.setInstances([claim.instanceId]);
  }, [claim]);

  // 记录被外部删（源窗异常清理）→ 自关；被置 returning → 卸视图走归还流程
  useEffect(() => {
    if (!claim) return;
    return subscribePaneFrames(() => {
      const cur = readPaneTransfer(claim.frameId);
      if (!cur) window.close();
      else if (cur.state === 'returning') setPane(null);
    });
  }, [claim]);

  // 卸载完成后确认归还 + 自关（window.close 可能被拦，留着也不重复显示——
  // 记录已删，源窗已恢复本地显示；presence 互斥兜底）
  useEffect(() => {
    if (pane || !claim) return;
    finishPaneFrame(claim.frameId);
    window.close();
  }, [pane, claim]);

  // 初始就认领不到（手开 /pane）：直接关；关不掉就留一句可读的空态
  useEffect(() => {
    if (!claim) window.close();
  }, [claim]);

  if (!pane) {
    return <p className="m-auto animate-pulse text-xs text-neutral-600">…</p>;
  }

  return (
    <div className="flex h-dvh flex-col bg-neutral-950 p-1">
      <div className="flex shrink-0 items-center gap-2 border-b border-edge/[0.06] bg-neutral-900/80 px-2 py-1 text-xs text-neutral-400">
        <span className="min-w-0 truncate font-medium text-neutral-300" title={pane.label}>
          {pane.label}
        </span>
        {pane.kind === 'conversation' && (
          <span className="truncate text-10 text-neutral-600">{pane.projectLabel}</span>
        )}
        <button
          type="button"
          aria-label="close"
          onClick={() => setPane(null)}
          className="ml-auto self-center rounded p-1 text-neutral-500 transition-colors hover:bg-edge/[0.06] hover:text-neutral-200"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {pane.kind === 'terminal' ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-edge/[0.08] bg-black/90">
            <TerminalView instanceId={pane.instanceId} />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <ConversationPane
              sessionId={pane.sessionId}
              projectId={pane.projectId}
              label={pane.label}
              projectLabel={pane.projectLabel}
            />
          </div>
        )}
      </div>
    </div>
  );
}
