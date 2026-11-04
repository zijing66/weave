import type { BackgroundTaskFact } from '@weavecode/harness';
import type { HookEventRepository } from '../repositories/hook-events.js';
import type { SessionRepository } from '../repositories/sessions.js';
import type { NormalizedHookPayload } from './types.js';

/**
 * 会话活动跟踪器（内存态状态机）：从 ingest 事件流派生「子 agent / 后台 shell /
 * 任务清单」的运行态账本，供对话头部活动行展示。文件面事实（subagents 目录、
 * tasks 目录、shell 输出文件）归 harness 的 activity 槽（surface），事件面归这里
 * ——两边在 `GET /sessions/:id/activity` 合账。
 *
 * 置位/翻转（状态机输入 = 归一化 payload）：
 * - PostToolUse(Agent) 带 isAsync+agentId → 子 agent 出生（running）；
 * - PostToolUse(Bash) 带 backgroundTaskId → 后台 shell 出生（running，command 取
 *   本次 toolInput.command——同帧就有，不必等 background_tasks 快照）；
 * - agent_id（子 agent 自身事件）→ 活性续期；
 * - Stop/SubagentStop 的 background_tasks 快照 → 整集对账（status 翻转权威）；
 * - SubagentStop 的 agent_id → 该子 agent completed；
 * - PreToolUse(TaskCreate/TaskUpdate) → 任务账（subject/activeForm/status 流水
 *   末态）。tasks 文件易失（宿主收尾清目录），事件账是唯一的兜底重建源。
 *
 * daemon 重启由 seedFromDb 按最近事件窗口重放重建。
 */

/** 一枚子 agent 的账（server 侧事件面；meta/description 由 surface 文件面补）。 */
export interface TrackedAgent {
  status: 'running' | 'completed';
  agentType?: string;
  description?: string;
  /** 最近一次相关事件时刻（ISO）。 */
  lastSeenAt: string;
}

export interface TrackedShell {
  taskId: string;
  status: string;
  command?: string;
  description?: string;
  lastSeenAt: string;
}

/** 事件账重建的任务条目（只有流水末态，没有 blocks/blockedBy——如实标注 source）。 */
export interface TrackedTask {
  taskId: string;
  subject?: string;
  activeForm?: string;
  status: string;
}

/** 状态机输入（handleIngestedRecords 逐条喂给；seedFromDb 重放同形）。 */
export interface ActivityEventInput {
  sessionId: string;
  payload: NormalizedHookPayload | null;
  /** Stop/SubagentStop 的 background_tasks 元数据（frameFacts 已提取的形状）。 */
  backgroundTasks?: BackgroundTaskFact[];
  /** PostToolUse(Bash) 的后台 shell 出生信号。 */
  bgShell?: { taskId: string };
}

export interface ActivityTrackerDeps {
  sessions: Pick<SessionRepository, 'list'>;
  hookEvents: Pick<HookEventRepository, 'listBySession' | 'listByTools'>;
}

/** seed 重放窗口（每会话最近事件条数：spawn→stop 之间事件少，窗口管住的是
 *  「最近一条带 background_tasks 的快照」与 TaskCreate/TaskUpdate 流水——50 够）。 */
const SEED_WINDOW = 50;

/** 事件账重建任务时 PreToolUse 工具调用数上限（TaskCreate/TaskUpdate 极少超此）。 */
const TASK_REPLAY_LIMIT = 200;

export class ActivityTracker {
  /** sessionId → agentId → 账。 */
  private readonly agents = new Map<string, Map<string, TrackedAgent>>();
  /** sessionId → taskId → 账。 */
  private readonly shells = new Map<string, Map<string, TrackedShell>>();
  /** sessionId → taskId → 任务账（TaskCreate/TaskUpdate 流水末态）。 */
  private readonly tasks = new Map<string, Map<string, TrackedTask>>();

  constructor(private readonly deps: ActivityTrackerDeps) {}

