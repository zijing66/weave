import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  HookRuleSchema,
  type HandlerConfig,
  type HookRule,
  type HookRuleFilter,
  type HookRuleSource,
} from '@weave/core';

export interface CreateHookRuleInput {
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
 * hook_rules 配置表（行级 CRUD，enable/disable 单字段 UPDATE）。
 * JSON 列（source/filter/handler）经 Zod 归一化读出，坏行跳过而非抛错。
 */
export class HookRuleRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(input: CreateHookRuleInput): HookRule {
    const now = new Date().toISOString();
    const rule: HookRule = HookRuleSchema.parse({
      id: randomUUID(),
      name: input.name,
      enabled: input.enabled ?? true,
      priority: input.priority ?? 0,
      projectId: input.projectId,
      source: input.source,
      filter: input.filter ?? {},
      handler: input.handler,
      timeoutMs: input.timeoutMs ?? 10_000,
      record: input.record ?? input.handler.type !== 'log',
    });
    this.insertRow(rule, now, now);
    return rule;
  }

  getById(id: string): HookRule | undefined {
    const row = this.db.prepare('SELECT * FROM hook_rules WHERE id = ?').get(id);
    return row ? toRule(row) : undefined;
  }

  /** 全量列出；projectId 过滤时附带全局规则（project_id IS NULL）。 */
  list(projectId?: number): HookRule[] {
    const rows =
      projectId === undefined
        ? this.db.prepare('SELECT * FROM hook_rules ORDER BY priority DESC, created_at ASC').all()
        : this.db
            .prepare(
              'SELECT * FROM hook_rules WHERE project_id IS NULL OR project_id = ? ORDER BY priority DESC, created_at ASC',
            )
            .all(projectId);
    return rows.map(toRule).filter((r): r is HookRule => r !== undefined);
  }

  update(id: string, patch: Partial<CreateHookRuleInput> & { enabled?: boolean }): HookRule | undefined {
    const existing = this.getById(id);
    if (!existing) return undefined;
    const next: HookRule = HookRuleSchema.parse({
      ...existing,
      ...patch,
      id, // id 不可变
      projectId: 'projectId' in patch ? patch.projectId : existing.projectId,
    });
    this.db
      .prepare(
        `UPDATE hook_rules SET name = ?, enabled = ?, priority = ?, project_id = ?,
           source = ?, filter = ?, handler = ?, timeout_ms = ?, record = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        next.enabled ? 1 : 0,
        next.priority,
        next.projectId,
        JSON.stringify(next.source),
        JSON.stringify(next.filter),
        JSON.stringify(next.handler),
        next.timeoutMs,
        next.record ? 1 : 0,
        new Date().toISOString(),
        id,
      );
    return next;
  }

  setEnabled(id: string, enabled: boolean): HookRule | undefined {
    const result = this.db
      .prepare('UPDATE hook_rules SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, new Date().toISOString(), id);
    if (Number(result.changes) === 0) return undefined;
    return this.getById(id);
  }

  remove(id: string): boolean {
    const result = this.db.prepare('DELETE FROM hook_rules WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  private insertRow(rule: HookRule, createdAt: string, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO hook_rules (id, name, enabled, priority, project_id, source, filter, handler,
           timeout_ms, record, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rule.id,
        rule.name,
        rule.enabled ? 1 : 0,
        rule.priority,
        rule.projectId,
        JSON.stringify(rule.source),
        JSON.stringify(rule.filter),
        JSON.stringify(rule.handler),
        rule.timeoutMs,
        rule.record ? 1 : 0,
        createdAt,
        updatedAt,
      );
  }
}

/** 坏行（JSON 损坏/校验失败）返回 undefined，调用方过滤——与 mergeDefaults 白名单精神一致。 */
function toRule(row: Record<string, unknown>): HookRule | undefined {
  try {
    return HookRuleSchema.parse({
      id: String(row.id),
      name: String(row.name),
      enabled: Number(row.enabled) === 1,
      priority: Number(row.priority),
      projectId: row.project_id == null ? null : Number(row.project_id),
      source: JSON.parse(String(row.source)),
      filter: JSON.parse(String(row.filter ?? '{}')),
      handler: JSON.parse(String(row.handler)),
      timeoutMs: Number(row.timeout_ms),
      record: Number(row.record) === 1,
    });
  } catch {
    return undefined;
  }
}
