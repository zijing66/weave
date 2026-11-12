import { randomUUID } from 'node:crypto';
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
import type { NotifyChannelRow } from '../repositories/notify-channels.js';
import { sendToChannel } from './notify-channels.js';
import { messagingSurfaceFor } from '../surfaces.js';
import { matchesMinute, minuteKey, parseCron } from '../daemon/cron.js';
import { pidAliveOf } from '../daemon/claude-liveness.js';
import { combinedLivenessOf } from '../daemon/liveness.js';
import type { HookEventBus } from './bus.js';
import type { MessageDeliverer } from './message-deliverer.js';
import { postJson, type WebhookResult } from './handlers/webhook.js';
import { renderTemplate } from './match.js';
import { ORCH_MAX_DELIVERIES, ORCH_MAX_FORKS, validateOrchestration } from './orchestration-graph.js';

export type StartResult =
  | { ok: true; runId: number }
  | { ok: false; status: 404 | 409; error: string };

/** 运行中的一份编排（定义在 start 时快照：跑的是触发那一刻的图）。 */
interface Runtime {
  id: number;
  orchestrationId: number;
  /** 所属项目（记忆出口写盘要把它映射回项目根——判定文本不变、只多这一枚键）。 */
  projectId: number;
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

/**
 * 判断证据的上限（when 预筛 + condition 判断共用；与边正文的 4000 分开账——
 * 决策模型的 state 是它唯一的证据，fork 之外看不见更多）。超限取头尾各半
 * （开头是背景、结尾是结论），截断量写进标记、RunEvent 的 detail 落注记，
 * 误判可诊断。实测本机 1217 条回合总结仅 1 条超此限。
 */
const JUDGE_UPSTREAM_MAX_CHARS = 32_000;

function judgeUpstreamOf(raw: string): { text: string; truncated: boolean } {
  if (raw.length <= JUDGE_UPSTREAM_MAX_CHARS) return { text: raw, truncated: false };
  const half = JUDGE_UPSTREAM_MAX_CHARS / 2;
  return {
    text: `${raw.slice(0, half)}\n…[weave: ${
      raw.length - JUDGE_UPSTREAM_MAX_CHARS
    } chars truncated]…\n${raw.slice(-half)}`,
    truncated: true,
  };
}

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

// 判断域已收敛进决策内核（decision-kernel.ts）：引擎与装配侧只从这里取类型与
// 缺省 fork 判断；编排的 when 预筛、ORCH_MAX_FORKS 预算与事件落痕仍在本域。
export type { ConditionDecision, ConditionJudge } from './decision-kernel.js';
export {
  parseConditionAnswer,
  createForkConditionJudge,
  createDecisionKernel,
  matchWhen,
  type DecisionModelTier,
  type EvalBatchItem,
  type EvalBatchOutcome,
} from './decision-kernel.js';
import {
  createDecisionKernel,
  matchWhen,
  type DecisionModelTier,
  type EvalBatchItem,
  type EvalBatchOutcome,
} from './decision-kernel.js';

/**
 * 边是否免于判断（when 快捷出口，2026-11-12 降权裁决）：仅当**配置了 when 且
 * 关键词命中**才免——证据已足，省一次模型/fork。不命中没有拦截权——条件边照
 * 常进判断链（模型主裁）；纯 when 边（无 condition）不命中维持旧拦截（用户
 * 配了 when 就是明示过滤意图）。无 when 的边走判断或直投，与本函数无关。
 */
function whenFastPathOf(edge: OrchestrationEdge, text: string | null): boolean {
  return !!edge.when?.trim() && matchWhen(edge.when, text);
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
/**
 * 待回陈滞时限：目标活着但最老一条 pending 超过它仍无回合 → run 落 failed
 * （释放「同编排单 run」闸——不然一个挂死的会话让编排永久静默失能）。
 * 2 小时：正常 coding 回合（含长任务）远短于此；挂死/忘答的会话到此即弃。
 */
const PENDING_STALE_MS = 2 * 3_600_000;

/** 投递失败的一次退避重试间隔（只重试投递动作失败，确定性失败不重试）。 */
const DELIVERY_RETRY_DELAY_MS = 1_500;

/**
 * 记忆出口的「值不值得留」判词（决策模型 noul 与组合 fork 都吃这一句）：拦下
 * 的意义是防流水账——常规进度、一次性回答不入记忆文件。
 */
const MEMORY_WORTH_CONDITION =
  'Does the delivery below contain a durable conclusion, decision, or constraint that future sessions working in this project must know? Answer yes only for lasting guidance - routine progress, transient status, or one-off replies are no';

/** 判决文本的兜底裁剪：站立规则不该长过这个量级（fork 提炼理应远短于此）。 */
const VERDICT_MAX_CHARS = 2_000;

/**
 * 人在场窗：目标闲着且最近这么久有过事件 = 用户在场 → 编排投递 defer（搭用户
 * 下一轮的车），防止层② 击键突袭手输中的输入框。超过窗口 = 无人值守，直投。
 */
const USER_PRESENT_WINDOW_MS = 90_000;

export class OrchestrationEngine {
  private readonly runtime = new Map<number, Runtime>();
  /** ensureOpen 单飞：同一会话被多条边并发投递时只拉起一次。 */
  private readonly opening = new Map<
    string,
    Promise<{ ok: true; ack?: 'session-start' | 'registry' } | { ok: false; error: string }>
  >();

  constructor(
    private readonly deps: {
      orchestrations: Pick<OrchestrationRepository, 'getById' | 'list' | 'setCronFired'>;
      runs: Pick<
        OrchestrationRunRepository,
        'insert' | 'listRunning' | 'updateState' | 'finish' | 'prune'
      >;
      deliverer: Pick<
        MessageDeliverer,
        'send' | 'registerInduction' | 'consumeInduction' | 'markCompleted'
      > &
        Partial<Pick<MessageDeliverer, 'awaitInboxReady' | 'lastTurnOutput' | 'pendingTextsOf'>>;
      sessions: Pick<SessionRepository, 'listWithCounts' | 'getBySessionId' | 'turnOpenOf'>;
      bus: HookEventBus;
      /** 上游会话是否支持 fork 提取（harness 无 extractArgs = false，边回落 {upstream}）。 */
      supportsExtract?: (sessionId: string) => boolean;
      /** 边级提取（装配侧 fork 无头回合实现）；null/拒绝 = 回落 {upstream}。 */
      extract?: (input: { sessionId: string; prompt: string }) => Promise<string | null>;
      /**
       * 判断三级链第一档（决策模型裸通道）：判提合一批量档的快裁层——配了它，
       * 强 yes/no 的条件不在 fork 烧 token；判不准/失败降级组合 fork。没配 = 全
       * 走 fork。单问语义的判断链（MCP / RPG）不经引擎，仍走 decision-judge。
       */
      decisionModel?: DecisionModelTier;
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
      /** 投递失败的重试间隔（测试注入）；缺省 DELIVERY_RETRY_DELAY_MS。 */
      retryDelayMs?: number;
      /**
       * 人在场闸（默认关）：开 = 目标闲着且用户近期在场时 defer 投递（搭用户
       * 下一轮的车），防层② 击键突袭手输中的输入框；关 = 恒直投（原语义）。
       */
      deferWhenUserPresent?: boolean;
      /** 出站 POST（测试注入）；缺省 handlers/webhook 的 postJson。 */
      postJsonImpl?: typeof postJson;
      /** 已登记提醒通道查询（webhook 出口选了 channelId 时用）；缺省 = 查无此通道。 */
      channelById?: (id: string) => Pick<NotifyChannelRow, 'kind' | 'config' | 'enabled'> | undefined;
      /** 通道发送（测试注入）；缺省 hooks/notify-channels 的 sendToChannel。 */
      sendToChannelImpl?: typeof sendToChannel;
      /**
       * 记忆出口的写盘面（装配侧 = memory-exit 的 deliverVerdict；缺省/缺线 =
       * 如实记失败）。判决落进该编排项目自己的记忆文件，逐 harness 接入面分发。
       */
      deliverVerdict?: (input: { projectId: number; text: string }) => Promise<{
        ok: boolean;
        files: string[];
        error?: string;
      }>;
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
    const { entries } = graphDirections(orch.nodes, orch.edges);
    const chosen = entryIds
      ? entries.filter((e) => entryIds.includes(e.id))
      : entries.filter((e) => e.kind === 'session');
    if (chosen.length === 0) {
      return { ok: false, status: 409, error: 'No matching entry node' };
    }
    // 并发分组（评审：Actions concurrency）：已有在跑 run 时不另起一份也不
    // 409 丢弃——把本次触发的首步并进在跑 run 的 pending（扇入语义本来就
    // 「每到一条执行一次」，多一条 pending 只是多一轮消费），runId 沿用在跑的。
    const active = this.activeOf(orchId);
    if (active) {
      await Promise.allSettled(
        chosen.map((entry) =>
          entry.kind === 'session'
            ? this.deliver(active, {
                from: '',
                to: entry.id,
                edgeId: '',
                text: text?.trim() || orch.startText.trim() || orch.name,
              })
            : this.fireEdges(active, entry.id, text ?? ''),
        ),
      );
      this.maybeDone(active);
      return { ok: true, runId: active.id };
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
      projectId: orch.projectId,
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
        const entry = pending.shift();
        this.persist(rt);
        // idle 消费那一拍顺手回写「已执行」到投递行（observer 字段，消息域不倒灌
        // 编排语义）：defer 占位的 `defer-` 发号在管道里查不到，markCompleted 自然
        // no-op——它承载的正文都还没真投出去，谈不上已执行。
        if (entry) this.deps.deliverer.markCompleted(entry.messageId);
        void this.fireEdges(rt, input.sessionId);
      }
      if (!orchestrationTurn) {
        // 诱导回合闸（登记咽喉在投递器 outbox 单点，一次性核销）：被编排投递/
        // 拉起诱导的会话，其首个收尾不是自然回合——无论隔多久（陈滞超窗的
        // 首轮同样不算，不再误判）。登记由投递侧写入，这里只消费。
        const induced = this.deps.deliverer.consumeInduction(input.sessionId);
        if (!induced) this.maybeAutoFire(input.sessionId);
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
   * （窗口毫秒级）。诱导回合闸走投递器的登记单点（一次性核销、无时间窗）——
   * 编排投递与拉起的会话首个收尾都不进这里。
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
      projectId: orch.projectId,
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

  /**
   * daemon 重启：进行中的 run **最小续跑**——从落库 state 重建 Runtime（pending
   * 原样保留，重启后目标会话的下一次回合照常消费推进）；定义已删/校验不过的
   * 才落 interrupted。state 每拍都落库，重建即无损（评审：agent 链以小时计，
   * 重启全丢太伤；不必 event sourcing）。
   */
  rearm(): void {
    try {
      for (const row of this.deps.runs.listRunning()) {
        const orch = this.deps.orchestrations.getById(row.orchestrationId);
        const valid = orch ? validateOrchestration(orch) : { ok: false as const };
        if (!valid.ok) {
          this.deps.runs.finish(row.id, 'interrupted', 'daemon restarted — definition gone');
          continue;
        }
        const rt: Runtime = {
          id: row.id,
          orchestrationId: row.orchestrationId,
          projectId: row.projectId,
          trigger: row.trigger,
          name: row.orchestrationName,
          nodes: orch!.nodes,
          edges: orch!.edges,
          state: row.state,
          deliveries: row.deliveries,
          forks: 0,
          inflight: 0,
          running: true,
          finishing: false,
        };
        this.runtime.set(rt.id, rt);
        this.emitRun(rt, 'running');
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
      const liveness = this.deps.livenessOf?.() ?? combinedLivenessOf();
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
    // 三本账统一后 carry 与判断证据同口径：32k 触顶头尾各半（不再「截前段加省略
    // 号」的半截硬裁——结尾是结论，丢了误下游）。扇入并置（见下方 judge 状态）。
    const upstream = rawUpstream ? judgeUpstreamOf(rawUpstream).text : null;
    // 扇入证据并置（2026-11-12 裁决）：fan-in 目标的出边判断不该只看单边上游——
    // 目标会话已送达、尚未消费的其余投递正文（deliverer 在途行）与当前边的
    // {upstream} 拼合成判断 state，多上游结论并置裁决；载荷入口（webhook）与
    // 无在途投递时不并置（判据自然回单边证据）。
    const fanIn = !payload ? (this.deps.deliverer.pendingTextsOf?.(from) ?? []) : [];
    const fanInOthers = fanIn.filter((t) => t !== rawUpstream);
    const judgeText =
      fanInOthers.length > 0
        ? [
            rawUpstream,
            `[weave: fan-in context — ${fanInOthers.length} other pending deliveries to this node]`,
            ...fanInOthers,
          ]
            .filter((part) => part != null)
            .join('\n\n')
        : rawUpstream;
    // 判断证据（when 快捷出口 + condition）用独立的宽预算：决策模型只看得到这份文本。
    const judgeUpstream = judgeText
      ? judgeUpstreamOf(judgeText)
      : { text: null as string | null, truncated: false };
    const session = this.deps.sessions.getBySessionId(from)?.title || from;

    // 判提合一（双形 fork，2026-11-12 批 2）：非载荷路径把本轮**全部**边的判断与
    // 提炼一次出齐——条件走三级链（决策模型快裁 → 组合 fork → 文本兜底），提炼
    // 与判断并批同一次组合 fork（模型放行的只提炼：prompt 无判断节；模型缺席/
    // 判不准的判提合一：一次 JSON 出 answers+briefs）。fork 预算闸经 forkGate 挂
    // 进内核（每次实际烧 fork 前过闸），不再逐边领名额。
    // 载荷路径（webhook/trigger 入口）没有会话可问，只有纯直投语义。
    const items: EvalBatchItem[] = [];
    if (!payload) {
      for (const edge of edges) {
        const fast = whenFastPathOf(edge, judgeUpstream.text);
        if (!fast && !edge.condition?.trim() && edge.when?.trim()) continue; // 纯 when 未命中：拦下，不烧 fork
        const condition = !fast && edge.condition?.trim() ? edge.condition.trim() : null;
        const summarize = edge.extract?.trim() || null;
        if (!condition && !summarize) continue;
        items.push({
          key: edge.id,
          ...(condition ? { condition } : {}),
          ...(summarize ? { summarize } : {}),
        });
      }
    }
    const outcomes = new Map<string, EvalBatchOutcome>();
    if (items.length > 0) {
      const batch = await this.kernelOf().evaluateBatch({
        sessionId: from,
        items,
        upstream: judgeUpstream.text,
        forkGate: () => this.takeFork(rt),
      });
      for (const [key, value] of batch) outcomes.set(key, value);
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
        // when 快捷出口（2026-11-12 降权裁决）：命中 = 证据已足、跳过判断直接
        // 放行（省一次模型/fork），不落 stage 事件。不命中时条件边照常进判断链；
        // 纯 when 边不命中维持旧拦截（配置 when 即明示过滤意图）。
        const fastPath = whenFastPathOf(edge, judgeUpstream.text);
        const outcome = outcomes.get(edge.id);
        if (!fastPath && edge.condition?.trim()) {
          // 放行与拦下都落痕：谁判的（model/fork/text）、依据、截断注记。
          this.record(rt, {
            from,
            to: edge.to,
            edgeId: edge.id,
            ok: outcome?.ok ?? false,
            stage: 'condition',
            ...(outcome?.ok
              ? {}
              : { error: outcome?.reason ?? 'condition not satisfied — delivery blocked' }),
            ...(outcome ? { source: outcome.source } : {}),
            ...this.conditionDetail(outcome?.detail, judgeUpstream.truncated),
          });
          if (!outcome?.ok) return;
        } else if (!fastPath && !edge.condition?.trim() && edge.when?.trim()) {
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
        const text = renderEdgeText(edge.text, {
          upstream,
          summary: outcome?.summary ?? upstream,
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


  /** 判断事件的 detail：判断依据 + 截断注记（有一样记一样，误判可诊断）。 */
  private conditionDetail(detail: string | undefined, truncated: boolean): { detail?: string } {
    const parts = [
      detail,
      truncated ? `state truncated to ${JUDGE_UPSTREAM_MAX_CHARS} chars` : null,
    ].filter(Boolean);
    return parts.length > 0 ? { detail: parts.join(' — ') } : {};
  }


  /**
   * 投一次（带一次退避重试）：session 目标判活（死则拉起并按需等 inbox 凭据）、
   * 送达（含入队）才计入待回；webhook 出口直接出站 POST、不判活不入 pending
   * （它不会回话）。返回是否真的送达（调用方据此决定要不要等它下一轮）。
   */
  private async deliver(
    rt: Runtime,
    input: { from: string; to: string; edgeId: string; text: string },
  ): Promise<boolean> {
    const first = await this.deliverOnce(rt, input);
    if (first || !rt.running) return first;
    // 瞬态故障（终端未就绪/中继抖动）一次退避重试——评审：失败即断支太脆。
    // 只重试「投递动作失败」，判死拉不起/正文空这类确定性失败不重试。
    await new Promise((resolve) => setTimeout(resolve, this.deps.retryDelayMs ?? DELIVERY_RETRY_DELAY_MS));
    if (!rt.running) return false;
    return this.deliverOnce(rt, input);
  }

  private async deliverOnce(
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
        const result = target.channelId
          ? await this.deliverViaChannel(target.channelId, rt, input)
          : await (this.deps.postJsonImpl ?? postJson)(target.url ?? '', target.secret, {
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
      if (target.kind === 'memory') {
        return this.deliverVerdictOnce(rt, input);
      }
      // 正文空：没有可送的东西，照样记一笔失败（不投空消息）。
      if (!input.text.trim()) {
        this.record(rt, { ...input, ok: false, error: 'edge has no message' });
        return false;
      }
      // 人在场闸（评审：层②击键直进输入框会打断手输的用户；默认关）：目标
      // 闲着且用户近期在场（刚看完/正要打字）→ 本拍不投，挂一条占位 pending
      // ——用户的下一次回合完成会消费它（届时再真投，搭车）；无人值守照常直投。
      // 返回 true（已处理）：不进重试、不计 deliveries。
      if (this.deps.deferWhenUserPresent && this.userPresent(input.to)) {
        const deferred = rt.state.pending[input.to] ?? [];
        deferred.push({ messageId: `defer-${randomUUID()}`, at: new Date().toISOString() });
        rt.state.pending[input.to] = deferred;
        this.record(rt, {
          from: input.from,
          to: input.to,
          edgeId: input.edgeId,
          ok: true,
          stage: 'defer',
        });
        return true;
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
        // 编排拉起（第二源）：登记走投递器的诱导登记单点（后续 send 成功会再
        // 登记一次，幂等——拉起成功但投递失败时这里兜底留下登记）。
        this.deps.deliverer.registerInduction(input.to);
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
        origin: 'orchestration',
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

  /**
   * 记忆出口（批 3，2026-11-12）：判提合一写**这个项目自己的**记忆文件——
   * 「值不值得留」廉闸（决策模型 P≤0.3 连 fork 都不烧；判不准走组合 fork 与
   * 判决文本一次出）拦下流水账，放行的产出站立规则文风判决经写盘面落
   * CLAUDE.local.md / AGENTS.md 认领区块。模型与 fork 都不在 = 不判，正文原样
   * 落盘（挂记忆节点本身就是要记）。拦下不是错误：记 stage:memory 落痕、
   * run 照常收尾；写盘失败才走投递重试那一次。
   */
  private async deliverVerdictOnce(
    rt: Runtime,
    input: { from: string; to: string; edgeId: string; text: string },
  ): Promise<boolean> {
    const text = input.text.trim();
    if (!text) {
      this.record(rt, { ...input, ok: false, error: 'memory exit has no content' });
      return false;
    }
    // 载荷型入口（webhook/trigger 直连记忆）没有上游会话可 fork——只剩决策
    // 模型快裁那一路；两条都不在就不判（见上：挂节点即意图）。
    const canJudge =
      this.deps.decisionModel != null ||
      (input.from ? (this.deps.supportsExtract?.(input.from) ?? false) : false);
    let verdict = text.slice(0, VERDICT_MAX_CHARS);
    if (canJudge) {
      const outcomes = await this.kernelOf().evaluateBatch({
        sessionId: input.from,
        items: [
          {
            key: input.to,
            condition: MEMORY_WORTH_CONDITION,
            summarize:
              `Distill the delivery below into one standing-rule verdict for this project's memory file: ` +
              `1-3 imperative lines, same language as the delivery, no dates or filler.\n\nDelivery:\n${text}`,
          },
        ],
        upstream: judgeUpstreamOf(text).text,
        forkGate: () => this.takeFork(rt),
      });
      if (!rt.running) return false;
      const outcome = outcomes.get(input.to);
      if (outcome && !outcome.ok) {
        rt.deliveries++;
        this.record(rt, {
          ...input,
          ok: true,
          stage: 'memory',
          ...(outcome.source ? { source: outcome.source } : {}),
          detail: outcome.detail ?? outcome.reason ?? 'verdict not worth keeping — skipped',
        });
        this.checkBudget(rt);
        return true;
      }
      if (outcome?.summary) verdict = outcome.summary.slice(0, VERDICT_MAX_CHARS);
    }
    const result = this.deps.deliverVerdict
      ? await this.deps.deliverVerdict({ projectId: rt.projectId, text: verdict })
      : { ok: false as const, files: [] as string[], error: 'memory exit not wired' };
    if (!rt.running) return false;
    rt.deliveries++;
    this.record(rt, {
      ...input,
      ok: result.ok,
      stage: 'memory',
      ...(result.ok
        ? {
            detail:
              result.files.join(', ') + (result.error ? ` — partial: ${result.error}` : ''),
          }
        : { error: result.error ?? 'verdict delivery failed' }),
    });
    this.checkBudget(rt);
    return result.ok;
  }

  /** 出口 webhook 选了已登记通道：查通道 → 按平台格式发（查无/禁用 = 失败，走重试一次）。 */
  private async deliverViaChannel(
    channelId: string,
    rt: Runtime,
    input: { from: string; to: string; edgeId: string; text: string },
  ): Promise<WebhookResult> {
    const channel = this.deps.channelById?.(channelId);
    if (!channel || !channel.enabled) {
      return { ok: false, status: 'failed', error: 'notify channel not found or disabled' };
    }
    return (this.deps.sendToChannelImpl ?? sendToChannel)(
      channel,
      { title: `weave · ${rt.name}`, body: input.text },
    );
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

  /** 判提合一内核（fireEdges 边级与记忆出口共用一个装法，fork 预算闸各自挂）。 */
  private kernelOf() {
    return createDecisionKernel({
      decisionModel: this.deps.decisionModel,
      fork: {
        supports: (sessionId) => this.deps.supportsExtract?.(sessionId) ?? false,
        extract: (input) => this.deps.extract?.(input) ?? Promise.resolve(null),
      },
    });
  }

  private record(
    rt: Runtime,
    input: {
      from: string;
      to: string;
      edgeId: string;
      ok: boolean;
      error?: string;
      stage?: 'ensure' | 'condition' | 'defer' | 'memory';
      ms?: number;
      source?: string;
      detail?: string;
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
      ...(input.source ? { source: input.source } : {}),
      ...(input.detail ? { detail: input.detail } : {}),
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
    // 判定/defer 事件的 ok 不算「有成功投递」（它们没投东西）——只有真投递计。
    const delivered = rt.state.events.some((event) => event.ok && event.stage === undefined);
    if (
      !delivered &&
      rt.state.events.length > 0 &&
      rt.state.events.every((e) => e.stage === 'condition')
    ) {
      // 每条出边都被条件拦下：判断按预期工作，不是失败——run 正常落定。
      this.finish(rt, 'done');
      return;
    }
    const lastError = [...rt.state.events].reverse().find((event) => !event.ok)?.error ?? null;
    this.finish(rt, delivered ? 'done' : 'failed', delivered ? null : (lastError ?? 'no delivery succeeded'));
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
    const liveness = this.deps.livenessOf?.() ?? combinedLivenessOf();
    return pidAliveOf(row, liveness);
  }

  /**
   * 人在场判据：目标闲着（回合已收）且最近 USER_PRESENT_WINDOW 内有过事件
   * （用户刚在看/正要打字）。回合开着不判在场——投递走队列/直投不扰回合；
   * 只挡「闲会话被层② 击键突袭」这一种打断。
   */
  private userPresent(sessionId: string): boolean {
    if (this.deps.sessions.turnOpenOf(sessionId)) return false;
    const row = this.deps.sessions.listWithCounts().find((r) => r.sessionId === sessionId);
    if (!row) return false;
    const seen = Date.parse(row.lastSeenAt);
    return Number.isFinite(seen) && Date.now() - seen < USER_PRESENT_WINDOW_MS;
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
