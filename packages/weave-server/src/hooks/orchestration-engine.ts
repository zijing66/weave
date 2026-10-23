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
import { ORCH_MAX_DELIVERIES, ORCH_MAX_FORKS, validateOrchestration } from './orchestration-graph.js';

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
  /** 本 run 已烧的 fork 次数（condition/extract 的无头回合，token 成本闸）。 */
  forks: number;
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

/** 条件边的判断结果：ok = 放行投递；拦下时 reason 记进 RunEvent。 */
export interface ConditionDecision {
  ok: boolean;
  reason?: string;
}

/**
 * 条件边判断引擎：输入上游会话与放行条件，答放行还是拦下。引擎只认这个
 * 接口、不关心判断怎么做出来——缺省 = fork 子 Agent（createForkConditionJudge），
 * 装配侧注入 `conditionJudge` 即整体替换（决策模型等其他方案走这里）。
 */
export interface ConditionJudge {
  judge(input: {
    sessionId: string;
    condition: string;
    /** 上游这一轮最终输出（`{upstream}` 同源）；无会话上下文的判断方案用它。 */
    upstream: string | null;
  }): Promise<ConditionDecision>;
  /**
   * 批量判定（可选实现）：同一节点同一轮的多条条件边一次判定——fork 型引擎
   * 用它把 N 次 fork 合成 1 次（token 成本 ÷N）。缺省回落逐条 judge；返回
   * 数组与输入同序。抛错 = 整批按逐条回落。
   */
  judgeBatch?(input: {
    sessionId: string;
    /** 每条的判定键（引擎用它对回答案），condition 原文随行。 */
    items: { key: string; condition: string }[];
    upstream: string | null;
  }): Promise<ConditionDecision[]>;
}

/** 缺省判断引擎：对上游会话 fork 一次上下文子 Agent，只认 yes/no 回答。 */
export function createForkConditionJudge(deps: {
  supports(sessionId: string): boolean;
  extract(input: { sessionId: string; prompt: string }): Promise<string | null>;
}): ConditionJudge {
  const single = (verdict: boolean | null): ConditionDecision =>
    verdict === null
      ? {
          ok: false,
          reason: 'condition could not be evaluated (no clear yes/no answer) — delivery blocked',
        }
      : verdict
        ? { ok: true }
        : { ok: false, reason: 'condition answered no — delivery skipped' };
  return {
    async judge({ sessionId, condition }) {
      if (!deps.supports(sessionId)) {
        return {
          ok: false,
          reason: 'condition not evaluable — harness has no context sub-agent face',
        };
      }
      const answer = await deps.extract({
        sessionId,
        prompt: `${condition}\n\nBased on the conversation context above, answer with exactly one word: yes or no.`,
      });
      return single(parseConditionAnswer(answer));
    },
    // 批量：一次 fork 问全部（JSON 逐键答 yes/no）——N 条条件边的 token 成本 ÷N。
    // fork 自带会话上下文，upstream 只是兜底信号，这里不单独拼进 prompt。
    async judgeBatch({ sessionId, items }) {
      if (!deps.supports(sessionId)) {
        return items.map(() => ({
          ok: false,
          reason: 'condition not evaluable — harness has no context sub-agent face',
        }));
      }
      const lines = items
        .map((item, i) => `${i + 1}. key=${item.key}: ${item.condition}`)
        .join('\n');
      const answer = await deps.extract({
        sessionId,
        prompt: `For EACH item below, decide yes/no based on the conversation context.\n${lines}\n\nRespond with ONLY a JSON object mapping each key to true or false, e.g. {"k1":true,"k2":false}. No other text.`,
      });
      const parsed = parseBatchAnswer(answer, items.map((i) => i.key));
      if (!parsed) return items.map(() => single(null));
      return items.map((item) => {
        const verdict = parsed.get(item.key);
        if (verdict === undefined) return single(null);
        return single(verdict);
      });
    },
  };
}

