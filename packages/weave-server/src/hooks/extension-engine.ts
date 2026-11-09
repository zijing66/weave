import type { Harness } from '@weavecode/core';
import { HARNESS_LIFECYCLE } from '@weavecode/core';
import type { MessagingSurface } from '@weavecode/harness';
import { turnOutputOf } from '@weavecode/harness';
import type {
  ExtensionBindingRepository,
  ExtensionBindingRow,
  ExtensionEndpoint,
  ExtensionExecutionRepository,
  ExtensionStage,
} from '../repositories/extension-bindings.js';
import type { HookEventRepository } from '../repositories/hook-events.js';
import type { SessionRepository } from '../repositories/sessions.js';
import { messagingSurfaceFor } from '../surfaces.js';
import type { HookBusMessage, HookEventBus } from './bus.js';
import type { MessageDeliverer } from './message-deliverer.js';
import { postJson } from './handlers/webhook.js';
import { renderTemplate } from './match.js';
import type { DecisionKernel } from './decision-kernel.js';

/**
 * 会话扩展点引擎（L1 绑定域，批 2b 瘦身版）：`turn-end` / `idle` 两点 ×
 * `session` / `webhook` 两端点。ingest 消费链上的第五消费者（与 watch /
 * orchestration 平行，fire-and-forget、内部全吞——hooks 非阻塞不变式）。
 *
 * 绑定求值走**叠加作用域**（项目级 + 会话级各自独立、互不抑制）与**内存索引**
 * （照 HookRuleRegistry 先例：变更后 reload 全量重载，不逐事件查库）。执行是
 * **无状态单拍管线**——无 pending、无跨回合状态、无可续跑的运行态。
 *
 * daemon 不可用时事件不丢（L0 文件轴兜底），恢复随 ingest 回放自然补执行；
 * 陈旧闸把回放中超龄事件记 `skipped:stale`，防恢复风暴把过期回合的
 * 「决策并总结」全放出去。幂等去重（partial index 查重）兜「端点已发、
 * 日志未落」窗口崩溃后的重复扇出。
 *
 * 两点与事件名一律经表取，不散写：`turn-end` = `HARNESS_LIFECYCLE[<harness>].close`、
 * `idle` = `MessagingSurface.idleSignals`。同一会话同拍双命中（claude 的 Stop 同时
 * 是 turn-end 与 idle 信号）时是**两个独立绑定**各自的执行，冷却闸按「绑定×会话」计。
 */

/** 冷却：每绑定×会话 5s（Stop 与 SessionEnd 连拍不重复执行）。对齐编排 AUTO_FIRE_COOLDOWN_MS。 */
const COOLDOWN_MS = 5_000;

/** 每绑定日执行上限（内存计数，UTC 日界；超记 skipped:capped）。 */
const DAILY_EXECUTION_CAP = 200;

/** 单次执行的端点预算（超记 failed，不投半截）。 */
const MAX_ENDPOINTS = 8;

/** 陈旧闸缺省窗（settings `extensions.staleMs` 可配）。 */
export const DEFAULT_EXTENSION_STALE_MS = 10 * 60_000;

/** daemon 内同时在跑的扩展执行上限（对齐 plugin 槽 4 / EdgeExtract 4）。 */
const MAX_CONCURRENT = 4;

/** 失败告警：同绑定连续 N 次 failed → 提醒三腿发一条。 */
const FAILURE_ALERT_STREAK = 3;

/** upstream 的上限（对齐编排 CARRY_OUTPUT_MAX_CHARS——宿主整段总结不进模板）。 */
const UPSTREAM_MAX_CHARS = 4_000;

/** `{summary}` / `{upstream}` 占位残留判据：渲染后仍在 = 没值可填（不投半截模板）。 */
const UNRESOLVED_VAR = /\{(upstream|summary|session)\}/;

/** 一次事件触发的入参（onEvent 带 payload——tool-failed 的错误摘要只在 payload 里）。 */
export interface ExtensionEventInput {
  sessionId: string;
  source: Harness;
  eventType: string;
  eventId: number;
  projectId: number;
  /** 解析后的归一化载荷（帧域没有这些；工具错误摘要、last_assistant_message 都在这）。 */
  payload: unknown;
  /** 事件真实时刻（ISO）；缺省 = 当下。回放/补采的历史行靠它过陈旧闸。 */
  at?: string;
}

