/**
 * 独立对话组件（分屏第二批）：SessionMessages 的自包含包装——框架页（弹出窗）
 * 里渲染一扇对话所需的全部数据源都自己拉（capability / promptLimits 走 messaging
 * capabilities，中断直接走 api），不依赖 TasksPanel 的回调链，架构解耦。
 * 嵌入态右栏的对话仍由 TasksPanel 直挂 SessionMessages（共享同一条 SSE 与
 * Query 缓存域，两边天然同源）。
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useT } from '@/i18n/I18nProvider';
import { api } from '@/lib/api';
import type { MessagingCapability, PromptLimits } from '@/lib/api';
import { useActionFeedback, errorText } from '@/lib/action-feedback';
import { SessionMessages } from '../SessionMessages';
import { webTerminalAvailabilityOf } from '../conv-model';

export function ConversationPane({
  sessionId,
  projectId,
  label,
  projectLabel,
  onClose,
  onOpenTerminal,
}: {
  sessionId: string;
  projectId: number;
  label: string;
  projectLabel: string;
  /** 关闭这扇 pane（对话头部按钮排最右）：给了才摆关闭按钮。 */
  onClose?: () => void;
  /** 头部终端按钮的落点（框架页 = 贴进本窗布局树）：给了才摆按钮。 */
  onOpenTerminal?: (instanceId: string) => void;
}) {
  const t = useT();
  const fb = useActionFeedback();
  const [caps, setCaps] = useState<{ capability: MessagingCapability; promptLimits: PromptLimits | null } | null>(
    null,
  );
  const [webInstance, setWebInstance] = useState<string | null>(null);
  const [pidAlive, setPidAlive] = useState<boolean | null>(null);
  /** 会话行已不存在（被清扫/删除）：弹窗独立挂载，没人替它退场——自己认领空态。 */
  const [sessionGone, setSessionGone] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .messagingCapabilities()
      .then((r) => {
        if (!alive) return;
        // 项目里同 harness 的能力行只有一份（矩阵按 harness 收敛）；拉不到就不
        // 渲染（对话面板自身对能力缺失有占位说明，不猜缺省）。
        const capability = r.capabilities[0] ?? null;
        if (capability) setCaps({ capability, promptLimits: r.promptLimits });
      })
      .catch(() => {});
    api
      .listSessions(projectId)
      .then((r) => {
        if (!alive) return;
        const row = r.sessions.find((s) => s.sessionId === sessionId);
        if (!row) setSessionGone(true);
        else {
          setWebInstance(row.webInstanceId ?? null);
          setPidAlive(row.pidAlive ?? null);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [projectId, sessionId]);

  /** 停止会话：与 TasksPanel 同一端点（interrupt 域归 server，帧域知识不重复）。 */
  const onInterrupt = useCallback(
    (sid: string): void => {
      void fb.run(
        `interrupt:${sid}`,
        async () => {
          await api.interruptSession(sid);
        },
        { fail: (e) => t('tasks.stopFail', { error: errorText(e) }) },
      );
    },
    [fb, t],
  );
  const interruptStateOf = useCallback((sid: string) => fb.stateOf(`interrupt:${sid}`), [fb]);

  if (!caps) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center gap-1.5 text-xs text-neutral-600">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('hooks.loading')}
      </div>
    );
  }

  if (sessionGone) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 text-xs text-neutral-600">
        <p>{t('tasks.paneSessionGone')}</p>
        <p className="text-10 text-neutral-700">{sessionId.slice(0, 8)}</p>
      </div>
    );
  }

  // 可用性照嵌入态同判据，但框架页只认 live（有活实例才贴得进来）：resume 要经
  // daemon 就地恢复，那条路在主窗——没活实例时置灰不摆假入口。
  const avail = webTerminalAvailabilityOf({
    webInstanceId: webInstance,
    pidAlive,
    transcriptPresent: null,
  });
  const webTerminal = onOpenTerminal
    ? {
        available: avail === 'live',
        reason: avail === 'busy' ? ('busy' as const) : avail === 'gone' ? ('gone' as const) : undefined,
        onOpen: () => webInstance && onOpenTerminal(webInstance),
      }
    : null;

  return (
    <SessionMessages
      embedded
      sessionId={sessionId}
      projectId={projectId}
      label={label}
      projectLabel={projectLabel}
      capability={caps.capability}
      promptLimits={caps.promptLimits}
      minimized={false}
      onInterrupt={onInterrupt}
      interruptStateOf={interruptStateOf}
      webTerminal={webTerminal}
      onClose={onClose}
      pane
    />
  );
}