/** 批量回答解析：首个 JSON 对象里逐键取布尔；缺键/解析失败 = null（整批判不出）。 */
function parseBatchAnswer(
  answer: string | null | undefined,
  keys: readonly string[],
): Map<string, boolean> | null {
  if (!answer) return null;
  const json = answer.match(/\{[\s\S]*\}/);
  if (!json) return null;
  try {
    const value = JSON.parse(json[0]) as Record<string, unknown>;
    const out = new Map<string, boolean>();
    for (const key of keys) {
      const v = value[key];
      if (typeof v !== 'boolean') return null;
      out.set(key, v);
    }
    return out;
  } catch {
    return null;
  }
}

/** when 预筛：关键词（逗号/换行/分号分隔）任一为文本的子串即命中（不区分大小写）。 */
export function matchWhen(when: string, text: string | null): boolean {
  const hay = (text ?? '').toLowerCase();
  return when
    .split(/[,，\n;；]/)
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0)
    .some((k) => hay.includes(k));
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

/**
 * 待回陈滞时限：目标活着但最老一条 pending 超过它仍无回合 → run 落 failed
 * （释放「同编排单 run」闸——不然一个挂死的会话让编排永久静默失能）。
 * 2 小时：正常 coding 回合（含长任务）远短于此；挂死/忘答的会话到此即弃。
 */
const PENDING_STALE_MS = 2 * 3_600_000;

