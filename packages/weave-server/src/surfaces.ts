import type { Harness } from '@weavecode/core';
import {
  createRuntimeRegistry,
  type AssetSurface,
  type CaptureSurface,
  type PluginStateSurface,
  type PluginSurface,
} from '@weavecode/harness';

/**
 * 批 4a：server 经 registry 查 AssetSurface——模块级运行时注册表，
 * 六处散落（file-assets / installer / global-config / classifier /
 * watch-service / codex-toml）的薄委托统一从这里取 surface。
 *
 * 批 4b 结论：**维持模块级 registry，不改经 WeaveServerDeps.harnesses 注入**
 * （最小风险）——消费方是无 deps 注入链的模块级纯函数，改注入需穿透六处散落
 * 并改存量测试，与「server 存量测试零改动」硬闸冲突；daemon 装配面
 * （events/resume）已走注入，两个 registry 同为 registerRuntimeDrivers 的
 * 独立实例、内容一致，行为等价。
 * 批 3：plugins 面同范式取（toolkit 等编排方经此取，零 CC 路径硬编码）。
 */
const registry = createRuntimeRegistry();

/** 按 harness 取资产表面；未注册或未补 assets 槽抛错。 */
export function assetSurfaceFor(harness: Harness): AssetSurface {
  const surface = registry.get(harness)?.assets;
  if (!surface) throw new Error(`no asset surface registered for harness: ${harness}`);
  return surface;
}

/**
 * 全部已注册的资产表面（注册顺序）——路径归属 / watch 观测集等多面聚合处
 * 按本表遍历，不再手写 `[assetSurfaceFor('codex'), assetSurfaceFor('claude')]`。
 */
export function assetSurfaces(): AssetSurface[] {
  return registry
    .all()
    .map((d) => d.assets)
    .filter((s): s is AssetSurface => s !== undefined);
}

/** 按 harness 取插件安装面（批 3）；未注册或未补 plugins 槽抛错。 */
export function pluginSurfaceFor(harness: Harness): PluginSurface {
  const surface = registry.get(harness)?.plugins;
  if (!surface) throw new Error(`no plugin surface registered for harness: ${harness}`);
  return surface;
}

/** 声明了 plugins 槽的 (harness, 面) 列表——工具行装配按本表枚举，不写白名单。 */
export function pluginSurfaces(): Array<{ harness: Harness; surface: PluginSurface }> {
  return registry
    .all()
    .filter((d) => d.plugins !== undefined)
    .map((d) => ({ harness: d.id, surface: d.plugins! }));
}

/** 按 harness 取插件启用态面（P2）；未注册或未补 pluginState 槽抛错。 */
export function pluginStateFor(harness: Harness): PluginStateSurface {
  const state = registry.get(harness)?.pluginState;
  if (!state) throw new Error(`no plugin state surface registered for harness: ${harness}`);
  return state;
}

/**
 * 声明了 pluginState 槽的 (harness, 面) 列表——路由据本表枚举响应键与
 * 校验 runtime，不写 `if (runtime === 'claude')` 白名单。
 */
export function pluginStateSurfaces(): Array<{ harness: Harness; state: PluginStateSurface }> {
  return registry
    .all()
    .filter((d) => d.pluginState !== undefined)
    .map((d) => ({ harness: d.id, state: d.pluginState! }));
}

/**
 * 声明了 capture 槽的 (harness, 面) 列表（§6-2d user 档采集）——/capture 路由
 * 据本表枚举状态行与安装目标，不写 harness 白名单。
 */
export function captureSurfaces(): Array<{ harness: Harness; surface: CaptureSurface }> {
  return registry
    .all()
    .filter((d) => d.capture !== undefined)
    .map((d) => ({ harness: d.id, surface: d.capture! }));
}
