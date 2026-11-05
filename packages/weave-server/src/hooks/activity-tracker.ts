import type { BackgroundTaskFact } from '@weavecode/harness';
import type { HookEventRepository } from '../repositories/hook-events.js';
import type { SessionRepository } from '../repositories/sessions.js';
import type { NormalizedHookPayload } from './types.js';

/**
 * 会话活动跟踪器（内存态状态机）：从 ingest 事件流派生「子 agent / 后台 shell」的
 * 运行态账本，供对话头部活动行展示。文件面事实（subagents 目录、tasks 目录、shell
 * 输出文件）归 harness 的 activity 槽（surface），事件面归这里——两边在
 * `GET /sessions/:id/activity` 合账。
 *
 * 存量口径 = 「当前还在的」（用户裁决：已移除的不显示，不管运行状态）：
 * - 子 agent 的存量由文件面（subagents 目录里的转录）决定，账只管状态；
 * - 后台 shell 没有文件面判据，账本只增不删：快照里没有的说明它结束了，
 *   翻 completed 交给前端收纳（已停止的仍要可查）。
 *
 * 置位/翻转（状态机输入 = 归一化 payload）：
 * - PostToolUse(Agent) 带 isAsync+agentId → 子 agent 出生（running，后台 agent）；
 * - SubagentStart 的 agent_id → 子 agent 出生（running，前台 agent 唯一的结构化信号）；
 * - PostToolUse(Bash) 带 backgroundTaskId → 后台 shell 出生（running，command 取
 *   本次 toolInput.command——同帧就有，不必等 background_tasks 快照）；
 * - agent_id（子 agent 自身事件）→ 活性续期；
 * - Stop/SubagentStop 的 background_tasks 快照 → 整集对账（status 翻转 + 存量权威）；
 * - SubagentStop 的 agent_id → 该子 agent completed。
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
  hookEvents: Pick<HookEventRepository, 'listBySession'>;
}

/** seed 重放窗口（每会话最近事件条数：spawn→stop 之间事件少，窗口管住的是
 *  「最近一条带 background_tasks 的快照」——50 够）。 */
const SEED_WINDOW = 50;

export class ActivityTracker {
  /** sessionId → agentId → 账。 */
  private readonly agents = new Map<string, Map<string, TrackedAgent>>();
  /** sessionId → taskId → 账。 */
  private readonly shells = new Map<string, Map<string, TrackedShell>>();

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
    // 子 agent 出生（SubagentStart）：前台的子 agent 没有 Agent 工具的 isAsync 回执，
    // 这条是唯一的结构化出生信号——不记就只能在收尾快照里第一次看见它。
    if (eventType === 'SubagentStart') {
      const raw = payload.raw as { agent_id?: unknown; agent_type?: unknown } | null;
      const agentId = raw && typeof raw === 'object' && typeof raw.agent_id === 'string' ? raw.agent_id : null;
      if (agentId) {
        const agentType = raw && typeof raw.agent_type === 'string' && raw.agent_type ? raw.agent_type : undefined;
        const hit = this.agents.get(sessionId)?.get(agentId);
        if (hit) {
          hit.status = 'running';
          hit.lastSeenAt = now;
          if (agentType && !hit.agentType) hit.agentType = agentType;
        } else {
          this.agentMap(sessionId).set(agentId, {
            status: 'running',
            ...(agentType ? { agentType } : {}),
            lastSeenAt: now,
          });
        }
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

  /** background_tasks 快照整集对账：按 type 补/翻账。 */
  private reconcile(sessionId: string, tasks: BackgroundTaskFact[], now: string): void {
    for (const task of tasks) {
      if (task.type === 'subagent') {
        const hit = this.agents.get(sessionId)?.get(task.id);
        if (hit) {
          // 快照说停 → 翻 completed；说 running → 已 completed 的不翻回去（快照滞后一拍）。
          if (task.status !== 'running') hit.status = 'completed';
          else if (hit.status !== 'completed') hit.status = 'running';
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
    // 快照 = 宿主此刻的后台任务列表：不在里面的 shell 已经结束了，翻 completed
    // 留给前端收纳（**不删账**——已停止的仍要可查），避免永远挂着 running。
    const shellMap = this.shells.get(sessionId);
    if (shellMap) {
      const alive = new Set(tasks.filter((t) => t.type === 'shell').map((t) => t.id));
      for (const [id, hit] of shellMap) if (!alive.has(id)) hit.status = 'completed';
    }
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

  /** daemon 重启重建：每会话重放最近事件窗口。 */
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
    }
  }

  /** 会话删除级联。 */
  forgetSession(sessionId: string): void {
    this.agents.delete(sessionId);
    this.shells.delete(sessionId);
  }
}