export class OrchestrationEngine {
  private readonly runtime = new Map<number, Runtime>();
  /** ensureOpen 单飞：同一会话被多条边并发投递时只拉起一次。 */
  private readonly opening = new Map<
    string,
    Promise<{ ok: true; ack?: 'session-start' | 'registry' } | { ok: false; error: string }>
  >();
  /** 编排刚拉起的会话 → 时刻：首个回合结束不许被当成「自然回合」去触发别的编排。 */
  private readonly startedByOrchestration = new Map<string, number>();
  /** 缺省判断引擎（fork 子 Agent）；装配侧注入 conditionJudge 即整体替换。 */
  private readonly forkJudge: ConditionJudge;

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
      /**
       * 条件边判断引擎（占位）：缺省 = supportsExtract/extract 拼的 fork 子 Agent
       * 判断；注入即整体替换（决策模型等其他判断方案走这里）。
       */
      conditionJudge?: ConditionJudge;
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
  ) {
    this.forkJudge = createForkConditionJudge({
      supports: (sessionId) => deps.supportsExtract?.(sessionId) ?? false,
      extract: (input) => deps.extract?.(input) ?? Promise.resolve(null),
    });
  }

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
      forks: 0,
      inflight: 0,
      running: true,
      finishing: false,
    };
    this.runtime.set(rt.id, rt);
    this.emitRun(rt, 'running');
    await Promise.allSettled(
      chosen.map((entry) =>
        entry.kind === 'session'
          ? this.deliver(rt, {
              from: '',
              to: entry.id,
              edgeId: '',
              text: text?.trim() || orch.startText.trim() || orch.name,
            })
          : // webhook / trigger 入口：载荷随出边正文下发（不向入口本身投递）。
            this.fireEdges(rt, entry.id, text ?? ''),
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
   * 可自然触发节点（入口恒可 + autoFire 标记的中间节点）的自然回合 → 其出边
   * 直启（不走 start() 的首投：不再塞消息，`{upstream}` 就是这一轮的输出）。
   * 判据与护栏：编排 enabled、节点有出边（孤立节点不空转跑）、同编排无在飞
   * run、同节点 5s 冷却（Stop 与 SessionEnd 连拍不重复触发）。残余风险如实记：
   * 投递走投递器队列还没入 pending 的窗口里到达的 idle 会被误判成自然回合
   * （窗口毫秒级）。
   */
  private maybeAutoFire(sessionId: string): void {
    const now = Date.now();
    for (const orch of this.entryIndex().get(sessionId) ?? []) {
      if (!orch.enabled || this.activeOf(orch.id)) continue;
      const key = `${orch.id}:${sessionId}`;
      if (now - (this.lastAutoFireAt.get(key) ?? 0) < AUTO_FIRE_COOLDOWN_MS) continue;
      const node = orch.nodes.find((n) => n.id === sessionId && n.kind === 'session');
      if (!node || !orch.edges.some((edge) => edge.from === node.id)) continue;
      this.lastAutoFireAt.set(key, now);
      void this.fireFromEntry(orch, node.id);
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
      forks: 0,
      inflight: 0,
      running: true,
      finishing: false,
    };
    this.runtime.set(rt.id, rt);
    this.emitRun(rt, 'running');
    await this.fireEdges(rt, entryId);
    this.maybeDone(rt);
  }

  /** 可自然触发的节点 → 编排索引（TTL 缓存：定义变更 10s 内生效，别每个 idle 全表扫）。 */
  private entryIndexCache: { at: number; map: Map<string, OrchestrationRow[]> } | null = null;
  private lastAutoFireAt = new Map<string, number>();

  /**
   * 自然触发的节点资格：入口 session 恒可；中间 session 节点显式 `autoFire`
   * 才可（画布节点检查器开关）。webhook 节点永远不在列。
   */
  private entryIndex(): Map<string, OrchestrationRow[]> {
    if (this.entryIndexCache && Date.now() - this.entryIndexCache.at < ENTRY_INDEX_TTL_MS) {
      return this.entryIndexCache.map;
    }
    const map = new Map<string, OrchestrationRow[]>();
    for (const orch of this.deps.orchestrations.list()) {
      if (!orch.enabled) continue;
      const entries = new Set(
        graphDirections(orch.nodes, orch.edges).entries.map((n) => n.id),
      );
      for (const node of orch.nodes) {
        if (node.kind !== 'session') continue;
        if (!entries.has(node.id) && !node.autoFire) continue;
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
      const now = Date.now();
      for (const rt of [...this.runtime.values()]) {
        if (!rt.running) continue;
        for (const [sessionId, list] of Object.entries(rt.state.pending)) {
          if (list.length === 0) continue;
          const row = rows.get(sessionId);
          if (row && pidAliveOf(row, liveness) !== false) {
            // 活着但陈滞：最老一条待回超过时限 → 该会话的 pending 全部作废
            // （run 落 failed，释放「同编排单 run」闸——不然编排静默失能）。
            const oldest = Date.parse(list[0]!.at);
            if (Number.isFinite(oldest) && now - oldest > PENDING_STALE_MS) {
              this.staleOut(rt, sessionId, list[0]!.at);
              touched++;
            }
            continue;
          }
          void this.reviveOrDrop(rt, sessionId);
          touched++;
        }
      }
    } catch {
      return touched;
    }
    return touched;
  }

  /** pending 陈滞收尾：作废该会话全部待回并落 failed（原因带最老待回的时刻）。 */
  private staleOut(rt: Runtime, sessionId: string, oldestAt: string): void {
    const hours = ((Date.now() - Date.parse(oldestAt)) / 3_600_000).toFixed(1);
    this.dropPending(
      rt,
      sessionId,
      `pending stale ${hours}h (oldest ${oldestAt}) — target alive but never turned; run failed to release the single-run gate`,
    );
    this.finish(rt, 'failed', `pending stale on ${sessionId} (${hours}h) — run aborted`);
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
   * 条件边先整批判定（一次 fork 出全边路由，token ÷N），再按判定结果投递。
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

    // 条件边整批预判（非载荷路径）：when 预筛先裁掉一半，剩下的 condition 一次
    // 问完（judgeBatch；引擎没实现就逐条）。判定结果记进 verdicts，投递段只查表。
    const verdicts = new Map<string, boolean>();
    if (!payload) {
      const conditioned = edges.filter(
        (edge) =>
          edge.condition?.trim() &&
          !(edge.when?.trim() && !matchWhen(edge.when, upstream)),
      );
      if (conditioned.length > 0) {
        const judged = await this.evaluateConditionsBatch(rt, from, conditioned, upstream);
        for (const [edgeId, ok] of judged) verdicts.set(edgeId, ok);
      }
    }

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
        if (edge.extract?.trim() && this.takeFork(rt)) {
          summary = this.deps.supportsExtract?.(from)
            ? ((await this.deps.extract?.({ sessionId: from, prompt: edge.extract.trim() })) ?? null)
            : null;
        }
        // 文本预筛：{upstream}（文末总结）命中任一关键词才继续——费 token 的
        // condition fork 不做无谓功。不命中拦下（不 fork、不投）。
        if (edge.when?.trim() && !matchWhen(edge.when, upstream)) {
          this.record(rt, {
            from,
            to: edge.to,
            edgeId: edge.id,
            ok: false,
            stage: 'condition',
            error: 'pre-filter no match — upstream output lacks all keywords',
          });
          return;
        }
        // 放行条件：预判阶段已整批判定，这里只查表（不在表 = 预算耗尽没判成）。
        if (edge.condition?.trim()) {
          const verdict = verdicts.get(edge.id);
          if (verdict !== true) {
            if (verdict === undefined) {
              this.record(rt, {
                from,
                to: edge.to,
                edgeId: edge.id,
                ok: false,
                stage: 'condition',
                error: `fork budget exhausted (${ORCH_MAX_FORKS}) — condition not evaluated`,
              });
            }
            return;
          }
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
   * 条件边整批判定：judgeBatch（一次 fork 出全边路由）优先，引擎没实现或抛错
   * 回落逐条 judge。每条的结果（放行/拦下原因）都落 RunEvent；预算在批次入口
   * 一次扣（整批一个 fork 名额），到顶整批记预算原因。
   */
  private async evaluateConditionsBatch(
    rt: Runtime,
    from: string,
    edges: OrchestrationEdge[],
    upstream: string | null,
  ): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    const judge = this.deps.conditionJudge ?? this.forkJudge;
    if (!this.takeFork(rt)) {
      for (const edge of edges) {
        this.record(rt, {
          from,
          to: edge.to,
          edgeId: edge.id,
          ok: false,
          stage: 'condition',
          error: `fork budget exhausted (${ORCH_MAX_FORKS}) — condition not evaluated`,
        });
      }
      return out;
    }
    if (judge.judgeBatch && edges.length > 1) {
      try {
        const decisions = await judge.judgeBatch({
          sessionId: from,
          items: edges.map((edge) => ({ key: edge.id, condition: edge.condition!.trim() })),
          upstream,
        });
        edges.forEach((edge, i) => {
          const decision = decisions[i];
          if (!decision) return;
          out.set(edge.id, decision.ok);
          if (!decision.ok) {
            this.record(rt, {
              from,
              to: edge.to,
              edgeId: edge.id,
              ok: false,
              stage: 'condition',
              error: decision.reason ?? 'condition not satisfied — delivery blocked',
            });
          }
        });
        return out;
      } catch {
        // 批量失败回落逐条（下面统一走）
      }
    }
    for (const edge of edges) {
      out.set(edge.id, await this.evaluateCondition(rt, from, edge, upstream));
    }
    return out;
  }

  /**
   * 条件边的放行判断：委托 ConditionJudge（缺省 = fork 子 Agent，装配侧可注入
   * 其他决策方案）。放行才投；拦下（no / 判不出 / 判断引擎自己抛错）都记
   * `stage:'condition'` 事件——宁可不发错包。
   */
  private async evaluateCondition(
    rt: Runtime,
    from: string,
    edge: OrchestrationEdge,
    upstream: string | null,
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
    let decision: ConditionDecision;
    try {
      decision = await (this.deps.conditionJudge ?? this.forkJudge).judge({
        sessionId: from,
        condition: edge.condition!.trim(),
        upstream,
      });
    } catch (err) {
      return block(
        `condition judge failed — delivery blocked: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!decision.ok) return block(decision.reason ?? 'condition not satisfied — delivery blocked');
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

  /**
   * fork 预算闸：condition/extract 的无头回合都从这里领名额——到顶后不再烧
   * token（extract 回落 {upstream}、condition 拦下并记原因），run 不因此失败。
   */
  private takeFork(rt: Runtime): boolean {
    if (rt.forks >= ORCH_MAX_FORKS) return false;
    rt.forks++;
    return true;
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
