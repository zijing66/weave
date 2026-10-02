import type { HookRule } from '@weave/core';
import type { NormalizedHookPayload } from './types.js';
import type { HookRuleRegistry } from './registry.js';
import type { HookDispatchRepository } from '../repositories/hook-dispatches.js';
import type { SessionRepository } from '../repositories/sessions.js';
import type { HookEventBus } from './bus.js';
import type { ProjectRepository, ProjectRow } from '../repositories/projects.js';
import { readDaemonSettings } from '../daemon/settings.js';
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

/**
 * 事件分发器：ingest 后在响应路径上同步匹配（纯内存索引）并按 handler 分发。
 *
 * - log：只发 bus 事件，不落 dispatch 行（高频防写放大）
 * - manual：入池 status=pending（等 dashboard 复制/拖拽执行）
 * - inject：入池 status=injected + 经响应体返回 additionalContext 注入当前会话
 * - webhook：入池 status=running 后异步出站（不阻塞响应），信号量限并发
 *
 * 一切异常在内部吞掉并降级为「无动作」——分发失败永不影响 ingest（201 语义不变）。
 */
export class HookDispatcher {
  private readonly runningWebhooks = new Set<string>();
  private readonly recentPool = new Map<string, number>();
  private activeWebhooks = 0;
  private readonly pendingWebhooks: Array<() => void> = [];

  constructor(
    private readonly deps: {
      registry: HookRuleRegistry;
      dispatches: HookDispatchRepository;
      bus: HookEventBus;
      projects: ProjectRepository;
      /** 会话标题双向 rename（session_title diff + pending 下发）。 */
      sessions: SessionRepository;
      /** 测试注入；缺省用全局 fetch。 */
      fetchImpl?: typeof fetch;
    },
  ) {}

  async onIngest(ctx: IngestContext): Promise<IngestOutcome> {
    try {
      const settings = await readDaemonSettings();
      if (!settings.hooks.enabled) return {};

      // 会话 rename 双向（独立于规则匹配）：
      // 读——payload 的 session_title（/rename 或 --name 后下一次上报）做 diff 采纳；
      // 写——dashboard 挂的 pending_title 随响应下发（sessionTitle 与 /rename 同效），
      // 生效确认仍靠下一次上报的 reported title（不乐观落定，避免新旧标题打架）。
      const outcome: IngestOutcome = {};
      if (ctx.sessionId) {
        this.deps.sessions.touch(ctx.sessionId, ctx.project.id); // 幂等 upsert
        const reported = extractReportedTitle(ctx.payload);
        if (reported !== null) this.deps.sessions.applyReportedTitle(ctx.sessionId, reported);
        const pending = this.deps.sessions.getBySessionId(ctx.sessionId)?.pendingTitle;
        if (pending) outcome.sessionTitle = pending;
      }

      const rules = this.match(ctx);
      if (rules.length === 0) return outcome;

      const injected: string[] = [];
      const now = Date.now();

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
          const key = `${rule.id}:${ctx.sessionId ?? ''}`;
          const last = this.recentPool.get(key);
          if (last !== undefined && now - last < DEDUPE_WINDOW_MS) continue;
          this.recentPool.set(key, now);
          this.trimDedupe(now);

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

          const status = rule.handler.type === 'inject' ? 'injected' : 'pending';
          const row = this.deps.dispatches.insert({
            ruleId: rule.id,
            eventId: ctx.eventId,
            sessionId: ctx.sessionId,
            prompt,
            status,
            mode: rule.handler.type === 'inject' ? 'auto' : 'manual',
          });
          this.deps.bus.emit({
            kind: 'dispatch.created',
            ruleId: rule.id,
            dispatchId: row.id,
            status,
            mode: row.mode,
            sessionId: ctx.sessionId,
            at: row.startedAt,
          });
          if (rule.handler.type === 'inject') injected.push(prompt);
          continue;
        }

        if (rule.handler.type === 'webhook') {
          if (this.runningWebhooks.has(rule.id)) continue; // 每规则防重入
          this.runningWebhooks.add(rule.id);
          const row = this.deps.dispatches.insert({
            ruleId: rule.id,
            eventId: ctx.eventId,
            sessionId: ctx.sessionId,
            prompt: `webhook ${rule.handler.url}`,
            status: 'running',
            mode: 'auto',
          });
          this.deps.bus.emit({
            kind: 'dispatch.created',
            ruleId: rule.id,
            dispatchId: row.id,
            status: 'running',
            mode: 'auto',
            sessionId: ctx.sessionId,
            at: row.startedAt,
          });
          this.deps.bus.emit({
            kind: 'dispatch.started',
            ruleId: rule.id,
            dispatchId: row.id,
            sessionId: ctx.sessionId,
            at: new Date().toISOString(),
          });
          void this.runWebhookAsync(rule, this.summary(rule, ctx), row.id);
        }
      }

      if (injected.length > 0) outcome.additionalContext = injected.join('\n\n');
      return outcome;
    } catch {
      return {}; // 分发失败永不影响 ingest
    }
  }

  /** 候选规则：事件索引（启用+priority 降序）→ 项目归属 → 过滤条件。 */
  private match(ctx: IngestContext): HookRule[] {
    return this.deps.registry.candidates(ctx.payload.eventType).filter((rule) => {
      if (rule.projectId !== null && rule.projectId !== ctx.project.id) return false;
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
        const others = this.deps.projects
          .list()
          .map((p) => p.path)
          .filter((p) => p !== ctx.project.path);
        if (!isCrossProjectPath(fp, ctx.project.path, others)) return false;
      }
      return true;
    });
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
