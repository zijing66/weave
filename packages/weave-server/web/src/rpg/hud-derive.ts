import type { SessionRow } from '@/lib/api';

/**
 * HUD 派生（G2.5 三件套的取数纯函数）：HomeConsole / CollabScene / RoomScene
 * 都有同形的 `latestSessionOf`——HUD 不复制三份，收在这里一处（纯函数非抽象，
 * 既有三处本波不动，避免越界重构）。
 */
export function latestSessionOf(
  projectId: number,
  sessionById: ReadonlyMap<string, SessionRow>,
): SessionRow | undefined {
  let best: SessionRow | undefined;
  for (const s of sessionById.values()) {
    if (s.projectId !== projectId) continue;
    if (!best || s.createdAt > best.createdAt) best = s;
  }
  return best;
}
