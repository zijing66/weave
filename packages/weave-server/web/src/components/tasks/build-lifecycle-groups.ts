import type { HookDispatch, HookEventRow } from '@/lib/api';
import { agentDispatchOf, parseDetail, taskNotificationOf } from '@/lib/hook-payload';
import type { HarnessLifecycle } from '@weavecode/core/harness';

/**
 * 任务分组（D7：prompt_id 精确归属 + 包夹启发式回落，零 schema）：
 * 升序 events + dispatches → groups[]。分组差异全经 lifecycle 表参数
 * （HARNESS_LIFECYCLE 镜像），不散落 source 判断；无 prompt_id 的旧数据
 * 走原包夹行为（存量用例零改）。
 */
export interface LifecycleGroup {
  /** pre-session（会话引导）/ turn:<开组事件id> / orphan（游离指令）。 */
  id: string;
  /** 开组 UserPromptSubmit 的 prompt（payload.raw.prompt；缺失省略）。 */
  prompt?: string;
  /** 开组事件的 prompt_id（并发归属锚——旧组等自己的 Stop 才结束）。 */
  promptId?: string;
  events: HookEventRow[];
  dispatches: HookDispatch[];
  /** 未正常结束：中断/会话尾关组（组头「未正常结束」徽标）。 */
  open?: boolean;
  /** 首 prompt 前散事件的「会话引导」伪组。 */
  preSession?: boolean;
  /** 组内 SubagentStop 计数（不独立成组，组头「子代理完成 ×n」）。 */
  subagentStops: number;
  /** 组内派发的异步子代理数（PostToolUse.toolResponse.agentId，组头「子代理 ×n」）。 */
  agentsDispatched: number;
  /** 组内阻塞式问答工具调用数（PreToolUse，组头「问答 ×n」）。 */
  questions: number;
}

export const PRE_SESSION_GROUP_ID = 'pre-session';
export const ORPHAN_GROUP_ID = 'orphan';