  /** ingest 主路径（也供 seed 重放）：一个事件推进状态机。 */
  onEvent(input: ActivityEventInput): void {
    const payload = input.payload;
    if (!payload) return;
    const sessionId = input.sessionId;
    const eventType = payload.eventType;
    const toolName = typeof payload.toolName === 'string' ? payload.toolName : null;
    const now = new Date().toISOString();

    // 子 agent 出生（Agent 工具异步返回）。
    if (eventType === 'PostToolUse' && toolName === 'Agent') {
      const resp = payload.toolResponse as { isAsync?: unknown; agentId?: unknown; description?: unknown } | null;
      if (resp?.isAsync && typeof resp.agentId === 'string') {
        this.agentMap(sessionId).set(resp.agentId, {
          status: 'running',
          ...(typeof resp.description === 'string' && resp.description
            ? { description: resp.description }
            : {}),
          lastSeenAt: now,
        });
      }
      return;
    }
    // 后台 shell 出生（Bash 异步返回），command 取同帧 toolInput。
    if (eventType === 'PostToolUse' && toolName === 'Bash') {
      if (input.bgShell) {
        const cmd =
          payload.toolInput && typeof payload.toolInput === 'object'
            ? (payload.toolInput as { command?: unknown }).command
            : undefined;
        const desc =
          payload.toolInput && typeof payload.toolInput === 'object'
            ? (payload.toolInput as { description?: unknown }).description
            : undefined;
        this.shellMap(sessionId).set(input.bgShell.taskId, {
          taskId: input.bgShell.taskId,
          status: 'running',
          ...(typeof cmd === 'string' && cmd ? { command: cmd } : {}),
          ...(typeof desc === 'string' && desc ? { description: desc } : {}),
          lastSeenAt: now,
        });
      }
      return;
    }
    // 子 agent 自身事件：活性续期。
    if (eventType !== 'Stop' && eventType !== 'SubagentStop') {
      const raw = payload.raw as { agent_id?: unknown } | null;
      const agentId = raw && typeof raw === 'object' && typeof raw.agent_id === 'string' ? raw.agent_id : null;
      if (agentId) {
        const map = this.agents.get(sessionId);
        const hit = map?.get(agentId);
        if (hit) hit.lastSeenAt = now;
      }
      // 任务清单：TaskCreate/TaskUpdate 的 toolInput 流水。
      if (eventType === 'PreToolUse' && (toolName === 'TaskCreate' || toolName === 'TaskUpdate')) {
        this.applyTaskEvent(sessionId, toolName, payload.toolInput);
      }
      return;
    }
    // 收尾族：SubagentStop 的 agent_id 翻 completed；background_tasks 快照整集对账。
    if (eventType === 'SubagentStop') {
      const raw = payload.raw as { agent_id?: unknown } | null;
      const agentId = raw && typeof raw === 'object' && typeof raw.agent_id === 'string' ? raw.agent_id : null;
      if (agentId) {
        const hit = this.agents.get(sessionId)?.get(agentId);
        if (hit) {
          hit.status = 'completed';
          hit.lastSeenAt = now;
        } else {
          // 快照滞后一拍的兜底：账上没有也记 completed（spawn 帧丢了也认它活过）。
          const rawAll = payload.raw as { agent_type?: unknown; last_assistant_message?: unknown } | null;
          this.agentMap(sessionId).set(agentId, {
            status: 'completed',
            ...(rawAll && typeof rawAll.agent_type === 'string' ? { agentType: rawAll.agent_type } : {}),
            lastSeenAt: now,
          });
        }
      }
    }
    if (input.backgroundTasks) this.reconcile(sessionId, input.backgroundTasks, now);
  }

  /** background_tasks 快照整集对账：running 的按 type 补/翻账，不在快照里的保持。 */
  private reconcile(sessionId: string, tasks: BackgroundTaskFact[], now: string): void {
    for (const task of tasks) {
      if (task.type === 'subagent') {
        const hit = this.agents.get(sessionId)?.get(task.id);
        if (hit) {
          hit.status = task.status === 'running' ? 'running' : hit.status;
          hit.lastSeenAt = now;
          if (task.description && !hit.description) hit.description = task.description;
          if (task.agentType && !hit.agentType) hit.agentType = task.agentType;
        } else {
          this.agentMap(sessionId).set(task.id, {
            status: task.status === 'running' ? 'running' : 'completed',
            ...(task.agentType ? { agentType: task.agentType } : {}),
            ...(task.description ? { description: task.description } : {}),
            lastSeenAt: now,
          });
        }
      } else if (task.type === 'shell') {
        const hit = this.shells.get(sessionId)?.get(task.id);
        if (hit) {
          hit.status = task.status;
          hit.lastSeenAt = now;
          if (task.description && !hit.description) hit.description = task.description;
          if (task.command && !hit.command) hit.command = task.command;
        } else {
          this.shellMap(sessionId).set(task.id, {
            taskId: task.id,
            status: task.status,
            ...(task.command ? { command: task.command } : {}),
            ...(task.description ? { description: task.description } : {}),
            lastSeenAt: now,
          });
        }
      }
    }
  }

