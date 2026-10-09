import type { HookRule, HookDispatchStatus, HookDispatchMode } from '@weavecode/core';
import { INJECTABLE_EVENTS, hookSourceHarness, type Harness } from '@weavecode/core';
import type { NormalizedHookPayload } from './types.js';
import type { HookRuleRegistry } from './registry.js';
import type { PluginHost, PluginHandler, PluginHandlerResult } from './plugin-loader.js';
import { createPluginLogger } from './plugin-loader.js';
import type { HookDispatchRepository, HookDispatchRow } from '../repositories/hook-dispatches.js';
import type { SessionRepository } from '../repositories/sessions.js';
import type { HookEventBus } from './bus.js';
import type { ProjectRepository, ProjectRow } from '../repositories/projects.js';
import type { PluginStateRepository } from '../repositories/plugin-states.js';
import { readHooksEnabled } from '../daemon/settings.js';
import { effective, pluginsStateOf } from './plugin-project-state.js';
import { runWebhook, type EventSummary } from './handlers/webhook.js';
import {
  DISPATCH_MARKER,
  extractFilePath,
  isCrossProjectPath,
  matchesAnyGlob,
  projectLabel,
  renderTemplate,
  templateVars,
} from './match.js';

export interface IngestContext {
  /** 本次 ingest 写入 hook_events 的行 id。 */
  eventId: number;
  project: ProjectRow;
  sessionId: string | null;
  payload: NormalizedHookPayload;
  /** 事件来源 harness（server.ts 传入 input.source）；规则 harness 过滤按此比对。 */
  source: Harness;
}

/**
 * POST /hooks 的同步返回体：命中 inject 规则时携带注入内容，
 * 由 hook-handler.cjs 输出为 hookSpecificOutput.additionalContext。
 */
export interface IngestOutcome {
  additionalContext?: string;
  sessionTitle?: string;
}

const DEDUPE_WINDOW_MS = 60_000;
const MAX_CONCURRENT_WEBHOOKS = 4;
/** 插件执行并发闸（与 webhook 同形）：超出排队，避免慢处理器无界堆积。 */
const MAX_CONCURRENT_PLUGINS = 4;
/**
 * 插件注入阶段总预算：可注入事件必须同步等待（注入靠响应体），但多规则串行
 * 不得把响应时间叠加到 CC 的 hook 窗口之上（原先每条规则各自 timeoutMs 默认 10s）。
 */
const PLUGIN_INJECT_BUDGET_MS = 3_000;

/**
 * 事件分发器：ingest 后在响应路径上同步匹配（纯内存索引）并按 handler 分发。
 *
 * - log：只发 bus 事件，不落 dispatch 行（高频防写放大）
 * - manual：入池 status=pending（等 dashboard 复制/拖拽执行）
 * - inject：入池 status=injected + 经响应体返回 additionalContext 注入当前会话
 * - webhook：入池 status=running 后异步出站（不阻塞响应），信号量限并发
 * - plugin：可注入事件在响应路径上同步执行（注入靠响应体）但整段共享预算；
 *   不可注入事件（PreToolUse/Notification 等）additionalContext 反正进不了响应，
 *   与 webhook 同款 fire-and-forget——prompt 照常入池，只是晚一步落库
 *
 * 一切异常在内部吞掉并降级为「无动作」——分发失败永不影响 ingest（201 语义不变）。
 */
export class HookDispatcher {
  private readonly runningWebhooks = new Set<string>();
  private readonly recentPool = new Map<string, number>();
  private activeWebhooks = 0;
  private readonly pendingWebhooks: Array<() => void> = [];
  private activePlugins = 0;
  private readonly pendingPlugins: Array<() => void> = [];

