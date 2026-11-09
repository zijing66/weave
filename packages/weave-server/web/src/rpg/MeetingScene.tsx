import { CollabScene } from './CollabScene';

/**
 * 会议室（E4 语义收敛）：大屏皮肤 = 共用协同视图（CollabScene）的 meeting 变体。
 * 功能区块全在共用组件里，这里只声明皮肤。
 */
export function MeetingScene({
  onOpenSession,
}: {
  onOpenSession: (projectId: number, sessionId: string) => void;
}) {
  return <CollabScene skin="meeting" onOpenSession={onOpenSession} />;
}
