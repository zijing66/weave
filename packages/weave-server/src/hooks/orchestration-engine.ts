import type { Harness } from '@weavecode/core';
import type { MessagingSurface } from '@weavecode/harness';
import type {
  OrchestrationEdge,
  OrchestrationNode,
  OrchestrationRepository,
  OrchestrationRow,
  OrchestrationRunRepository,
  OrchestrationRunState,
  OrchestrationRunStatus,
  OrchestrationTrigger,
  RunEvent,
} from '../repositories/orchestrations.js';
import { graphDirections, pendingCountsOf } from '../repositories/orchestrations.js';
import type { SessionRepository } from '../repositories/sessions.js';
import { messagingSurfaceFor } from '../surfaces.js';
import { matchesMinute, minuteKey, parseCron } from '../daemon/cron.js';
import { claudeLivenessById, pidAliveOf } from '../daemon/claude-liveness.js';
import type { HookEventBus } from './bus.js';
import type { MessageDeliverer } from './message-deliverer.js';
import { postJson } from './handlers/webhook.js';
import { renderTemplate } from './match.js';
import { ORCH_MAX_DELIVERIES, validateOrchestration } from './orchestration-graph.js';

export type StartResult =
  | { ok: true; runId: number }
  | { ok: false; status: 404 | 409; error: string };

/** 运行中的一份编排（定义在 start 时快照：跑的是触发那一刻的图）。 */
interface Runtime {
  id: number;
  orchestrationId: number;
  trigger: OrchestrationTrigger;
  name: string;
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
  state: OrchestrationRunState;
  deliveries: number;
  inflight: number;
  running: boolean;
  /** 收尾只走一次（并发路径都能触发 maybeDone）。 */
  finishing: boolean;
}

/**
 * 「到达前启动」后等 inbox 凭据的上限：会话起来到首个 hook 事件之间就几百毫秒
 * （冷启动 resume 慢些），等不到照旧回落中继/终端。
 */
const INBOX_READY_WAIT_MS = 5_000;

/** 边正文 + 附带的触发载荷（webhook 入口：正文可空 = 只转发载荷）。 */
function joined(text: string, carried: string): string {
  const head = text.trim();
  return head ? `${head}\n\n${carried}` : carried;
}

/** `{upstream}` 那段的上限（宿主上报的最终输出不受 capFields 约束，整段没意义）。 */
const CARRY_OUTPUT_MAX_CHARS = 4_000;

/** 边正文的模板变量（缺值占位原样保留 → 渲染后判残留，残留即失败）。 */
function renderEdgeText(
  template: string,
  vars: { upstream: string | null; summary: string | null; session: string },
): string {
  return renderTemplate(template, {
    upstream: vars.upstream,
    summary: vars.summary,
    session: vars.session,
  });
}

const UNRESOLVED_VAR = /\{(upstream|summary|session)\}/;

/** 条件边回答的认法：子 Agent 回答的首个词（中英都认），其余一律判不出。 */
const CONDITION_YES = new Set(['yes', 'y', 'true', '是', '对的', '对', '需要', '发']);
const CONDITION_NO = new Set(['no', 'n', 'false', '否', '不对', '不需要', '不发']);

