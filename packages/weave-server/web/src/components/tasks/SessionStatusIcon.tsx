import { cn } from '@/lib/utils';
import { STATUS_DOT, type SessionStatus } from './session-status';
import { HarnessIcon } from './HarnessIcon';

/**
 * 会话状态图标（唯一渲染点）：运行中 = harness 跑马灯动效，打开 = 同 harness
 * 静态形，失败/关闭 = 状态点。会话行、项目行徽标、全局总览共用同一份判断。
 */
export function SessionStatusIcon({
  status,
  harness,
}: {
  status: SessionStatus;
  harness?: 'claude' | 'codex' | null;
}) {
  if (status === 'running' || status === 'open') {
    return <HarnessIcon harness={harness} running={status === 'running'} />;
  }
  return <span className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_DOT[status])} />;
}
