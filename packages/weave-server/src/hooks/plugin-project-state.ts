import type { PluginStateRepository } from '../repositories/plugin-states.js';
import type { ProjectRepository, ProjectRow } from '../repositories/projects.js';

/**
 * D3 插件启用按项目隔离：每项目显式覆盖写 `projects.meta.plugins`，
 * `plugin_states` 表保持全局（=「默认启用」开关），不改表零迁移。
 */
export interface PluginsMeta {
  syncedAt: string | null;
  enabled: Record<string, boolean>;
}

/** 读 `projects.meta` 列的 plugins 键（缺失/损坏 → 未同步 + 空覆盖）。 */
export function pluginsStateOf(meta: string | null): PluginsMeta {
  const empty: PluginsMeta = { syncedAt: null, enabled: {} };
  if (meta == null) return empty;
  try {
    const parsed: unknown = JSON.parse(meta);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
    const raw = (parsed as Record<string, unknown>)['plugins'];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
    const entry = raw as Record<string, unknown>;
    const enabledRaw = entry['enabled'];
    const enabled: Record<string, boolean> = {};
    if (enabledRaw && typeof enabledRaw === 'object' && !Array.isArray(enabledRaw)) {
      for (const [id, value] of Object.entries(enabledRaw as Record<string, unknown>)) {
        if (typeof value === 'boolean') enabled[id] = value;
      }
    }
    return {
      syncedAt: typeof entry['syncedAt'] === 'string' ? entry['syncedAt'] : null,
      enabled,
    };
  } catch {
    return empty;
  }
}

/**
 * 生效单点三分支：`enabled[id]` 有显式记录 → 用之；否则项目已同步
 * （syncedAt 存在）→ false（已同步未启用）；否则回落全局 plugin_states 行
 * （未同步项目 = 现状语义）。`defaultEnabled` = 无全局行时的回落默认：
 * dispatcher/管理面按 loader 语义 true，toolkit 读侧沿用既有 `?? false`。
 */
export function effective(
  project: Pick<ProjectRow, 'meta'>,
  pluginId: string,
  opts: { states: Pick<PluginStateRepository, 'get'>; defaultEnabled?: boolean },
): boolean {
  const state = pluginsStateOf(project.meta);
  if (Object.hasOwn(state.enabled, pluginId)) return state.enabled[pluginId];
  if (state.syncedAt !== null) return false;
  return opts.states.get(pluginId)?.enabled ?? opts.defaultEnabled ?? true;
}

/** 项目级开关：写 `meta.plugins.enabled[id]`（不触碰全局 plugin_states / 规则级联）。 */
export function setProjectEnabled(
  project: Pick<ProjectRow, 'id' | 'meta'>,
  pluginId: string,
  enabled: boolean,
  opts: { projects: Pick<ProjectRepository, 'setMeta'> },
): void {
  const state = pluginsStateOf(project.meta);
  opts.projects.setMeta(project.id, {
    plugins: { syncedAt: state.syncedAt, enabled: { ...state.enabled, [pluginId]: enabled } },
  });
}

/**
 * 项目同步：写 `syncedAt` 并对**无显式记录**的已知插件补 `enabled=false`
 *（同步后默认不启用；显式用户选择永不覆盖）。返回 syncedAt。
 */
export function syncPlugins(
  project: Pick<ProjectRow, 'id' | 'meta'>,
  knownIds: Iterable<string>,
  opts: { projects: Pick<ProjectRepository, 'setMeta'>; now?: string },
): string {
  const state = pluginsStateOf(project.meta);
  const enabled = { ...state.enabled };
  for (const id of knownIds) {
    if (!Object.hasOwn(enabled, id)) enabled[id] = false;
  }
  const syncedAt = opts.now ?? new Date().toISOString();
  opts.projects.setMeta(project.id, { plugins: { syncedAt, enabled } });
  return syncedAt;
}
