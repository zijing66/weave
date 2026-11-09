import { CollabScene } from './CollabScene';

/**
 * 教室（E4 语义收敛）：黑板皮肤 = 共用协同视图（CollabScene）的 classroom 变体。
 * 功能区块全在共用组件里，这里只声明皮肤。
 */
export function ClassroomScene({
  onOpenSession,
}: {
  onOpenSession: (projectId: number, sessionId: string) => void;
}) {
  return <CollabScene skin="classroom" onOpenSession={onOpenSession} />;
}