  constructor(
    private readonly deps: {
      registry: HookRuleRegistry;
      dispatches: HookDispatchRepository;
      bus: HookEventBus;
      projects: ProjectRepository;
      /** 会话标题双向 rename（session_title diff + pending 下发）。 */
      sessions: SessionRepository;
      /** 插件宿主（plugin-loader）；缺省时 plugin 规则按无动作跳过。 */
      plugins?: PluginHost;
      /** D3 项目启用门控的全局回落源（plugin_states 行）；缺省不门控（现状语义）。 */
      pluginStates?: Pick<PluginStateRepository, 'get'>;
      /** 测试注入；缺省用全局 fetch。 */
      fetchImpl?: typeof fetch;
    },
  ) {}

  async onIngest(ctx: IngestContext): Promise<IngestOutcome> {
    try {
      if (!readHooksEnabled()) return {};

      // ⑦ 事件订阅转发：所有采集事件（不只命中规则的）fire-and-forget 通知插件。
      this.deps.plugins?.notifyEvent?.(ctx.payload.eventType, ctx.payload, ctx.sessionId);

      // 会话 rename 双向（独立于规则匹配）：
      // 读——payload 的 session_title（/rename 或 --name 后下一次上报）做 diff 采纳；
      // 写——dashboard 挂的 pending_title 随响应下发（sessionTitle 与 /rename 同效），
      // 落定闸门 = 本事件确实携带 session_title 上报（UserPromptSubmit 等——Claude 只在
      // 这类事件上处理/回报标题）；工具事件照常下发但保留 pending，否则落定后下一 UPS
      // 会以旧名经 diff 通道把 title 自纠回去（改名被吞）。reported diff 兼作自纠兜底。
      const outcome: IngestOutcome = {};
      if (ctx.sessionId) {
        // 会话行由 server 路由 ingest 前 touch（单一 owner），此处只读。
        const reported = extractReportedTitle(ctx.payload);
        if (
          reported !== null &&
          this.deps.sessions.applyReportedTitle(ctx.sessionId, reported)
        ) {
          // 更名生效确认：pending 落地/外部改名被采纳 → 广播，dashboard 校验
          // 「实际是否更名」并把待生效徽标切换为新名字。
          this.deps.bus.emit({
            kind: 'session.renamed',
            sessionId: ctx.sessionId,
            title: reported,
            at: new Date().toISOString(),
          });
        }
        const pending = this.deps.sessions.getBySessionId(ctx.sessionId)?.pendingTitle;
        if (pending) {
          outcome.sessionTitle = pending;
          // 携带标题上报的事件上交付即落定（同响应把新名交给会话）；未实际应用时
          // 下一次上报的旧标题经 diff 通道改回（自纠）。
          if (reported !== null && this.deps.sessions.confirmPendingTitle(ctx.sessionId, pending)) {
            this.deps.bus.emit({
              kind: 'session.renamed',
              sessionId: ctx.sessionId,
              title: pending,
              at: new Date().toISOString(),
            });
          }
        }
      }

      const rules = this.match(ctx);
      if (rules.length === 0) return outcome;

      const injected: string[] = [];
      const now = Date.now();
      const pluginDeadline = now + PLUGIN_INJECT_BUDGET_MS;

      for (const rule of rules) {
        this.deps.bus.emit({
          kind: 'rule.matched',
          ruleId: rule.id,
          eventId: ctx.eventId,
          sessionId: ctx.sessionId,
          at: new Date(now).toISOString(),
        });

        if (rule.handler.type === 'log') continue;

        if (rule.handler.type === 'manual' || rule.handler.type === 'inject') {
          // 同 rule × session 60s 去重（防注入指令再触发事件造成递归风暴）
          if (this.dedupe(rule, ctx, now)) continue;

          const prompt =
            renderTemplate(
              rule.handler.template,
              templateVars({
                event: ctx.payload.eventType,
                tool: ctx.payload.toolName,
                filePath: extractFilePath(ctx.payload.toolInput),
                cwd: ctx.payload.cwd,
                session: ctx.sessionId,
                project: projectLabel(ctx.project.path),
                rule: rule.name,
              }),
            ) + `\n${DISPATCH_MARKER}`;

          const status: HookDispatchStatus = rule.handler.type === 'inject' ? 'injected' : 'pending';
          this.createDispatch(rule, ctx, {
            prompt,
            status,
            mode: rule.handler.type === 'inject' ? 'auto' : 'manual',
          });
          if (rule.handler.type === 'inject') injected.push(prompt);
          continue;
        }

        if (rule.handler.type === 'webhook') {
          if (this.runningWebhooks.has(rule.id)) continue; // 每规则防重入
          this.runningWebhooks.add(rule.id);
          const row = this.createDispatch(rule, ctx, {
            prompt: `webhook ${rule.handler.url}`,
            status: 'running',
            mode: 'auto',
          });
          this.deps.bus.emit({
            kind: 'dispatch.started',
            ruleId: rule.id,
            dispatchId: row.id,
            sessionId: ctx.sessionId,
            at: new Date().toISOString(),
          });
          void this.runWebhookAsync(rule, this.summary(rule, ctx), row.id);
          continue;
        }

        if (rule.handler.type === 'plugin') {
          // 插件处理器与 inject/manual 同防（60s 去重防递归、timeoutMs 超时、
          // catch-all 不影响 ingest）；返回 prompt 入池、additionalContext 注入
          // 但同样要求事件在白名单内。
          const host = this.deps.plugins;
          if (!host) continue;
          const impl = host.getHandler(rule.handler.pluginId, rule.handler.handlerType);
          if (!impl) continue;

          if (this.dedupe(rule, ctx, now)) continue;

          // 不可注入：响应体里带不走任何东西 → 不占响应路径（同 webhook）。
          if (!this.injectable(ctx)) {
            void this.runPluginDetached(rule, ctx, host, impl);
            continue;
          }

          // 可注入：注入必须同步，但受整段预算约束，超预算即放弃本条注入。
          const budgetMs = pluginDeadline - Date.now();
          if (budgetMs <= 0) continue;
          const result = await this.runPluginHandler(rule, ctx, host, impl, budgetMs);
          if (!result) continue;
          if (result.prompt) {
            this.createDispatch(rule, ctx, {
              prompt: result.prompt + `\n${DISPATCH_MARKER}`,
              status: 'pending',
              mode: 'auto',
            });
          }
          if (result.additionalContext) injected.push(result.additionalContext);
        }
      }

      if (injected.length > 0) outcome.additionalContext = injected.join('\n\n');
      return outcome;
    } catch {
      return {}; // 分发失败永不影响 ingest
    }
  }

