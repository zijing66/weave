import type { Harness } from '@weave/core';
import {
  createRuntimeRegistry,
  type AssetSurface,
  type PluginSurface,
} from '@weave/harness';

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

/** 按 harness 取插件安装面（批 3）；未注册或未补 plugins 槽抛错。 */
export function pluginSurfaceFor(harness: Harness): PluginSurface {
  const surface = registry.get(harness)?.plugins;
  if (!surface) throw new Error(`no plugin surface registered for harness: ${harness}`);
  return surface;
}
