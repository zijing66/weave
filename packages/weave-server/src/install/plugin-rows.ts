import type { EnableOverride, ToolStateRow } from '@weavecode/core';
import type { InstalledPluginRecord, PluginScope } from '@weavecode/harness';
import { pluginSurfaces, pluginStateSurfaces } from '../surfaces.js';

/**
 * 插件工具行装配（工具对象模型 §2，PluginEnabledMap 的替换面）：行 = 每键 ×
 * 每可装档一行，install/enable 逐档独立，effective 由本模块唯一解析
 * （档序弱→强 = local > project > user；全链无覆写 = 不加载，CC 三阶段模型）。
 * 依赖注入与 mcp-rows 同式：无——测试经 HOME/USERPROFILE 假家目录控文件。
 */
export type PluginToolRow = ToolStateRow;

/** 档序 = 生效链优先级（弱→强）；pluginScopes() 的排序契约由此消费。 */
const CHAIN: readonly PluginScope[] = ['user', 'project', 'local'];

/** 三档布尔覆写 → 行 enable 词表（未列 = 无覆写 = inherit，区别于显式 false）。 */
const overrideOf = (map: Record<string, boolean>, key: string): EnableOverride =>
  key in map ? (map[key] ? 'on' : 'off') : 'inherit';

/** 生效链解析（服务端唯一）：最近显式覆写生效，全链无覆写回落 false。 */
function resolveEffective(
  overrides: Record<PluginScope, Record<string, boolean>>,
  key: string,
): boolean {
  for (let i = CHAIN.length - 1; i >= 0; i--) {
    const value = overrides[CHAIN[i]!]![key];
    if (value !== undefined) return value;
  }
  return false;
}

export async function readPluginRows(projectPath: string): Promise<PluginToolRow[]> {
  const rows: PluginToolRow[] = [];
  const withInstall = pluginSurfaces();

  // 安装面 harness（claude）：installed_plugins.json（按记录 scope 分桶）∪ 三档
  // 覆写键，行域取并集——覆写可残留于已卸载键（读侧如实报）。
  for (const { harness, surface } of withInstall) {
    const scopes = surface.pluginScopes();
    const [installed, overrides] = await Promise.all([
      surface.readInstalled().catch(() => ({}) as Record<string, InstalledPluginRecord[]>),
      surface.readEnabledOverrides(projectPath).catch(
        () =>
          ({ user: {}, project: {}, local: {} }) as Record<
            PluginScope,
            Record<string, boolean>
          >,
      ),
    ]);
    const keys = new Set<string>(Object.keys(installed));
    for (const scope of CHAIN) for (const k of Object.keys(overrides[scope])) keys.add(k);
    for (const key of keys) {
      const records = installed[key];
      const effective = resolveEffective(overrides, key);
      for (const scope of scopes) {
        rows.push({
          key,
          category: 'plugin',
          harness,
          scope,
          installScopes: scopes,
          install: records?.some((r) => (r.scope ?? 'user') === scope)
            ? 'installed'
            : 'absent',
          enable: overrideOf(overrides[scope], key),
          effective,
        });
      }
    }
  }

  // 仅启用面 harness（codex，无安装槽）：user 档单行，键域 = 配置启用表。
  for (const { harness, state } of pluginStateSurfaces()) {
    if (withInstall.some((p) => p.harness === harness)) continue;
    const map = await state.readGlobalEnabled().catch(() => ({}));
    for (const [key, enabled] of Object.entries(map)) {
      rows.push({
        key,
        category: 'plugin',
        harness,
        scope: 'user',
        installScopes: [],
        enable: enabled ? 'on' : 'off',
        effective: enabled,
      });
    }
  }
  return rows;
}