  /** 入池 + 广播 dispatch.created（inject/manual/webhook/plugin 四路共用的建池路径）。 */
  private createDispatch(
    rule: HookRule,
    ctx: IngestContext,
    input: { prompt: string; status: HookDispatchStatus; mode: HookDispatchMode },
  ): HookDispatchRow {
    const row = this.deps.dispatches.insert({
      ruleId: rule.id,
      eventId: ctx.eventId,
      sessionId: ctx.sessionId,
      ...input,
    });
    this.deps.bus.emit({
      kind: 'dispatch.created',
      ruleId: rule.id,
      dispatchId: row.id,
      status: input.status,
      mode: row.mode,
      sessionId: ctx.sessionId,
      at: row.startedAt,
    });
    return row;
  }

  /** 同 rule × session 60s 去重：true = 应跳过本规则（防注入指令再触发事件的递归风暴）。 */
  private dedupe(rule: HookRule, ctx: IngestContext, now: number): boolean {
    const key = `${rule.id}:${ctx.sessionId ?? ''}`;
    const last = this.recentPool.get(key);
    if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return true;
    this.recentPool.set(key, now);
    this.trimDedupe(now);
    return false;
  }

  /** 候选规则：事件索引（启用+priority 降序）→ 项目归属 → 过滤条件。 */
  private match(ctx: IngestContext): HookRule[] {
    const states = this.deps.pluginStates;
    // 插件规则反向闭环：全局关时 loader 已把 rule.enabled 级联为 false，项目级显式
    // 启用必须能复活它——门控在场时候选含停用规则，enabled 与 effective 在此裁决。
    const projectPlugins = states ? pluginsStateOf(ctx.project.meta).enabled : null;
    // crossProjectOnly 需要的「其他项目路径」按 match 惰性取一次（避免每规则全表查）。
    let otherPaths: string[] | null = null;
    return this.deps.registry
      .candidates(ctx.payload.eventType, states ? { includeDisabled: true } : undefined)
      .filter((rule) => {
        // harness 首行过滤：'any' 跨 harness 命中；webhook 源（null）不按 harness 过滤。
        const ruleHarness = hookSourceHarness(rule.source);
        if (ruleHarness !== null && ruleHarness !== 'any' && ruleHarness !== ctx.source) return false;
        if (rule.projectId !== null && rule.projectId !== ctx.project.id) return false;
        if (rule.pluginId !== null) {
          // 仅项目显式启用才绕过 enabled 否决：无全局行时 effective 回落 true，
          // 不能反超 rule.enabled（manifest 默认关的 presets、规则级手动关保持不命中）；
          // 放行后由 effective 三分支全权（fail-closed，未注入 states = 不门控 = 现状语义）。
          if (!rule.enabled && projectPlugins?.[rule.pluginId] !== true) return false;
          if (states && !effective(ctx.project, rule.pluginId, { states })) return false;
        } else if (!rule.enabled) {
          return false; // 非插件规则维持 enabled 预滤（门控放开候选时在此补回）
        }
        const f = rule.filter;
        if (f.toolNames?.length) {
          if (!ctx.payload.toolName || !f.toolNames.includes(ctx.payload.toolName)) return false;
        }
        if (f.pathGlobs?.length) {
          const fp = extractFilePath(ctx.payload.toolInput);
          if (!fp || !matchesAnyGlob(fp, f.pathGlobs)) return false;
        }
        if (f.crossProjectOnly) {
          const fp = extractFilePath(ctx.payload.toolInput) ?? ctx.payload.cwd;
          if (!fp) return false;
          otherPaths ??= this.deps.projects
            .list()
            .map((p) => p.path)
            .filter((p) => p !== ctx.project.path);
          if (!isCrossProjectPath(fp, ctx.project.path, otherPaths)) return false;
        }
        return true;
      });
  }

