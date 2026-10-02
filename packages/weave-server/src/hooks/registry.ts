import {
  INJECTABLE_HOOK_EVENTS,
  type HandlerConfig,
  type HookRule,
  type HookRuleFilter,
  type HookRuleSource,
} from '@weave/core';
import type { CreateHookRuleInput, HookRuleRepository } from '../repositories/hook-rules.js';

/**
 * 内存规则索引（ruflo HookRegistry 的跨进程形态：handler 不在进程内注册，
 * 而是按事件名索引 SQLite 加载的规则，供 dispatcher 同步匹配）。
 * 所有变更经 registry 走 repository 落库后 reload，保证缓存与库一致。
 */
export class HookRuleRegistry {
  /** event → 规则，priority 降序。仅含 source.kind === 'claude-event'。 */
  private byEvent = new Map<string, HookRule[]>();
  private all: HookRule[] = [];

  constructor(private readonly repo: HookRuleRepository) {
    this.load();
  }

  /** 从 SQLite 全量重载（外部直接改库后可调用）。 */
  load(): void {
    this.all = this.repo.list();
    this.byEvent = new Map();
    for (const rule of this.all) {
      if (rule.source.kind !== 'claude-event') continue;
      const bucket = this.byEvent.get(rule.source.event);
      if (bucket) bucket.push(rule);
      else this.byEvent.set(rule.source.event, [rule]);
    }
  }

  list(projectId?: number): HookRule[] {
    return projectId === undefined ? [...this.all] : this.repo.list(projectId);
  }

  get(id: string): HookRule | undefined {
    return this.all.find((r) => r.id === id);
  }

  /** 匹配候选：该事件下已启用的规则，priority 降序（projectId 归属过滤在 dispatcher）。 */
  candidates(event: string): HookRule[] {
    return (this.byEvent.get(event) ?? []).filter((r) => r.enabled);
  }

  create(input: CreateHookRuleInput): HookRule {
    validateHandler(input.source, input.handler);
    const rule = this.repo.create(input);
    this.load();
    return rule;
  }

  update(id: string, patch: Partial<CreateHookRuleInput>): HookRule | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    validateHandler(patch.source ?? existing.source, patch.handler ?? existing.handler);
    const next = this.repo.update(id, patch);
    if (next) this.load();
    return next;
  }

  setEnabled(id: string, enabled: boolean): HookRule | undefined {
    const next = this.repo.setEnabled(id, enabled);
    if (next) this.load();
    return next;
  }

  remove(id: string): boolean {
    const removed = this.repo.remove(id);
    if (removed) this.load();
    return removed;
  }
}

export interface CreateHookRuleBody {
  name: string;
  enabled?: boolean;
  priority?: number;
  projectId: number | null;
  source: HookRuleSource;
  filter?: HookRuleFilter;
  handler: HandlerConfig;
  timeoutMs?: number;
  record?: boolean;
}

/** inject 只允许挂在支持 additionalContext 的事件上（官方文档逐事件核实的白名单）。 */
function validateHandler(source: HookRuleSource, handler: HandlerConfig): void {
  if (handler.type !== 'inject') return;
  if (source.kind !== 'claude-event') {
    throw new Error('inject handler requires source.kind = "claude-event"');
  }
  if (!(INJECTABLE_HOOK_EVENTS as readonly string[]).includes(source.event)) {
    throw new Error(
      `inject handler is not supported on event "${source.event}" (allowed: ${INJECTABLE_HOOK_EVENTS.join(', ')})`,
    );
  }
}
