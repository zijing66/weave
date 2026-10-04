import type { HookDispatch, HookEventRow } from '@/lib/api';
import type { HarnessLifecycle } from '@weave/core/harness';

/**
 * 任务分组（D7 纯启发式，零 schema）：升序 events + dispatches → groups[]。
 * 分组差异全经 lifecycle 表参数（HARNESS_LIFECYCLE 镜像），不散落 source 判断；
 * 组内事件链批 6 复用 buildSessionChain（输入换单组切片，零改动）。
 */
export interface LifecycleGroup {
  /** pre-session（会话引导）/ turn:<开组事件id> / orphan（游离指令）。 */
  id: string;
  /** 开组 UserPromptSubmit 的 prompt（payload.raw.prompt；缺失省略）。 */
  prompt?: string;
  events: HookEventRow[];
  dispatches: HookDispatch[];
  /** 未正常结束：中断/会话尾关组（组头「未正常结束」徽标）。 */
  open?: boolean;
  /** 首 prompt 前散事件的「会话引导」伪组。 */
  preSession?: boolean;
  /** 组内 SubagentStop 计数（不独立成组，组头「子代理完成 ×n」）。 */
  subagentStops: number;
}

export const PRE_SESSION_GROUP_ID = 'pre-session';
export const ORPHAN_GROUP_ID = 'orphan';

export function buildLifecycleGroups(
  events: HookEventRow[],
  dispatches: HookDispatch[],
  lifecycle: HarnessLifecycle,
): LifecycleGroup[] {
  const groups: LifecycleGroup[] = [];
  const push = (group: LifecycleGroup): LifecycleGroup => {
    groups.push(group);
    return group;
  };
  let pre: LifecycleGroup | null = null;
  let current: LifecycleGroup | null = null;
  let last: LifecycleGroup | null = null;

  const closeCurrent = (openEnded: boolean): void => {
    if (!current) return;
    if (openEnded) current.open = true;
    last = current;
    current = null;
  };

  /** 无边界可依的事件挂靠：开组中→组内；已关→上一组尾；首 prompt 前→引导伪组。 */
  const attach = (event: HookEventRow): void => {
    let target = current ?? last;
    if (!target) {
      if (!pre) {
        pre = push({ id: PRE_SESSION_GROUP_ID, events: [], dispatches: [], preSession: true, subagentStops: 0 });
      }
      target = pre;
    }
    target.events.push(event);
    if (event.eventType === lifecycle.subagentStop) target.subagentStops++;
  };

  for (const event of events) {
    const type = event.eventType;
    if (type === lifecycle.open) {
      // ① 遇下个开组事件：中断组先关（open:true），再开新 turn 组
      closeCurrent(true);
      current = push({ id: `turn:${event.id}`, events: [], dispatches: [], subagentStops: 0 });
      const prompt = extractPrompt(event.payload);
      if (prompt !== undefined) current.prompt = prompt;
      current.events.push(event);
      continue;
    }
    if (lifecycle.close.includes(type)) {
      if (current) {
        current.events.push(event);
        closeCurrent(false); // 正常结束
      } else {
        attach(event); // 游离 close（无开组）：挂靠不切组
      }
      continue;
    }
    if (lifecycle.sessionMarkers.includes(type)) {
      // ⑤ 标记本身不切组；open 组遇标记按中断关组（① 的 SessionEnd 边界，中途 resume 同理）
      if (current) {
        current.events.push(event);
        closeCurrent(true);
      } else {
        attach(event);
      }
      continue;
    }
    attach(event); // ③ SubagentStop 在此入组计数，不独立成组
  }
  closeCurrent(true); // ① 事件尾：仍开的组按中断关组

  // ④ dispatch 按 eventId ∈ 组内事件集归组
  const groupByEvent = new Map<number, LifecycleGroup>();
  for (const group of groups) {
    for (const event of group.events) groupByEvent.set(event.id, group);
  }
  let orphan: LifecycleGroup | null = null;
  for (const dispatch of dispatches) {
    const target = dispatch.eventId != null ? groupByEvent.get(dispatch.eventId) : undefined;
    if (target) {
      target.dispatches.push(dispatch);
      continue;
    }
    // eventId 缺失（手工 resume）或事件不在窗口（最新窗口截断）→ 游离组单列
    orphan ??= push({ id: ORPHAN_GROUP_ID, events: [], dispatches: [], subagentStops: 0 });
    orphan.dispatches.push(dispatch);
  }

  return groups;
}

/** UserPromptSubmit 原文 prompt（归一化 payload 的 raw.prompt，即 agent stdin）；坏 JSON/缺失返回 undefined。 */
function extractPrompt(payload: string): string | undefined {
  try {
    const raw = (JSON.parse(payload) as { raw?: unknown }).raw;
    if (raw && typeof raw === 'object') {
      const prompt = (raw as { prompt?: unknown }).prompt;
      if (typeof prompt === 'string' && prompt.length > 0) return prompt;
    }
  } catch {
    // 坏 payload 不阻断分组
  }
  return undefined;
}
