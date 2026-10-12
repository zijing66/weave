import {
  INJECTABLE_EVENTS,
  hookSourceHarness,
  normalizeHookRuleSource,
  type HandlerConfig,
  type HookRule,
  type HookRuleFilter,
  type HookRuleSource,
} from '@weavecode/core';
import type { CreateHookRuleInput, HookRuleRepository } from '../repositories/hook-rules.js';

/**
 * 内存规则索引（ruflo HookRegistry 的跨进程形态：handler 不在进程内注册，
 * 而是按事件名索引 SQLite 加载的规则，供 dispatcher 同步匹配）。
 * 所有变更经 registry 走 repository 落库后 reload，保证缓存与库一致。
 */
export class HookRuleRegistry {
  /** event → 规则，priority 降序。仅含 source.kind === 'hook-event'（legacy 形已读侧 normalize）。 */
  private byEvent = new Map<string, HookRule[]>();
  private all: HookRule[] = [];

  /** 规则集变更后的下游同步钩子（mirror 重写）；构造期首次 load 时通常未挂载。 */
  onChange?: () => void;

  constructor(private readonly repo: HookRuleRepository) {
    this.load();
  }

  /** 从 SQLite 全量重载（外部直接改库后可调用）；读侧把 legacy 'claude-event' normalize 为 hook-event。 */
  load(): void {
    this.all = this.repo.list().map((r) => ({ ...r, source: normalizeHookRuleSource(r.source) }));
    this.byEvent = new Map();
    for (const rule of this.all) {
      if (rule.source.kind !== 'hook-event') continue; // webhook 源不参与事件匹配（现状不变）
      const bucket = this.byEvent.get(rule.source.event);
      if (bucket) bucket.push(rule);
      else this.byEvent.set(rule.source.event, [rule]);
    }
    this.onChange?.();
  }

  list(projectId?: number): HookRule[] {
    const rows = projectId === undefined ? this.all : this.repo.list(projectId);
    // 两条路径统一读侧 normalize（this.all 已 normalize，幂等）——API 输出形一致。
    return rows.map((r) => ({ ...r, source: normalizeHookRuleSource(r.source) }));
  }

  get(id: string): HookRule | undefined {
    return this.all.find((r) => r.id === id);
  }

  /**
   * 匹配候选：该事件下的规则，priority 降序（projectId 归属过滤在 dispatcher）。
   * 默认只含已启用；includeDisabled 供 dispatcher 对插件规则做「项目显式启用复活」
   * （enabled 在那边按插件语义裁决），默认形不变 = 非插件路径语义不变。
   */
  candidates(event: string, opts?: { includeDisabled?: boolean }): HookRule[] {
    const bucket = this.byEvent.get(event) ?? [];
    return opts?.includeDisabled ? [...bucket] : bucket.filter((r) => r.enabled);
  }

  create(input: CreateHookRuleInput): HookRule {
    // 写侧 normalize：legacy 'claude-event' 入口即转 hook-event（下次 update 落新形同理）。
    const source = normalizeHookRuleSource(input.source);
    validateHandler(source, input.handler);
    const rule = this.repo.create({ ...input, source });
    this.load();
    return rule;
  }

  update(id: string, patch: Partial<CreateHookRuleInput>): HookRule | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const source = patch.source ? normalizeHookRuleSource(patch.source) : existing.source;
    validateHandler(source, patch.handler ?? existing.handler);
    const next = this.repo.update(id, patch.source ? { ...patch, source } : patch);
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

/**
 * inject 只允许挂在支持 additionalContext 的事件上（白名单按 harness 分表）。
 * legacy 'claude-event' 视作 harness='claude'；'any' 拒绝（两 harness 注入通道不同，
 * 白名单必须按具体 harness 查）；错误文案保留 `requires source.kind` 前缀（存量断言）。
 */
export function validateHandler(source: HookRuleSource, handler: HandlerConfig): void {
  const harness = hookSourceHarness(source);
  if (handler.type === 'inject') {
    if (harness === null || harness === 'any') {
      throw new Error(
        'inject handler requires source.kind = "hook-event" with a concrete harness (legacy "claude-event" accepted; "any" rejected)',
      );
    }
    const allowed = INJECTABLE_EVENTS[harness];
    const event =
      source.kind === 'claude-event' || source.kind === 'hook-event' ? source.event : '';
    if (!(allowed as readonly string[]).includes(event)) {
      throw new Error(
        `inject handler is not supported on event "${event}" (allowed: ${allowed.join(', ')})`,
      );
    }
    return;
  }
  if (handler.type === 'plugin') {
    if (harness === null) {
      throw new Error('plugin handler requires source.kind = "hook-event"');
    }
  }
}