  /** TaskCreate/TaskUpdate 的 toolInput 流水（末态权威）。 */
  private applyTaskEvent(sessionId: string, toolName: string, toolInput: unknown): void {
    const map = this.tasks.get(sessionId) ?? new Map<string, TrackedTask>();
    this.tasks.set(sessionId, map);
    const input = toolInput && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>) : {};
    if (toolName === 'TaskCreate') {
      const taskId = typeof input.taskId === 'string' ? input.taskId : null;
      if (!taskId) return;
      const prev = map.get(taskId);
      map.set(taskId, {
        taskId,
        ...(typeof input.subject === 'string' ? { subject: input.subject } : prev?.subject ? { subject: prev.subject } : {}),
        ...(typeof input.activeForm === 'string' ? { activeForm: input.activeForm } : prev?.activeForm ? { activeForm: prev.activeForm } : {}),
        status: typeof input.status === 'string' ? input.status : prev?.status ?? 'pending',
      });
      return;
    }
    // TaskUpdate：{taskId, status}（可能只带 status）。
    const taskId = typeof input.taskId === 'string' ? input.taskId : null;
    if (!taskId) return;
    const prev = map.get(taskId);
    map.set(taskId, {
      taskId,
      ...(prev?.subject ? { subject: prev.subject } : {}),
      ...(prev?.activeForm ? { activeForm: prev.activeForm } : {}),
      ...(typeof input.subject === 'string' ? { subject: input.subject } : {}),
      ...(typeof input.activeForm === 'string' ? { activeForm: input.activeForm } : {}),
      status: typeof input.status === 'string' ? input.status : prev?.status ?? 'pending',
    });
  }

  private agentMap(sessionId: string): Map<string, TrackedAgent> {
    const map = this.agents.get(sessionId) ?? new Map<string, TrackedAgent>();
    this.agents.set(sessionId, map);
    return map;
  }

  private shellMap(sessionId: string): Map<string, TrackedShell> {
    const map = this.shells.get(sessionId) ?? new Map<string, TrackedShell>();
    this.shells.set(sessionId, map);
    return map;
  }

  /** 某会话的子 agent 账（端点合账用）。 */
  agentsOf(sessionId: string): Map<string, TrackedAgent> {
    return this.agents.get(sessionId) ?? new Map();
  }

  /** 某会话的后台 shell 账。 */
  shellsOf(sessionId: string): Map<string, TrackedShell> {
    return this.shells.get(sessionId) ?? new Map();
  }

  /** 某会话的事件账任务（surface 的文件面 tasks 为 null 时的兜底）。 */
  tasksOf(sessionId: string): TrackedTask[] {
    return [...(this.tasks.get(sessionId)?.values() ?? [])];
  }

  /** daemon 重启重建：每会话重放最近事件窗口 + TaskCreate/TaskUpdate 全流水。 */
  seedFromDb(): void {
    for (const session of this.deps.sessions.list()) {
      for (const row of this.deps.hookEvents.listBySession(session.sessionId, SEED_WINDOW)) {
        let payload: NormalizedHookPayload | null = null;
        try {
          payload = JSON.parse(row.payload) as NormalizedHookPayload;
        } catch {
          payload = null;
        }
        const raw = payload?.raw as { background_tasks?: unknown } | null;
        const backgroundTasks = Array.isArray(raw?.background_tasks)
          ? (raw!.background_tasks as BackgroundTaskFact[]).filter(
              (x) => x && typeof x.id === 'string' && typeof x.status === 'string',
            )
          : undefined;
        this.onEvent({ sessionId: session.sessionId, payload, backgroundTasks });
      }
      // TaskCreate/TaskUpdate 流水按 id 正序重放（listByTools 倒序取，翻回来）。
      const rows = this.deps.hookEvents
        .listByTools(session.sessionId, ['TaskCreate', 'TaskUpdate'], null, TASK_REPLAY_LIMIT)
        .reverse();
      for (const row of rows) {
        let payload: NormalizedHookPayload | null = null;
        try {
          payload = JSON.parse(row.payload) as NormalizedHookPayload;
        } catch {
          payload = null;
        }
        this.onEvent({ sessionId: session.sessionId, payload });
      }
    }
  }

  /** 会话删除级联。 */
  forgetSession(sessionId: string): void {
    this.agents.delete(sessionId);
    this.shells.delete(sessionId);
    this.tasks.delete(sessionId);
  }
}