export function parseConditionAnswer(answer: string | null | undefined): boolean | null {
  const first = (answer ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
  const word = first.replace(/[.。!！?？]/g, '');
  if (CONDITION_YES.has(word)) return true;
  if (CONDITION_NO.has(word)) return false;
  return null;
}

/** 自然回合自动触发的冷却：Stop 与 SessionEnd 连拍（同轮收尾两条 idle）不重复触发。 */
const AUTO_FIRE_COOLDOWN_MS = 5_000;
/** 入口 → 编排索引的缓存窗：定义变更最多这么久才被自然回合触发看到。 */
const ENTRY_INDEX_TTL_MS = 10_000;

/**
 * 跨会话编排引擎：有向图 + 消息传递推进。
 *
 * 语义：入口（无入边的节点，session 或 webhook）各自独立触发 → session 入口收
 * 首条消息，webhook 入口的载荷随出边正文下发 → 每个会话节点每完成一轮
 * （harness idleSignals）消耗一条待回并把它所有出边各投一次（扇入 = 每到一条
 * 执行一次，不等待其他前驱）。出口（无出边节点）若是 webhook 则出站 POST。
 * 中间节点只能是 session。成环由 POST/PUT 静态拒（validateOrchestration），
 * 运行时另有投递预算兜底。
 *
 * 状态：定义在 DB，运行态在内存（重启 → interrupted，不重发）；每次转场落一行日志。
 * 一切异常内部吞掉：编排失败永不影响采集与消息投递。
 */
/** 编排拉起的会话在这么久内的回合不算「自然回合」（覆盖冷启动 + 首轮）。 */
const STARTED_AUTO_FIRE_GUARD_MS = 60_000;

export class OrchestrationEngine {
  private readonly runtime = new Map<number, Runtime>();
  /** ensureOpen 单飞：同一会话被多条边并发投递时只拉起一次。 */
  private readonly opening = new Map<
    string,
    Promise<{ ok: true; ack?: 'session-start' | 'registry' } | { ok: false; error: string }>
  >();
  /** 编排刚拉起的会话 → 时刻：首个回合结束不许被当成「自然回合」去触发别的编排。 */
  private readonly startedByOrchestration = new Map<string, number>();

  constructor(
    private readonly deps: {
      orchestrations: Pick<OrchestrationRepository, 'getById' | 'list' | 'setCronFired'>;
      runs: Pick<
        OrchestrationRunRepository,
        'insert' | 'listRunning' | 'updateState' | 'finish' | 'prune'
      >;
      deliverer: Pick<MessageDeliverer, 'send'> &
        Partial<Pick<MessageDeliverer, 'awaitInboxReady' | 'lastTurnOutput'>>;
      sessions: Pick<SessionRepository, 'listWithCounts' | 'getBySessionId'>;
      bus: HookEventBus;
      /** 上游会话是否支持 fork 提取（harness 无 extractArgs = false，边回落 {upstream}）。 */
      supportsExtract?: (sessionId: string) => boolean;
      /** 边级提取（装配侧 fork 无头回合实现）；null/拒绝 = 回落 {upstream}。 */
      extract?: (input: { sessionId: string; prompt: string }) => Promise<string | null>;
      /** 目标会话判死时拉起终端（装配侧 = openSessionTerminal + 等回执）。
       *  `ack` 说明回执来源（`session-start` = 宿主真进了会话，`registry` = 只见到进程）。 */
      ensureOpen?: (
        sessionId: string,
      ) => Promise<{ ok: true; ack?: 'session-start' | 'registry' } | { ok: false; error: string }>;
      /** 能力面访问器（测试注入）；缺省 surfaces.ts 模块级 registry。 */
      surfaceFor?: (harness: Harness) => MessagingSurface;
      /** liveness 探测（测试注入）；缺省 claude 注册表全量扫描。 */
      livenessOf?: () => Map<string, boolean>;
      /** 投递预算（测试注入）；缺省 ORCH_MAX_DELIVERIES。 */
      maxDeliveries?: number;
      /** 出站 POST（测试注入）；缺省 handlers/webhook 的 postJson。 */
      postJsonImpl?: typeof postJson;
    },
  ) {}

  /**
   * 触发一次运行。`entryIds` 缺省 = 全部 session 入口（cron 语义）；显式给 =
   * 只跑这些入口（手动多选 / webhook 单入口）。载荷 `text` 投给选中的 session
   * 入口，并随 webhook 入口的出边正文下发。
   */
  async start(
    orchId: number,
    trigger: OrchestrationTrigger,
    text?: string,
    entryIds?: readonly string[],
  ): Promise<StartResult> {
    const orch = this.deps.orchestrations.getById(orchId);
    if (!orch) return { ok: false, status: 404, error: 'Orchestration not found' };
    const valid = validateOrchestration(orch);
    if (!valid.ok) return { ok: false, status: 409, error: valid.error };
    if (this.activeOf(orchId)) {
      return { ok: false, status: 409, error: 'Orchestration already has a running run' };
    }
    const { entries } = graphDirections(orch.nodes, orch.edges);
    const chosen = entryIds
      ? entries.filter((e) => entryIds.includes(e.id))
      : entries.filter((e) => e.kind === 'session');
    if (chosen.length === 0) {
      return { ok: false, status: 409, error: 'No matching entry node' };
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
      name: orch.name,
      nodes: orch.nodes,
      edges: orch.edges,
      state: { pending: {}, events: [] },
      deliveries: 0,
      inflight: 0,
      running: true,
      finishing: false,
    };
    this.runtime.set(rt.id, rt);
    this.emitRun(rt, 'running');
    await Promise.allSettled(
      chosen.map((entry) =>
        entry.kind === 'webhook'
          ? this.fireEdges(rt, entry.id, text ?? '')
          : this.deliver(rt, {
              from: '',
              to: entry.id,
              edgeId: '',
              text: text?.trim() || orch.startText.trim() || orch.name,
            }),
      ),
    );
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
      // 「编排回合」判据取**消费前**快照：这一轮若是任何编排投出来的，各 run 的
      // pending 都会在这同一拍被消费掉，消费后再判就永远是「自然回合」了。
      const orchestrationTurn = this.hasPendingAnywhere(input.sessionId);
      for (const rt of [...this.runtime.values()]) {
        const pending = rt.state.pending[input.sessionId];
        if (!rt.running || !pending || pending.length === 0) continue;
        pending.shift();
        this.persist(rt);
        void this.fireEdges(rt, input.sessionId);
      }
      if (!orchestrationTurn) {
        const now = Date.now();
        const startedAt = this.startedByOrchestration.get(input.sessionId);
        if (startedAt !== undefined && now - startedAt < STARTED_AUTO_FIRE_GUARD_MS) {
          // 编排刚拉起来的会话：它的首个回合并不能算「自然回合」
          this.startedByOrchestration.delete(input.sessionId);
        } else {
          this.startedByOrchestration.delete(input.sessionId);
          this.maybeAutoFire(input.sessionId);
        }
      }
    } catch {
      // 面缺席/库错误都不影响采集
    }
  }

  /** 任何在跑 run 对该会话还有未消费的投递 ⇒ 这一轮是编排/投递驱动的，不是自然回合。 */
  private hasPendingAnywhere(sessionId: string): boolean {
    return [...this.runtime.values()].some(
      (rt) => (rt.state.pending[sessionId]?.length ?? 0) > 0,
    );
  }

  /**
   * 入口会话的自然回合 → 该入口的下游直启（不走 start() 的首投：不向入口再塞
   * 消息，`{upstream}` 就是这一轮的输出）。判据与护栏：编排 enabled、入口有出边
   * （孤立入口的平凡编排不空转跑）、同编排无在飞 run、同入口 5s 冷却（Stop 与
   * SessionEnd 连拍不重复触发）。残余风险如实记：投递走投递器队列还没入 pending
   * 的窗口里到达的 idle 会被误判成自然回合（窗口毫秒级）。
   */
  private maybeAutoFire(sessionId: string): void {
    const now = Date.now();
    for (const orch of this.entryIndex().get(sessionId) ?? []) {
      if (!orch.enabled || this.activeOf(orch.id)) continue;
      const key = `${orch.id}:${sessionId}`;
      if (now - (this.lastAutoFireAt.get(key) ?? 0) < AUTO_FIRE_COOLDOWN_MS) continue;
      const { entries } = graphDirections(orch.nodes, orch.edges);
      const entry = entries.find((e) => e.id === sessionId);
      if (!entry || !orch.edges.some((edge) => edge.from === entry.id)) continue;
      this.lastAutoFireAt.set(key, now);
      void this.fireFromEntry(orch, entry.id);
    }
  }

  /** 入口会话的自然回合直启一份 run（快照语义与 start() 相同，只是跳过首投）。 */
  private async fireFromEntry(orch: {
    id: number;
    name: string;
    projectId: number;
    nodes: OrchestrationNode[];
    edges: OrchestrationEdge[];
  }, entryId: string): Promise<void> {
    const valid = validateOrchestration(orch);
    if (!valid.ok) return;
    const row = this.deps.runs.insert({
      orchestrationId: orch.id,
      orchestrationName: orch.name,
      projectId: orch.projectId,
      trigger: 'manual',
    });
    const rt: Runtime = {
      id: row.id,
      orchestrationId: orch.id,
      trigger: 'manual',
      name: orch.name,
      nodes: orch.nodes,
      edges: orch.edges,
      state: { pending: {}, events: [] },
      deliveries: 0,
      inflight: 0,
      running: true,
      finishing: false,
    };
    this.runtime.set(rt.id, rt);
    this.emitRun(rt, 'running');
    await this.fireEdges(rt, entryId);
    this.maybeDone(rt);
  }

  /** 入口 → 编排索引（TTL 缓存：定义变更 10s 内生效，别每个 idle 全表扫）。 */
  private entryIndexCache: { at: number; map: Map<string, OrchestrationRow[]> } | null = null;
  private lastAutoFireAt = new Map<string, number>();

  private entryIndex(): Map<string, OrchestrationRow[]> {
    if (this.entryIndexCache && Date.now() - this.entryIndexCache.at < ENTRY_INDEX_TTL_MS) {
      return this.entryIndexCache.map;
    }
    const map = new Map<string, OrchestrationRow[]>();
    for (const orch of this.deps.orchestrations.list()) {
      if (!orch.enabled) continue;
      for (const node of graphDirections(orch.nodes, orch.edges).entries) {
        if (node.kind !== 'session') continue;
        const list = map.get(node.id) ?? [];
        list.push(orch);
        map.set(node.id, list);
      }
    }
    this.entryIndexCache = { at: Date.now(), map };
    return map;
  }

  /** 定时触发（装配侧 30s 一枪）：同一编排同分钟只 fire 一次、跑着的跳过。 */
  cronTick(now: Date = new Date()): number {
    let fired = 0;
    try {
      const key = minuteKey(now);
      for (const orch of this.deps.orchestrations.list()) {
        if (!orch.enabled || !orch.cron || orch.lastCronAt === key) continue;
        const schedule = parseCron(orch.cron);
        if (!schedule || !matchesMinute(schedule, now)) continue;
        // cron 只驱动 session 入口；webhook-only 的编排没有可定时的入口。
        const { entries } = graphDirections(orch.nodes, orch.edges);
        if (!entries.some((e) => e.kind === 'session')) continue;
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

  /** ensureOpen 单飞：并发的多条边/多个 run 对同一会话只拉起一次。 */
  private ensureOpenOnce(
    sessionId: string,
  ): Promise<{ ok: true; ack?: 'session-start' | 'registry' } | { ok: false; error: string }> {
    const existing = this.opening.get(sessionId);
    if (existing) return existing;
    const task = (
      this.deps.ensureOpen?.(sessionId) ??
      Promise.resolve({ ok: true } as { ok: true; ack?: 'session-start' | 'registry' })
    ).finally(() => this.opening.delete(sessionId));
    this.opening.set(sessionId, task);
    return task;
  }

  private async reviveOrDrop(rt: Runtime, sessionId: string): Promise<void> {
    const opened = await this.ensureOpen(sessionId);
    if (opened.ok || !rt.running) return;
    this.dropPending(rt, sessionId, `pending dropped — session is not running: ${opened.error}`);
    this.maybeDone(rt);
  }

  /**
   * fan-out：把 `from` 的所有出边各投一次。每条边先渲染变量——`{upstream}` =
   * 上游这一轮最终输出（webhook 入口 = 触发载荷），`{summary}` = 按边的提取指令
   * fork 出的结果（失败回落 `{upstream}`，都没有则占位残留 → 记失败不投），
   * `{session}` = 上游会话名。webhook 入口的载荷直接拼在正文后（不渲染）。
   */
  private async fireEdges(rt: Runtime, from: string, payload = ''): Promise<void> {
    const edges = rt.edges.filter((edge) => edge.from === from);
    if (edges.length === 0) {
      this.maybeDone(rt);
      return;
    }
    const rawUpstream = payload || (this.deps.deliverer.lastTurnOutput?.(from)?.output ?? null);
    const upstream = rawUpstream
      ? rawUpstream.length > CARRY_OUTPUT_MAX_CHARS
        ? `${rawUpstream.slice(0, CARRY_OUTPUT_MAX_CHARS)}…`
        : rawUpstream
      : null;
    const session = this.deps.sessions.getBySessionId(from)?.title || from;
    await Promise.allSettled(
      edges.map(async (edge) => {
        if (payload) {
          // webhook 入口：{upstream} = 触发载荷；模板没引用它就把载荷拼在正文后
          // （载荷不静默丢弃），正文空 = 只转发载荷。
          const rendered = renderEdgeText(edge.text, {
            upstream: payload,
            summary: payload,
            session: from,
          });
          const text = edge.text.includes('{upstream}')
            ? rendered
            : joined(rendered, payload);
          return this.deliver(rt, { from, to: edge.to, edgeId: edge.id, text });
        }
        let summary: string | null = null;
        if (edge.extract?.trim()) {
          summary = this.deps.supportsExtract?.(from)
            ? ((await this.deps.extract?.({ sessionId: from, prompt: edge.extract.trim() })) ?? null)
            : null;
        }
        // 放行条件：问上游会话的上下文子 Agent，只认 yes/no；no 或判不出都拦下。
        if (edge.condition?.trim()) {
          const verdict = await this.evaluateCondition(rt, from, edge);
          if (!verdict) return;
        }
        const text = renderEdgeText(edge.text, {
          upstream,
          summary: summary ?? upstream,
          session,
        });
        if (UNRESOLVED_VAR.test(text)) {
          this.record(rt, {
            from,
            to: edge.to,
            edgeId: edge.id,
            ok: false,
            error: 'unresolved template variable — no upstream output and no extract result',
          });
          return;
        }
        return this.deliver(rt, { from, to: edge.to, edgeId: edge.id, text });
      }),
    );
    this.maybeDone(rt);
  }

  /**
   * 条件边的放行判断：对上游会话跑一次上下文子 Agent（能力面，claude = fork），
   * 提问要求严格回答 yes/no。yes = 放行；no = 拦下；判不出（回答不认、超时、
   * fork 失败、harness 无此能力面）= 拦下——宁可不发错包，原因都记 RunEvent。
   */
  private async evaluateCondition(
    rt: Runtime,
    from: string,
    edge: OrchestrationEdge,
  ): Promise<boolean> {
    const block = (reason: string): false => {
      this.record(rt, {
        from,
        to: edge.to,
        edgeId: edge.id,
        ok: false,
        stage: 'condition',
        error: reason,
      });
      return false;
    };
    if (!this.deps.supportsExtract?.(from)) {
      return block('condition not evaluable — harness has no context sub-agent face');
    }
    const answer = await this.deps.extract?.({
      sessionId: from,
      prompt: `${edge.condition!.trim()}\n\nBased on the conversation context above, answer with exactly one word: yes or no.`,
    });
    const verdict = parseConditionAnswer(answer);
    if (verdict === null) {
      return block('condition could not be evaluated (no clear yes/no answer) — delivery blocked');
    }
    if (!verdict) return block('condition answered no — delivery skipped');
    return true;
  }

  /**
   * 投一次：session 目标判活（死则拉起并按需等 inbox 凭据）、送达（含入队）才
   * 计入待回；webhook 出口直接出站 POST、不判活不入 pending（它不会回话）。
   * 返回是否真的送达（调用方据此决定要不要等它下一轮）。
   */
  private async deliver(
    rt: Runtime,
    input: { from: string; to: string; edgeId: string; text: string },
  ): Promise<boolean> {
    rt.inflight++;
    try {
      if (!rt.running) return false;
      const target = rt.nodes.find((n) => n.id === input.to);
      if (!target) {
        this.record(rt, { ...input, ok: false, error: 'target node is not in the snapshot' });
        return false;
      }
      if (target.kind === 'webhook') {
        const result = await (this.deps.postJsonImpl ?? postJson)(target.url ?? '', target.secret, {
          orchestrationName: rt.name,
          runId: rt.id,
          from: input.from,
          text: input.text,
          at: new Date().toISOString(),
        });
        if (!rt.running) return false;
        rt.deliveries++;
        this.record(rt, { ...input, ok: result.ok, ...(result.ok ? {} : { error: result.error }) });
        this.checkBudget(rt);
        return result.ok;
      }
      // 正文空：没有可送的东西，照样记一笔失败（不投空消息）。
      if (!input.text.trim()) {
        this.record(rt, { ...input, ok: false, error: 'edge has no message' });
        return false;
      }
      if (this.aliveOf(input.to) === false) {
        const begun = Date.now();
        const opened = await this.ensureOpenOnce(input.to);
        if (!rt.running) return false;
        // 拉起是独立的一步：成功/失败都单独落一条事件（stage=ensure），画布能看见
        this.record(rt, {
          from: '',
          to: input.to,
          edgeId: input.edgeId,
          ok: opened.ok,
          stage: 'ensure',
          ms: Date.now() - begun,
          ...(opened.ok ? {} : { error: opened.error }),
        });
        if (!opened.ok) {
          this.record(rt, {
            ...input,
            ok: false,
            error: `target session is not open: ${opened.error}`,
          });
          return false;
        }
        this.startedByOrchestration.set(input.to, Date.now());
        // 刚从冷启动拉起来的会话：凭据随它的首个 hook 事件才上报，而层①-a 直投
        // 比中继快三个数量级（86ms vs 一个 headless 子进程）——值得等这一小会儿。
        // 等不到只是回落，不挡投递。
        await this.deps.deliverer.awaitInboxReady?.(input.to, INBOX_READY_WAIT_MS);
        if (!rt.running) return false;
      }
      const result = await this.deps.deliverer.send({
        toSessionId: input.to,
        text: input.text,
        mode: 'prompt',
        fromKind: 'dashboard',
      });
      if (!rt.running) return false;
      if (!result.ok) {
        this.record(rt, { ...input, ok: false, error: result.error });
        return false;
      }
      if (result.status === 'failed') {
        const msg = result.message;
        this.record(rt, {
          ...input,
          ok: false,
          error: msg.error ?? (msg.reason === 'offline' ? 'target session is offline' : 'delivery failed'),
        });
        return false;
      }
      const pending = rt.state.pending[input.to] ?? [];
      pending.push({ messageId: result.messageId, at: new Date().toISOString() });
      rt.state.pending[input.to] = pending;
      rt.deliveries++;
      this.record(rt, { ...input, ok: true });
      this.checkBudget(rt);
      return true;
    } catch (err) {
      this.record(rt, { ...input, ok: false, error: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      rt.inflight--;
    }
  }

  /** 投递预算：到顶即 failed（环路兜底）。 */
  private checkBudget(rt: Runtime): void {
    if (rt.deliveries >= (this.deps.maxDeliveries ?? ORCH_MAX_DELIVERIES)) {
      this.finish(rt, 'failed', `delivery budget exceeded (${ORCH_MAX_DELIVERIES})`);
    }
  }

  private record(
    rt: Runtime,
    input: {
      from: string;
      to: string;
      edgeId: string;
      ok: boolean;
      error?: string;
      stage?: 'ensure' | 'condition';
      ms?: number;
    },
  ): void {
    if (!rt.running) return;
    const event: RunEvent = {
      at: new Date().toISOString(),
      from: input.from,
      to: input.to,
      edgeId: input.edgeId,
      ok: input.ok,
      ...(input.error ? { error: input.error } : {}),
      ...(input.stage ? { stage: input.stage } : {}),
      ...(input.ms === undefined ? {} : { ms: input.ms }),
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
    if (!ok && rt.state.events.length > 0 && rt.state.events.every((e) => e.stage === 'condition')) {
      // 每条出边都被条件拦下：判断按预期工作，不是失败——run 正常落定。
      this.finish(rt, 'done');
      return;
    }
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
