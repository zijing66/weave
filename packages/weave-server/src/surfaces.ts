import type { Harness } from '@weave/core';
import {
  HarnessRegistry,
  registerRuntimeDrivers,
  type AssetSurface,
} from '@weave/harness';

/**
 * 批 4a：server 经 registry 查 AssetSurface——模块级运行时注册表，
 * 六处散落（file-assets / installer / global-config / classifier /
 * watch-service / codex-toml）的薄委托统一从这里取 surface。
 * 批 4b 起改为 start/dev-entry 装配的 registry 注入（WeaveServerDeps.harnesses）。
 */
const registry = new HarnessRegistry();
registerRuntimeDrivers(registry);

/** 按 harness 取资产表面；未注册或未补 assets 槽抛错。 */
export function assetSurfaceFor(harness: Harness): AssetSurface {
  const surface = registry.get(harness)?.assets;
  if (!surface) throw new Error(`no asset surface registered for harness: ${harness}`);
  return surface;
}