export class ExtensionEngine {
  /** point → (projectId, sessionId|null) 启用绑定（内存索引；变更后 reload）。 */
  private byPoint = new Map<string, ExtensionBindingRow[]>();
  /** 冷却（绑定×会话）与日计数（绑定×UTC 日）。 */
  private readonly lastFiredAt = new Map<string, number>();
  private readonly dayCounts = new Map<number, { day: string; n: number }>();
  /** 同绑定连续 failed 计数（失败告警闸）。 */
  private readonly failStreak = new Map<number, number>();
  /** 同绑定前一拍在跑标记（忙跳过：不排队）。 */
  private readonly busy = new Set<number>();
  /** 在飞执行数（全局并发闸）。 */
  private inflight = 0;
  /** 陈旧窗（settings 可配；构造注入，读侧已在装配处现读现效）。 */
  private staleMs: number;

  constructor(
    private readonly deps: {
      bindings: ExtensionBindingRepository;
      executions: ExtensionExecutionRepository;
      deliverer: Pick<MessageDeliverer, 'send' | 'registerInduction' | 'consumeInduction'> &
        Partial<Pick<MessageDeliverer, 'lastTurnOutput'>>;
      sessions: Pick<SessionRepository, 'getBySessionId'>;
      hookEvents: Pick<HookEventRepository, 'listBySession'>;
      bus: HookEventBus;
      /** 决策内核（批 1 已建：condition → judge、summarize → evaluate 组合 fork）。 */
      kernel: Pick<DecisionKernel, 'judge' | 'evaluate'>;
      /** 上游会话是否支持 fork 提取（harness 无 extractArgs = false，evaluate 内判）。 */
      supportsExtract?: (sessionId: string) => boolean;
      /** 能力面访问器（测试注入）；缺省 surfaces.ts 模块级 registry。 */
      surfaceFor?: (harness: Harness) => MessagingSurface;
      /** 陈旧窗（毫秒）；缺省 DEFAULT_EXTENSION_STALE_MS。 */
      staleMs?: number;
      /** 出站 POST（测试注入）；缺省 handlers/webhook 的 postJson。 */
      postJsonImpl?: typeof postJson;
      /** 失败告警的会话名（提醒措辞用）；缺省取 sessionId 前 8 位。 */
      labelOf?: (sessionId: string) => string;
    },
  ) {
    this.staleMs = deps.staleMs ?? DEFAULT_EXTENSION_STALE_MS;
    this.reload();
  }