  /** 该事件能否把插件的 additionalContext 交给会话（白名单按 harness 分表）。 */
  private injectable(ctx: IngestContext): boolean {
    const event = ctx.payload.eventType;
    return event !== null && (INJECTABLE_EVENTS[ctx.source] as readonly string[]).includes(event);
  }

  /**
   * 执行插件处理器：timeoutMs 竞速超时（`budgetMs` = 本次可用预算，取两者更小者），
   * 任何异常/超时返回 undefined（不注入不入池）。并发闸的排队时间计入同一次竞速，
   * 排到后照常执行，超时被弃的那次由自己 finally 释放槽位（不会漏槽）。
   */
  private async runPluginHandler(
    rule: HookRule,
    ctx: IngestContext,
    host: PluginHost,
    impl: PluginHandler,
    budgetMs?: number,
  ): Promise<PluginHandlerResult | undefined> {
    if (rule.handler.type !== 'plugin') return undefined;
    const { pluginId } = rule.handler;
    const logger = createPluginLogger(pluginId);
    const timeoutMs = budgetMs === undefined ? rule.timeoutMs : Math.min(rule.timeoutMs, budgetMs);
    let timer: NodeJS.Timeout | undefined;
    try {
      const execution = (async () => {
        await this.acquirePluginSlot();
        try {
          return await impl.execute({
            event: ctx.payload,
            rule,
            config: host.getConfig(pluginId),
            logger,
          });
        } finally {
          this.releasePluginSlot();
        }
      })();
      const result = await Promise.race([
        execution,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('plugin handler timeout')), timeoutMs);
        }),
      ]);
      if (result && typeof result === 'object') return result as PluginHandlerResult;
      return undefined;
    } catch {
      return undefined; // 插件失败永不影响 ingest（与 catch-all 语义一致）
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 不可注入事件的插件执行：fire-and-forget，prompt 照常入池（晚一步落库）。 */
  private async runPluginDetached(
    rule: HookRule,
    ctx: IngestContext,
    host: PluginHost,
    impl: PluginHandler,
  ): Promise<void> {
    try {
      const result = await this.runPluginHandler(rule, ctx, host, impl);
      if (!result?.prompt) return;
      this.createDispatch(rule, ctx, {
        prompt: result.prompt + `\n${DISPATCH_MARKER}`,
        status: 'pending',
        mode: 'auto',
      });
    } catch {
      // fire-and-forget：失败不冒泡（对齐「分发失败永不影响 ingest」）
    }
  }

  private summary(rule: HookRule, ctx: IngestContext): EventSummary {
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      projectId: ctx.project.id,
      sessionId: ctx.sessionId,
      event: ctx.payload.eventType,
      toolName: ctx.payload.toolName,
      filePath: extractFilePath(ctx.payload.toolInput),
      cwd: ctx.payload.cwd,
      at: new Date().toISOString(),
    };
  }

  private async runWebhookAsync(rule: HookRule, summary: EventSummary, dispatchId: number): Promise<void> {
    await this.acquireWebhookSlot();
    try {
      const result = await runWebhook(rule, summary, this.deps.fetchImpl);
      this.deps.dispatches.updateStatus(dispatchId, {
        status: result.status,
        output: result.output ?? null,
        error: result.error ?? null,
        finished: true,
      });
      this.deps.bus.emit({
        kind: 'dispatch.finished',
        ruleId: rule.id,
        dispatchId,
        status: result.status,
        sessionId: summary.sessionId,
        at: new Date().toISOString(),
      });
    } catch (err) {
      this.deps.dispatches.updateStatus(dispatchId, {
        status: 'failed',
        error: String(err),
        finished: true,
      });
      this.deps.bus.emit({
        kind: 'dispatch.finished',
        ruleId: rule.id,
        dispatchId,
        status: 'failed',
        sessionId: summary.sessionId,
        at: new Date().toISOString(),
      });
    } finally {
      this.runningWebhooks.delete(rule.id);
      this.releaseWebhookSlot();
    }
  }

  /** 全局并发闸（默认 4）：超出则排队等待。 */
  private acquireWebhookSlot(): Promise<void> {
    if (this.activeWebhooks < MAX_CONCURRENT_WEBHOOKS) {
      this.activeWebhooks++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.pendingWebhooks.push(() => {
        this.activeWebhooks++;
        resolve();
      });
    });
  }

  private releaseWebhookSlot(): void {
    this.activeWebhooks--;
    const next = this.pendingWebhooks.shift();
    if (next) next();
  }

  /** 插件执行并发闸（默认 4）：超出则排队等待。 */
  private acquirePluginSlot(): Promise<void> {
    if (this.activePlugins < MAX_CONCURRENT_PLUGINS) {
      this.activePlugins++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.pendingPlugins.push(() => {
        this.activePlugins++;
        resolve();
      });
    });
  }

  private releasePluginSlot(): void {
    this.activePlugins--;
    const next = this.pendingPlugins.shift();
    if (next) next();
  }

  /** 去重窗口 map 清理：只留窗口内条目，防长期运行无限增长。 */
  private trimDedupe(now: number): void {
    if (this.recentPool.size < 1000) return;
    for (const [key, ts] of this.recentPool) {
      if (now - ts >= DEDUPE_WINDOW_MS) this.recentPool.delete(key);
    }
  }
}

/** payload.raw 中的自定义会话标题（SessionStart / UserPromptSubmit 携带）。 */
function extractReportedTitle(payload: NormalizedHookPayload): string | null {
  const raw = payload.raw;
  if (typeof raw !== 'object' || raw === null) return null;
  const title = (raw as Record<string, unknown>)['session_title'];
  return typeof title === 'string' && title.length > 0 ? title : null;
}
