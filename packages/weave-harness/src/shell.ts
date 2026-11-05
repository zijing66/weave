import { HARNESS_SHELL_DISCARD_GRACE_MS, type Harness } from '@weavecode/core';

/** 判空壳只需要会话行的这几位（`listWithCounts` 派生）。 */
export interface ShellRow {
  sessionId: string;
  harness?: string | null;
  lastSeenAt: string;
  lastEventType?: string | null;
  eventCount?: number;
}

/**
 * 空壳会话（仅一条 SessionStart）是否已被宿主整个丢弃：一句没说就退出时宿主会
 * 把这个 id 整个丢开——不再发 SessionEnd，存活登记面也自清。于是「登记面查不到
 * 活着 + 已过豁免窗」就是再没有进程会以这个 id 发事件的证据，不必等满 1 小时
 * 无 prompt 保活期（用户原话：宿主那边会话没了，weave 的列表却还留着）。
 *
 * 与 `pidAliveOf` 的「空壳不判」不冲突：那是状态面不猜，这里只决定清扫时机。
 * 判据全部查表/查图，不认 harness 名：`HARNESS_SHELL_DISCARD_GRACE_MS` 为 null
 * 的 harness 没有可信登记面，一律不动。
 */
export function shellDiscardedByHost(
  row: ShellRow,
  liveness: Map<string, boolean>,
  now: number = Date.now(),
): boolean {
  const grace =
    row.harness != null ? HARNESS_SHELL_DISCARD_GRACE_MS[row.harness as Harness] : null;
  if (grace == null) return false;
  if (row.lastEventType !== 'SessionStart' || (row.eventCount ?? 0) > 1) return false;
  if (liveness.get(row.sessionId) === true) return false;
  const seen = Date.parse(row.lastSeenAt);
  return Number.isFinite(seen) && now - seen >= grace;
}