  /** settings 变更后更新陈旧窗（现读现效，不重启）。 */
  setStaleMs(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) this.staleMs = ms;
  }

  /** 绑定集变更后的全量重载（CRUD 路由调用；照 HookRuleRegistry.load 先例）。 */
  reload(): void {
    this.byPoint = new Map();
    for (const binding of this.deps.bindings.list()) {
      if (!binding.enabled) continue;
      const bucket = this.byPoint.get(binding.point) ?? [];
      bucket.push(binding);
      this.byPoint.set(binding.point, bucket);
    }
  }

  /**
   * dry-run（§1.6 测试台，批 3）：对一条绑定发一次**合成执行**——走与真实执行
   * 同一条管线（upstream 回查 → when 预筛 → 决策内核），但**不真扇出端点**：
   * 端点只渲染载荷与判幂等，落一行 `trigger:'dry-run'` 的执行日志（与真实行
   * 同表同形，SSE `extension.execution` 帧照发）。「会投出什么」由此可验，
   * 不开公开 HTTP 面、不烧目标会话。
   * 合成输入 = 会话最近一条回合输出（`lastTurnOutput`，与执行期同源）； eventId=0
   * 不进幂等账（partial index 只记真实投递，dry-run 的 delivered 行不顶掉真执行）。
   */
  async dryRun(
    bindingId: number,
    sessionId: string,
    opts: { upstream?: string | null } = {},
  ): Promise<{ ok: boolean; stages: Array<{ stage: ExtensionStage; ok: boolean | null; error: string | null; endpointKind: string | null; endpointTarget: string | null; source: string | null; detail: string | null; at: string }> }> {
    const binding = this.deps.bindings.getById(bindingId);
    const stages: Array<{ stage: ExtensionStage; ok: boolean | null; error: string | null; endpointKind: string | null; endpointTarget: string | null; source: string | null; detail: string | null; at: string }> = [];
    if (!binding) return { ok: false, stages };
    const at = new Date().toISOString();
    const push = (
      stage: ExtensionStage,
      extra: {
        endpointKind?: string | null; endpointTarget?: string | null; ok?: boolean | null;
        error?: string | null; source?: string | null; detail?: string | null;
      } = {},
    ): void => {
      const row = {
        stage,
        ok: extra.ok ?? (stage === 'delivered'),
        error: extra.error ?? null,
        endpointKind: extra.endpointKind ?? null,
        endpointTarget: extra.endpointTarget ?? null,
        source: extra.source ?? null,
        detail: extra.detail ?? null,
        at,
      };
      stages.push(row);
      try {
        this.deps.executions.insert({
          bindingId: binding.id,
          sessionId,
          eventId: 0,
          trigger: 'dry-run',
          ...row,
        });
        this.deps.bus.emit({
          kind: 'extension.execution',
          bindingId: binding.id,
          sessionId,
          stage,
          ok: row.ok,
          ...(row.error ? { error: row.error } : {}),
          at,
        } as HookBusMessage);
      } catch {
        // 日志失败不影响 dry-run 回报
      }
    };

    // upstream：显式给 > 库里最近一条（与执行期同源同限）。
    const last = this.deps.deliverer.lastTurnOutput?.(sessionId)?.output ?? null;
    const rawUpstream = opts.upstream !== undefined ? opts.upstream : last;
    const upstream =
      rawUpstream && rawUpstream.length > UPSTREAM_MAX_CHARS
        ? `${rawUpstream.slice(0, UPSTREAM_MAX_CHARS)}…`
        : rawUpstream;
    // when 预筛（同 runBinding 的语义，重复这三行好过为 dry-run 抽共享件）。
    if (binding.when?.trim()) {
      const keywords = binding.when
        .split(/[,，\n;；]/)
        .map((k) => k.trim().toLowerCase())
        .filter((k) => k.length > 0);
      const hay = (upstream ?? '').toLowerCase();
      if (!keywords.some((k) => hay.includes(k))) {
        push('when-blocked', { ok: false, error: 'when pre-filter no match — upstream output lacks all keywords' });
        return { ok: false, stages };
      }
    }
    // 决策内核（condition/summarize 在场才烧 fork；同执行期两档分流）。
    let summary: string | null = null;
    let source: string | null = null;
    let detail: string | null = null;
    if (binding.condition?.trim() || binding.summarize?.trim()) {
      try {
        if (binding.summarize?.trim()) {
          const result = await this.deps.kernel.evaluate({
            sessionId,
            condition: binding.condition?.trim() || undefined,
            summarize: binding.summarize.trim(),
            upstream,
          });
          summary = result.summary;
          source = result.source;
          detail = result.detail ?? null;
          if (!result.ok) {
            push('condition-blocked', { ok: false, error: 'condition not satisfied — delivery blocked', source, detail });
            return { ok: false, stages };
          }
        } else {
          const decision = await this.deps.kernel.judge({
            sessionId,
            condition: binding.condition!.trim(),
            upstream,
          });
          source = decision.source ?? 'fork';
          detail = decision.detail ?? null;
          if (!decision.ok) {
            push('condition-blocked', { ok: false, error: decision.reason ?? 'condition not satisfied — delivery blocked', source, detail });
            return { ok: false, stages };
          }
        }
      } catch (err) {
        push('condition-blocked', {
          ok: false,
          error: `condition judge failed — delivery blocked: ${err instanceof Error ? err.message : String(err)}`,
        });
        return { ok: false, stages };
      }
    }
    // 端点预算 + 逐端点**试渲染**（session 端点渲染正文验模板变量；不发送）。
    if (binding.endpoints.length === 0 || binding.endpoints.length > MAX_ENDPOINTS) {
      push('failed', {
        ok: false,
        error:
          binding.endpoints.length === 0
            ? 'binding has no endpoints'
            : `endpoint budget exceeded (${binding.endpoints.length} > ${MAX_ENDPOINTS})`,
        source,
        detail,
      });
      return { ok: false, stages };
    }
    const sessionLabel = this.deps.labelOf?.(sessionId) ?? sessionId.slice(0, 8);
    await Promise.all(
      binding.endpoints.map(async (endpoint) => {
        const kind = endpoint.kind;
        const target = kind === 'session' ? endpoint.target : endpoint.url;
        if (kind === 'session') {
          const text = renderTemplate(endpoint.text, { upstream, summary, session: sessionLabel });
          if (UNRESOLVED_VAR.test(text)) {
            push('failed', {
              ok: false, endpointKind: kind, endpointTarget: target, source, detail,
              error: 'unresolved template variable — no upstream output and no summary',
            });
            return;
          }
          push('delivered', { ok: true, endpointKind: kind, endpointTarget: target, source, detail });
        } else {
          push('delivered', { ok: true, endpointKind: kind, endpointTarget: target, source, detail });
        }
      }),
    );
    return { ok: stages.every((s) => s.ok !== false), stages };
  }

  /**
   * ingest 消费路径的事件钩子（第五消费者；永不 throw）。事件命中哪个点由表答：
   * turn-end = 生命周期表 close、idle = MessagingSurface.idleSignals。两点的命中
   * 集合各自独立求值（同拍双命中是两次独立执行，不是同一绑定重复）。
   */
  onEvent(input: ExtensionEventInput): void {
    try {
      const surface = this.deps.surfaceFor?.(input.source) ?? messagingSurfaceFor(input.source);
      const closeEvents: readonly string[] = HARNESS_LIFECYCLE[input.source].close;
      const points: Array<'turn-end' | 'idle'> = [];
      if (closeEvents.includes(input.eventType)) points.push('turn-end');
      if (surface.idleSignals.includes(input.eventType)) points.push('idle');
      if (points.length === 0) return;
      for (const point of points) {
        for (const binding of this.byPoint.get(point) ?? []) {
          if (binding.projectId !== input.projectId) continue;
          // 叠加作用域：项目级（sessionId=null）与该会话的会话级各自独立、互不抑制。
          if (binding.sessionId !== null && binding.sessionId !== input.sessionId) continue;
          // 诱导回合豁免（批 2a 登记，消费即核销）：扩展/编排投递诱导的回合不触发绑定。
          if (this.deps.deliverer.consumeInduction(input.sessionId)) {
            // 一次核销只豁免一拍：同拍双命中的第二点照常走（上一拍已被登记核销过）。
            continue;
          }
          void this.runBinding(binding, input, point).catch(() => {});
        }
      }
    } catch {
      // 面缺席/库错误都不影响采集
    }
  }

  /** 单拍管线：闸序 = 重复 → 忙 → 冷却 → 陈旧 → 频次 → when → 决策 → 扇出。 */
  private async runBinding(
    binding: ExtensionBindingRow,
    input: ExtensionEventInput,
    _point: 'turn-end' | 'idle',
  ): Promise<void> {
    const now = Date.now();
    const at = input.at ?? new Date().toISOString();
    const record = (stage: ExtensionStage, extra: Partial<Parameters<ExtensionExecutionRepository['insert']>[0]> = {}) => {
      try {
        this.deps.executions.insert({
          bindingId: binding.id,
          sessionId: input.sessionId,
          eventId: input.eventId,
          trigger: 'event',
          stage,
          ...extra,
        });
        this.deps.bus.emit({
          kind: 'extension.execution',
          bindingId: binding.id,
          sessionId: input.sessionId,
          stage,
          ok: extra.ok ?? (stage === 'delivered'),
          ...(extra.error ? { error: extra.error } : {}),
          at: new Date().toISOString(),
        } as HookBusMessage);
      } catch {
        // 日志失败不影响端点执行（已在飞）
      }
    };

    // 冷却（绑定×会话）：Stop 与 SessionEnd 连拍不重复执行（第一拍多半还在飞
    // ——冷却判在忙跳过之前，连拍记冷却而不是忙）。
    const cooldownKey = `${binding.id}:${input.sessionId}`;
    if (now - (this.lastFiredAt.get(cooldownKey) ?? 0) < COOLDOWN_MS) return;
    // 忙跳过：同绑定前一拍未完 → 本拍不排队（排队只会把过期回合的执行堆到后面）。
    if (this.busy.has(binding.id)) {
      record('skipped:busy');
      return;
    }
    if (this.inflight >= MAX_CONCURRENT) {
      record('skipped:busy');
      return;
    }
    // 陈旧闸（回放/补执行）：超龄事件不执行——恢复风暴不该把过期回合的决策放出去。
    const atMs = Date.parse(at);
    if (Number.isFinite(atMs) && now - atMs > this.staleMs) {
      record('skipped:stale', { error: `event older than stale window (${Math.round(this.staleMs / 1000)}s)` });
      return;
    }
    // 日频次闸（UTC 日界）：项目级绑定 × 忙项目的 fork token 失控面在此收口。
    const day = new Date(now).toISOString().slice(0, 10);
    const counter = this.dayCounts.get(binding.id);
    const count = counter && counter.day === day ? counter.n : 0;
    if (count >= DAILY_EXECUTION_CAP) {
      record('skipped:capped', { error: `daily execution cap reached (${DAILY_EXECUTION_CAP})` });
      return;
    }
    // 端点预算：单次执行 ≤8 个端点。
    if (binding.endpoints.length === 0 || binding.endpoints.length > MAX_ENDPOINTS) {
      record('failed', {
        ok: false,
        error:
          binding.endpoints.length === 0
            ? 'binding has no endpoints'
            : `endpoint budget exceeded (${binding.endpoints.length} > ${MAX_ENDPOINTS})`,
      });
      this.noteFailure(binding.id);
      return;
    }

    this.lastFiredAt.set(cooldownKey, now);
    this.dayCounts.set(binding.id, { day, n: count + 1 });
    this.busy.add(binding.id);
    this.inflight++;
    try {
      // upstream = 这一轮最终输出（raw.last_assistant_message，与编排同源）；当拍
      // payload 没带就回查库（空回合跳过）。
      const raw = (input.payload as { raw?: unknown } | null)?.raw;
      const upstreamRaw = turnOutputOf(raw) ?? this.deps.deliverer.lastTurnOutput?.(input.sessionId)?.output ?? null;
      const upstream =
        upstreamRaw && upstreamRaw.length > UPSTREAM_MAX_CHARS
          ? `${upstreamRaw.slice(0, UPSTREAM_MAX_CHARS)}…`
          : upstreamRaw;
      const sessionLabel = this.deps.labelOf?.(input.sessionId) ?? input.sessionId.slice(0, 8);

      // when 预筛（廉：子串不命中即止，不花 token；复用编排 matchWhen 语义）。
      if (binding.when?.trim()) {
        const keywords = binding.when
          .split(/[,，\n;；]/)
          .map((k) => k.trim().toLowerCase())
          .filter((k) => k.length > 0);
        const hay = (upstream ?? '').toLowerCase();
        if (!keywords.some((k) => hay.includes(k))) {
          record('when-blocked', { ok: false, error: 'when pre-filter no match — upstream output lacks all keywords' });
          return;
        }
      }

      // 决策内核：summarize 在场 → 档三 evaluate（组合 fork，一次出判断与总结）；
      // 仅 condition → 档一 judge。两档都拦下即记 condition-blocked 收尾。
      let summary: string | null = null;
      let source: string | null = null;
      let detail: string | null = null;
      if (binding.condition?.trim() || binding.summarize?.trim()) {
        let verdict: { ok: boolean; summary: string | null; source: string; detail?: string };
        try {
          if (binding.summarize?.trim()) {
            const result = await this.deps.kernel.evaluate({
              sessionId: input.sessionId,
              condition: binding.condition?.trim() || undefined,
              summarize: binding.summarize.trim(),
              upstream,
            });
            verdict = { ok: result.ok, summary: result.summary, source: result.source, detail: result.detail };
          } else {
            const decision = await this.deps.kernel.judge({
              sessionId: input.sessionId,
              condition: binding.condition!.trim(),
              upstream,
            });
            verdict = { ok: decision.ok, summary: null, source: decision.source ?? 'fork', detail: decision.detail };
          }
        } catch (err) {
          record('condition-blocked', {
            ok: false,
            error: `condition judge failed — delivery blocked: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }
        source = verdict.source;
        detail = verdict.detail ?? null;
        if (!verdict.ok) {
          record('condition-blocked', {
            ok: false,
            error: 'condition not satisfied — delivery blocked',
            source,
            detail,
          });
          return;
        }
        summary = verdict.summary;
      }

      // 放行 → 渲染载荷 → 端点并行扇出（无屏障），逐端点记日志 + SSE 帧。
      await Promise.allSettled(
        binding.endpoints.map(async (endpoint) => {
          await this.runEndpoint(binding, endpoint, {
            input,
            upstream,
            summary,
            sessionLabel,
            source,
            detail,
            record,
          });
        }),
      );
    } finally {
      this.busy.delete(binding.id);
      this.inflight--;
    }
  }

  /** 逐端点：幂等查重（partial index）→ 渲染 → 发送 → 记 delivered/failed。 */
  private async runEndpoint(
    binding: ExtensionBindingRow,
    endpoint: ExtensionEndpoint,
    ctx: {
      input: ExtensionEventInput;
      upstream: string | null;
      summary: string | null;
      sessionLabel: string;
      source: string | null;
      detail: string | null;
      record: (stage: ExtensionStage, extra?: Record<string, unknown>) => void;
    },
  ): Promise<void> {
    const kind = endpoint.kind;
    const target = kind === 'session' ? endpoint.target : endpoint.url;
    // 幂等去重：端点已发、日志未落窗口崩溃后的回放不重复扇出。
    if (ctx.input.eventId > 0 && this.deps.executions.hasDelivered(binding.id, ctx.input.eventId, kind, target)) {
      ctx.record('skipped:duplicate', { endpointKind: kind, endpointTarget: target });
      return;
    }
    const text =
      kind === 'session'
        ? renderTemplate(endpoint.text, {
            upstream: ctx.upstream,
            summary: ctx.summary,
            session: ctx.sessionLabel,
          })
        : '';
    if (kind === 'session' && UNRESOLVED_VAR.test(text)) {
      ctx.record('failed', {
        ok: false,
        endpointKind: kind,
        endpointTarget: target,
        error: 'unresolved template variable — no upstream output and no summary',
      });
      this.noteFailure(binding.id);
      return;
    }
    try {
      if (kind === 'session') {
        // target='self' = 外部事件转告本会话（允许自指）。session 端点自指的下一
        // 回合是诱导回合——投出去的 send（origin:'extension'）在投递器 outbox
        // 单点登记，天然回合判定豁免，环在这里被掐死。
        const toSessionId = target === 'self' ? ctx.input.sessionId : target;
        if (!toSessionId) throw new Error('session endpoint has no target');
        const result = await this.deps.deliverer.send({
          toSessionId,
          text,
          mode: 'prompt',
          fromKind: 'session',
          origin: 'extension',
          fromSessionId: ctx.input.sessionId,
          oneWay: 'oneWay' in endpoint && endpoint.oneWay === true,
        });
        if (!result.ok) throw new Error(result.error);
        if (result.status === 'failed') {
          throw new Error(result.message.error ?? 'delivery failed');
        }
      } else {
        const result = await (this.deps.postJsonImpl ?? postJson)(endpoint.url, endpoint.secret, {
          binding: binding.name,
          bindingId: binding.id,
          point: binding.point,
          sessionId: ctx.input.sessionId,
          eventId: ctx.input.eventId,
          upstream: ctx.upstream,
          summary: ctx.summary,
          session: ctx.sessionLabel,
          at: new Date().toISOString(),
        });
        if (!result.ok) throw new Error(result.error ?? result.status);
      }
      ctx.record('delivered', {
        ok: true,
        endpointKind: kind,
        endpointTarget: target,
        source: ctx.source,
        detail: ctx.detail,
      });
      // 成功清零连败计数（在 delivered 落定后才清——扇出前清会让告警永不到顶）。
      this.failStreak.delete(binding.id);
    } catch (err) {
      ctx.record('failed', {
        ok: false,
        endpointKind: kind,
        endpointTarget: target,
        error: err instanceof Error ? err.message : String(err),
        source: ctx.source,
        detail: ctx.detail,
      });
      this.noteFailure(binding.id);
    }
  }

  /** 失败告警：同绑定连续 N 次 failed → 提醒三腿（notifyPayloadFor 形态的 bus 帧）。 */
  private noteFailure(bindingId: number): void {
    const streak = (this.failStreak.get(bindingId) ?? 0) + 1;
    this.failStreak.set(bindingId, streak);
    if (streak < FAILURE_ALERT_STREAK) return;
    this.failStreak.delete(bindingId);
    try {
      const binding = this.deps.bindings.getById(bindingId);
      this.deps.bus.emit({
        kind: 'extension.failed',
        bindingId,
        bindingName: binding?.name ?? `#${bindingId}`,
        sessionId: null,
        at: new Date().toISOString(),
      } as HookBusMessage);
    } catch {
      // 告警失败不影响执行域
    }
  }
}
