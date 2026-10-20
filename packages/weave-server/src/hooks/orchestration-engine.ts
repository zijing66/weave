import type { Harness } from '@weavecode/core';
import type { MessagingSurface } from '@weavecode/harness';
import type {
  OrchestrationEdge,
  OrchestrationRepository,
  OrchestrationRunRepository,
  OrchestrationRunState,
  OrchestrationRunStatus,
  OrchestrationTrigger,
  RunEvent,
} from '../repositories/orchestrations.js';
import { pendingCountsOf } from '../repositories/orchestrations.js';
import type { SessionRepository } from '../repositories/sessions.js';
import { messagingSurfaceFor } from '../surfaces.js';
import { matchesMinute, minuteKey, parseCron } from '../daemon/cron.js';
import { claudeLivenessById, pidAliveOf } from '../daemon/claude-liveness.js';
import type { HookEventBus } from './bus.js';
import type { MessageDeliverer } from './message-deliverer.js';
import { ORCH_MAX_DELIVERIES, validateOrchestration } from './orchestration-graph.js';

export type StartResult =
  | { ok: true; runId: number }
  | { ok: false; status: 404 | 409; error: string };

/** 运行中的一份编排（定义在 start 时快照：跑的是触发那一刻的图）。 */
interface Runtime {
  id: number;
  orchestrationId: number;
  trigger: OrchestrationTrigger;
  startSessionId: string;
  startText: string;
  name: string;
  edges: OrchestrationEdge[];
  state: OrchestrationRunState;
  deliveries: number;
  inflight: number;
  running: boolean;
  /** 收尾只走一次（并发路径都能触发 maybeDone）。 */
  finishing: boolean;
}

/**
 * 跨会话编排引擎：有向图 + 消息传递推进。
 *
 * 语义：起点会话收第一条消息 → 它每完成一轮（harness idleSignals）消耗一条待回
 * 并把它所有出边各投递一次 → 目标每收一条消息被激活一次。无待回且无在飞即 done。
 * 成环由 POST/PUT 静态拒（validateOrchestration），运行时另有投递预算兜底。
 *
 * 状态：定义在 DB，运行态在内存（重启 → interrupted，不重发）；每次转场落一行日志。
 * 一切异常内部吞掉：编排失败永不影响采集与消息投递。
 */
export class OrchestrationEngine {
  private readonly runtime = new Map<number, Runtime>();

