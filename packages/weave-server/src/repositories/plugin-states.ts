import type { DatabaseSync } from 'node:sqlite';

export interface PluginStateRow {
  id: string;
  enabled: boolean;
  /** 用户对 manifest `config` 的覆写（深度合并由加载器处理，这里只存原始覆写）。 */
  config: Record<string, unknown>;
  updatedAt: string;
}

/**
 * 插件级开关与配置覆写（三通道统一状态源：内置/目录扫描/安装）。
 * 本表 = user 档默认启停；project 档覆写在 projects.meta.plugins
 * （plugin-project-state），SPI 插件单根安装无 local 档。
 * 规则级 enabled 仍是 hook_rules 单一事实源；插件 disable 由管理面
 * 级联把该插件全部规则 enabled 置 0（同事务），enable 恢复插件默认值。
 */
export class PluginStateRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(id: string): PluginStateRow | undefined {
    const row = this.db.prepare('SELECT * FROM plugin_states WHERE id = ?').get(id);
    if (!row) return undefined;
    return {
      id: String(row.id),
      enabled: Number(row.enabled) === 1,
      config: JSON.parse(String(row.config ?? '{}')) as Record<string, unknown>,
      updatedAt: String(row.updated_at),
    };
  }

  list(): PluginStateRow[] {
    const rows = this.db.prepare('SELECT * FROM plugin_states ORDER BY id ASC').all();
    return rows.map((row) => ({
      id: String(row.id),
      enabled: Number(row.enabled) === 1,
      config: JSON.parse(String(row.config ?? '{}')) as Record<string, unknown>,
      updatedAt: String(row.updated_at),
    }));
  }

  setEnabled(id: string, enabled: boolean): void {
    this.upsert(id, { enabled });
  }

  setConfig(id: string, config: Record<string, unknown>): void {
    this.upsert(id, { config });
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM plugin_states WHERE id = ?').run(id);
  }

  private upsert(id: string, patch: { enabled?: boolean; config?: Record<string, unknown> }): void {
    const existing = this.get(id);
    const now = new Date().toISOString();
    const enabled = patch.enabled ?? existing?.enabled ?? true;
    const config = patch.config ?? existing?.config ?? {};
    if (existing) {
      this.db
        .prepare('UPDATE plugin_states SET enabled = ?, config = ?, updated_at = ? WHERE id = ?')
        .run(enabled ? 1 : 0, JSON.stringify(config), now, id);
    } else {
      this.db
        .prepare(
          'INSERT INTO plugin_states (id, enabled, config, updated_at) VALUES (?, ?, ?, ?)',
        )
        .run(id, enabled ? 1 : 0, JSON.stringify(config), now);
    }
  }
}
