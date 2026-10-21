import { randomUUID } from 'node:crypto';

/**
 * 合成会话登记表（主线程侧）：编排边级提取 fork 的无头回合会发 hook 事件
 * （实测 `--no-session-persistence` 只关转录落盘，hook 照发）——不登记的话
 * dashboard 会冒无转录的幽灵会话行。登记的 id 推给 inbox worker 过滤
 * （不落库、不建会话行）。
 */

const TTL_MS = 30 * 60_000;

const entries = new Map<string, number>();

/** 登记一枚合成会话 id（引擎 spawn fork 前调用；过 TTL 自动失效）。 */
export function registerSyntheticSession(sessionId = `sx-${randomUUID()}`): string {
  entries.set(sessionId, Date.now() + TTL_MS);
  return sessionId;
}

export function isSyntheticSession(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  const until = entries.get(sessionId);
  if (until === undefined) return false;
  if (until < Date.now()) {
    entries.delete(sessionId);
    return false;
  }
  return true;
}

/** 现役 id 快照（推给 worker 全量替换用；量小，全发省去增量协议）。 */
export function syntheticSessionIds(): string[] {
  return [...entries.keys()];
}

/** worker 侧全量替换（主线程 postMessage 过来的快照；worker 里没人调 register）。 */
export function replaceSyntheticSessions(ids: readonly string[]): void {
  entries.clear();
  for (const id of ids) entries.set(id, Date.now() + TTL_MS);
}