  constructor(
    private readonly deps: {
      orchestrations: Pick<OrchestrationRepository, 'getById' | 'list' | 'setCronFired'>;
      runs: Pick<
        OrchestrationRunRepository,
        'insert' | 'listRunning' | 'updateState' | 'finish' | 'prune'
      >;
      deliverer: Pick<MessageDeliverer, 'send'>;
      sessions: Pick<SessionRepository, 'listWithCounts'>;
      bus: HookEventBus;
      /** 目标会话判死时拉起终端（装配侧 = openSessionTerminal + 等注册表落名）。 */
      ensureOpen?: (sessionId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
      /** 能力面访问器（测试注入）；缺省 surfaces.ts 模块级 registry。 */
      surfaceFor?: (harness: Harness) => MessagingSurface;
      /** liveness 探测（测试注入）；缺省 claude 注册表全量扫描。 */
      livenessOf?: () => Map<string, boolean>;
      /** 投递预算（测试注入）；缺省 ORCH_MAX_DELIVERIES。 */
      maxDeliveries?: number;
    },
  ) {}

  /** 触发一次运行（手动 / webhook / cron 同一个入口）。 */
  async start(orchId: number, trigger: OrchestrationTrigger, text?: string): Promise<StartResult> {
    const orch = this.deps.orchestrations.getById(orchId);
    if (!orch) return { ok: false, status: 404, error: 'Orchestration not found' };
    const valid = validateOrchestration(orch);
    if (!valid.ok) return { ok: false, status: 409, error: valid.error };
    if (this.activeOf(orchId)) {
      return { ok: false, status: 409, error: 'Orchestration already has a running run' };
    }
    const row = this.deps.runs.insert({
      orchestrationId: orch.id,
      orchestrationName: orch.name,
      projectId: orch.projectId,
      trigger,
    });
    const rt: Runtime = {
      id: row.id,
      orchestrationId: orch.id,
      trigger,
      startSessionId: orch.startSessionId,
      startText: orch.startText,
      name: orch.name,
      edges: orch.edges,
      state: { pending: {}, events: [] },
      deliveries: 0,
      inflight: 0,
      running: true,
      finishing: false,
    };
    this.runtime.set(rt.id, rt);
    this.emitRun(rt, 'running');
    await this.deliver(rt, {
      from: '',
      to: orch.startSessionId,
      edgeId: '',
      text: text?.trim() || orch.startText.trim() || orch.name,
    });
    this.maybeDone(rt);
    return { ok: true, runId: rt.id };
  }

  cancel(runId: number): boolean {
    const rt = this.runtime.get(runId);
    return rt ? this.finish(rt, 'cancelled') : false;
  }

  /** ingest 消费路径的钩子（同 WatchEngine 形态）：永不 throw、只入队。 */
  onEvent(input: { sessionId: string; eventType: string; source: Harness }): void {
    try {
      const surface = this.deps.surfaceFor?.(input.source) ?? messagingSurfaceFor(input.source);
      if (!surface.idleSignals.includes(input.eventType)) return;
      for (const rt of [...this.runtime.values()]) {
        const pending = rt.state.pending[input.sessionId];
        if (!rt.running || !pending || pending.length === 0) continue;
        pending.shift();
        this.persist(rt);
        void this.fireEdges(rt, input.sessionId);
      }
    } catch {
      // 面缺席/库错误都不影响采集
    }
  }

  /** 定时触发（装配侧 30s 一枪）：同一编排同分钟只 fire 一次、跑着的跳过。 */
  cronTick(now: Date = new Date()): number {
    let fired = 0;
    try {
      const key = minuteKey(now);
      for (const orch of this.deps.orchestrations.list()) {
        if (!orch.cron || orch.lastCronAt === key) continue;
        const schedule = parseCron(orch.cron);
        if (!schedule || !matchesMinute(schedule, now)) continue;
        this.deps.orchestrations.setCronFired(orch.id, key);
        if (this.activeOf(orch.id)) continue;
        void this.start(orch.id, 'cron');
        fired++;
      }
    } catch {
      // 定时触发失败不影响下一拍
    }
    return fired;
  }

  /** daemon 重启：进行中的 run 一律 interrupted（不重发），顺手清一次日志。 */
  rearm(): void {
    try {
      for (const row of this.deps.runs.listRunning()) {
        this.deps.runs.finish(row.id, 'interrupted', 'daemon restarted — not resumed');
      }
    } catch {
      // 恢复失败留待下次
    }
    try {
      this.deps.runs.prune();
    } catch {
      // 清理失败不影响启动
    }
  }

  /** terminated 补射（挂 SessionSweeper 同 tick）：待回目标判死 → 复活或丢弃。 */
  sweepTerminated(): number {
    let touched = 0;
    try {
      const liveness = this.deps.livenessOf?.() ?? claudeLivenessById();
      const rows = new Map(this.deps.sessions.listWithCounts().map((r) => [r.sessionId, r] as const));
      for (const rt of [...this.runtime.values()]) {
        if (!rt.running) continue;
        for (const [sessionId, list] of Object.entries(rt.state.pending)) {
          if (list.length === 0) continue;
          const row = rows.get(sessionId);
          if (row && pidAliveOf(row, liveness) !== false) continue;
          void this.reviveOrDrop(rt, sessionId);
          touched++;
        }
      }
    } catch {
      return touched;
    }
    return touched;
  }

  private async reviveOrDrop(rt: Runtime, sessionId: string): Promise<void> {
    const opened = await this.ensureOpen(sessionId);
    if (opened.ok || !rt.running) return;
    this.dropPending(rt, sessionId, `pending dropped — session is not running: ${opened.error}`);
    this.maybeDone(rt);
  }

  private async fireEdges(rt: Runtime, from: string): Promise<void> {
    const edges = rt.edges.filter((edge) => edge.from === from);
    if (edges.length === 0) {
      this.maybeDone(rt);
      return;
    }
    await Promise.allSettled(
      edges.map((edge) => this.deliver(rt, { from, to: edge.to, edgeId: edge.id, text: edge.text })),
    );
    this.maybeDone(rt);
  }

  /** 投一次：判死先拉起会话；送达（含入队）才计入待回，失败只留日志。 */
  private async deliver(
    rt: Runtime,
    input: { from: string; to: string; edgeId: string; text: string },
  ): Promise<void> {
    rt.inflight++;
    try {
      if (!rt.running) return;
      if (this.aliveOf(input.to) === false) {
        const opened = await this.ensureOpen(input.to);
        if (!rt.running) return;
        if (!opened.ok) {
          this.record(rt, {
            ...input,
            ok: false,
            error: `target session is not open: ${opened.error}`,
          });
          return;
        }
      }
      const result = await this.deps.deliverer.send({
        toSessionId: input.to,
        text: input.text,
        mode: 'prompt',
        fromKind: 'dashboard',
      });
      if (!rt.running) return;
      if (!result.ok) {
        this.record(rt, { ...input, ok: false, error: result.error });
        return;
      }
      if (result.status === 'failed') {
        const msg = result.message;
        this.record(rt, {
          ...input,
          ok: false,
          error: msg.error ?? (msg.reason === 'offline' ? 'target session is offline' : 'delivery failed'),
        });
        return;
      }
      const pending = rt.state.pending[input.to] ?? [];
      pending.push({ messageId: result.messageId, at: new Date().toISOString() });
      rt.state.pending[input.to] = pending;
      rt.deliveries++;
      this.record(rt, { ...input, ok: true });
      if (rt.deliveries >= (this.deps.maxDeliveries ?? ORCH_MAX_DELIVERIES)) {
        this.finish(rt, 'failed', `delivery budget exceeded (${ORCH_MAX_DELIVERIES})`);
      }
    } catch (err) {
      this.record(rt, { ...input, ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      rt.inflight--;
    }
  }

  private record(
    rt: Runtime,
    input: { from: string; to: string; edgeId: string; ok: boolean; error?: string },
  ): void {
    if (!rt.running) return;
    const event: RunEvent = {
      at: new Date().toISOString(),
      from: input.from,
      to: input.to,
      edgeId: input.edgeId,
      ok: input.ok,
      ...(input.error ? { error: input.error } : {}),
    };
    rt.state.events.push(event);
    // 日志行内事件上限：长期跑的大图不把 state 撑爆（保留最近的）。
    if (rt.state.events.length > 200) rt.state.events.splice(0, rt.state.events.length - 200);
    this.persist(rt);
    this.deps.bus.emit({
      kind: 'orchestration.delivery',
      orchestrationId: rt.orchestrationId,
      runId: rt.id,
      edgeId: input.edgeId,
      from: input.from,
      to: input.to,
      ok: input.ok,
      ...(input.error ? { error: input.error } : {}),
      deliveries: rt.deliveries,
      pendingCounts: pendingCountsOf(rt.state),
      at: event.at,
    });
  }

  private maybeDone(rt: Runtime): void {
    if (!rt.running || rt.finishing || rt.inflight > 0) return;
    if (Object.values(rt.state.pending).some((list) => list.length > 0)) return;
    rt.finishing = true;
    const ok = rt.state.events.some((event) => event.ok);
    const lastError = [...rt.state.events].reverse().find((event) => !event.ok)?.error ?? null;
    this.finish(rt, ok ? 'done' : 'failed', ok ? null : (lastError ?? 'no delivery succeeded'));
  }

  private finish(rt: Runtime, status: Exclude<OrchestrationRunStatus, 'running'>, error: string | null = null): boolean {
    if (!rt.running) return false;
    rt.running = false;
    if (!this.deps.runs.finish(rt.id, status, error, rt.state)) return false;
    this.runtime.delete(rt.id);
    this.emitRun(rt, status);
    try {
      this.deps.runs.prune();
    } catch {
      // 清理失败不影响落定
    }
    return true;
  }

  private persist(rt: Runtime): void {
    this.deps.runs.updateState(rt.id, rt.state, rt.deliveries);
    this.emitRun(rt, 'running');
  }

  private emitRun(rt: Runtime, status: OrchestrationRunStatus): void {
    this.deps.bus.emit({
      kind: 'orchestration.run',
      orchestrationId: rt.orchestrationId,
      runId: rt.id,
      status,
      trigger: rt.trigger,
      deliveries: rt.deliveries,
      pendingCounts: pendingCountsOf(rt.state),
      at: new Date().toISOString(),
    });
  }

  private dropPending(rt: Runtime, sessionId: string, error: string): void {
    delete rt.state.pending[sessionId];
    this.record(rt, { from: '', to: sessionId, edgeId: '', ok: false, error });
  }

  private activeOf(orchId: number): Runtime | undefined {
    return [...this.runtime.values()].find((rt) => rt.running && rt.orchestrationId === orchId);
  }

  private aliveOf(sessionId: string): boolean | null {
    const row = this.deps.sessions.listWithCounts().find((r) => r.sessionId === sessionId);
    if (!row) return false;
    const liveness = this.deps.livenessOf?.() ?? claudeLivenessById();
    return pidAliveOf(row, liveness);
  }

  private async ensureOpen(sessionId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.deps.ensureOpen) return { ok: false, error: 'terminal auto-open unavailable' };
    try {
      return await this.deps.ensureOpen(sessionId);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