/**
 * 分组算法（D7 升级为 prompt_id 精确归属 + 包夹启发式回落）：
 * - **并发语义**：新 UserPromptSubmit 开新组但**不关旧组**——旧 turn 的 Stop
 *   按 prompt_id 晚到时精确关回自己的组（正常结束）；只有始终没有 Stop 的组
 *   才在收尾标「未正常结束」（用户提前提交 prompt 时旧组仍在执行的场景）。
 * - 无 prompt_id（旧数据/坏 payload）回落原包夹行为：事件挂 current→last→pre。
 * - 会话标记：带 current 自己 prompt_id 的（轮内自动压缩）不关组；其余按中断关。
 * - dispatch 仍按 eventId ∈ 组事件集归组；null/窗口外 → orphan 游离组。
 * - **task-notification 不开组**：UserPromptSubmit 携带 <task-notification>
 *   时按 tool-use-id/task-id 归回派发所在的组（子代理返回与原派发闭环，
 *   不产生独立的「通知 prompt」组）；匹配不到则回落 attach。
 */
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
  /** 已关闭（正常或中断）的组——收尾据此区分「等到了 Stop」与「未正常结束」。 */
  const closed = new Set<LifecycleGroup>();
  let pre: LifecycleGroup | null = null;
  let current: LifecycleGroup | null = null;
  let last: LifecycleGroup | null = null;
  /** prompt_id → 组（并发锚：Stop/事件按 pid 精确回组）。 */
  const byPid = new Map<string, LifecycleGroup>();
  /** 派发子代理证据 → 组（agentId / tool_use_id，task-notification 归组锚）。 */
  const byAgent = new Map<string, LifecycleGroup>();
  const byToolUse = new Map<string, LifecycleGroup>();

  const closeGroup = (group: LifecycleGroup, openEnded: boolean): void => {
    if (closed.has(group)) return;
    closed.add(group);
    if (openEnded) group.open = true;
    last = group;
    if (current === group) current = null;
  };

  /** 事件挂靠：pid 精确组（已关也归位保序）→ current → 最近关闭 → 引导组。 */
  const attach = (event: HookEventRow, pid: string | undefined): void => {
    const byPidGroup = pid ? byPid.get(pid) : undefined;
    const target = byPidGroup ?? current ?? last ?? pre;
    let g = target;
    if (!g) {
      g = pre = push({
        id: PRE_SESSION_GROUP_ID,
        events: [],
        dispatches: [],
        preSession: true,
        subagentStops: 0,
        agentsDispatched: 0,
        questions: 0,
      });
      closed.add(g); // 引导组不是 turn——收尾不标「未正常结束」
    }
    g.events.push(event);
    if (event.eventType === lifecycle.subagentStop) g.subagentStops++;
    // 问答工具按 PreToolUse 计一次（PostToolUse 配对，不重复计）。
    if (
      event.eventType === 'PreToolUse' &&
      lifecycle.questionTools.includes(parseDetail(event.payload).toolName ?? '')
    ) {
      g.questions++;
    }
    const ad = agentDispatchOf(event);
    if (ad) {
      g.agentsDispatched++;
      byAgent.set(ad.agentId, g);
      if (ad.toolUseId) byToolUse.set(ad.toolUseId, g);
    }
  };

  for (const event of events) {
    const type = event.eventType;
    const pid = extractPromptId(event.payload);
    if (type === lifecycle.open) {
      // 子代理返回通知：不是用户 prompt——归回派发所在组闭环，不开新组。
      const notif = taskNotificationOf(event);
      if (notif) {
        const target =
          (notif.toolUseId ? byToolUse.get(notif.toolUseId) : undefined) ??
          (notif.taskId ? byAgent.get(notif.taskId) : undefined);
        if (target) {
          target.events.push(event);
        } else {
          attach(event, pid); // 派发事件在窗口外：回落挂靠，仍不切组
        }
        continue;
      }
      // 同 prompt 重复开组事件（resume 补报）→ 续接原组；新 prompt → 开新组。
      // **不关旧组**：并发下旧 turn 还在执行，等它自己的 Stop 按 pid 关回。
      if (pid) {
        const existing = byPid.get(pid);
        if (existing) {
          current = existing;
          existing.events.push(event);
          continue;
        }
      }
      const group = push({
        id: `turn:${event.id}`,
        events: [],
        dispatches: [],
        subagentStops: 0,
        agentsDispatched: 0,
        questions: 0,
      });
      if (pid) {
        group.promptId = pid;
        byPid.set(pid, group);
      }
      current = group;
      const prompt = extractPrompt(event.payload);
      if (prompt !== undefined) group.prompt = prompt;
      group.events.push(event);
      continue;
    }
    if (lifecycle.close.includes(type)) {
      // Stop 归属：pid 精确关回自己的组（并发时可能早于 current）；无 pid 回落 current。
      const byPidGroup = pid ? byPid.get(pid) : undefined;
      const target = byPidGroup ?? current;
      if (target) {
        target.events.push(event);
        closeGroup(target, false); // 等到了自己的 Stop = 正常结束
      } else {
        attach(event, pid); // 游离 close（无开组）：挂靠不切组
      }
      continue;
    }
    if (lifecycle.sessionMarkers.includes(type)) {
      // 会话标记不切组。开着的 current 只在标记另有归属时按中断关组（① 的
      // SessionEnd 边界、中途 resume 的 SessionStart）——pid 事件仍精确归位。
      const byPidGroup = pid ? byPid.get(pid) : undefined;
      // 标记带着 current 自己的 prompt_id = **轮内标记**：claude 自动压缩的
      // SessionStart(source=compact) 就是这么来的，这轮还在跑，不是边界。
      // 判中断关组的话，晚到的 Stop 撞上已 closed 的组，徽标永远清不掉。
      const midTurn = byPidGroup !== undefined && byPidGroup === current;
      const target = byPidGroup ?? current;
      if (target) target.events.push(event);
      else attach(event, pid);
      if (!midTurn && current && !closed.has(current)) closeGroup(current, true);
      continue;
    }
    attach(event, pid); // ③ SubagentStop 在此入组计数，不独立成组
  }

  // 收尾：始终没等到 Stop 的组 = 未正常结束（并发旧组晚到的 Stop 已在循环内关）。
  for (const group of groups) {
    if (!closed.has(group)) {
      group.open = true;
      closed.add(group);
    }
  }

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
    orphan ??= push({
      id: ORPHAN_GROUP_ID,
      events: [],
      dispatches: [],
      subagentStops: 0,
      agentsDispatched: 0,
      questions: 0,
    });
    closed.add(orphan); // 游离组不是 turn——不标「未正常结束」
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

/** 事件的 prompt_id（raw.prompt_id——并发时事件/Stop 归属哪个 prompt 的锚）；
 *  旧数据/坏 payload 返回 undefined → 分组回落包夹启发式。 */
function extractPromptId(payload: string): string | undefined {
  try {
    const raw = (JSON.parse(payload) as { raw?: unknown }).raw;
    if (raw && typeof raw === 'object') {
      const pid = (raw as { prompt_id?: unknown }).prompt_id;
      if (typeof pid === 'string' && pid.length > 0) return pid;
    }
  } catch {
    // 坏 payload 不阻断分组
  }
  return undefined;
}
