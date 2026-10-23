import type { Harness } from '@weavecode/core';
import {
  createRuntimeRegistry,
  type AssetSurface,
  type BlockingPromptSpec,
  type CaptureSurface,
  type CommandsSurface,
  type ConfigSurface,
  type EditsSurface,
  type ImagesSurface,
  type MessagingSurface,
  type PluginStateSurface,
  type PluginSurface,
  type StatuslineSurface,
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
 * 按 harness 取消息能力面（session-orchestration 批 1）。与 pluginState 不同，
 * **不支持也是面**（全 null + unsupportedReasons）——「为什么置灰」必须可渲染，
 * 所以 codex 同样注册 messaging 槽；槽位缺席才抛错（装配期问题）。
 */
export function messagingSurfaceFor(harness: Harness): MessagingSurface {
  const surface = registry.get(harness)?.messaging;
  if (!surface) throw new Error(`no messaging surface registered for harness: ${harness}`);
  return surface;
}

/**
 * 全部已注册的消息能力面——能力矩阵路由（GET /messaging/capabilities）据本表
 * 派生响应，不写第二份支持状态事实源。
 */
export function messagingSurfaces(): Array<{ harness: Harness; surface: MessagingSurface }> {
  return registry
    .all()
    .filter((d) => d.messaging !== undefined)
    .map((d) => ({ harness: d.id, surface: d.messaging! }));
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

/**
 * 按 harness 取阻塞式交互面（AskUserQuestion/计划/权限确认）；null = 该
 * harness 无此机制（不跟踪、不作答）——codex 无此类交互，缺席即静默。
 */
export function blockingPromptFor(harness: Harness): BlockingPromptSpec | null {
  return registry.get(harness)?.questions ?? null;
}

/**
 * 按 harness 取 statusline 面；null = 该 harness 没有 statusline 概念。
 * 「TUI 里能不能注入」由面自己的 `tui` 答，调用方不按 harness 名判。
 */
export function statuslineSurfaceFor(harness: Harness): StatuslineSurface | null {
  return registry.get(harness)?.statusline ?? null;
}

/** 全部声明了 statusline 槽的 (harness, 面) 列表——能力矩阵按本表枚举。 */
export function statuslineSurfaces(): Array<{ harness: Harness; surface: StatuslineSurface }> {
  return registry
    .all()
    .filter((d) => d.statusline !== undefined)
    .map((d) => ({ harness: d.id, surface: d.statusline! }));
}

/** 按 harness 取配置面；null = 该 harness 尚无配置文件接管（web 渲染占位）。 */
export function configSurfaceFor(harness: Harness): ConfigSurface | null {
  return registry.get(harness)?.config ?? null;
}

/** 按 harness 取改动汇总面；null = 该 harness 没有改动提取（对话右键的汇总处如实说明）。 */
export function editSurfaceFor(harness: Harness): EditsSurface | null {
  return registry.get(harness)?.edits ?? null;
}

/** 按 harness 取入站图面；null = 该 harness 的粘贴图无处可取（对话里只剩 `[Image #N]` 占位）。 */
export function imagesSurfaceFor(harness: Harness): ImagesSurface | null {
  return registry.get(harness)?.images ?? null;
}

/** 按 harness 取命令面；null = 该 harness 没有 `/` 提示（前端不弹命令菜单）。 */
export function commandsSurfaceFor(harness: Harness): CommandsSurface | null {
  return registry.get(harness)?.commands ?? null;
}

/** 全部声明了 config 槽的 (harness, 面) 列表——配置面板的 harness 页签按本表枚举。 */
export function configSurfaces(): Array<{ harness: Harness; surface: ConfigSurface }> {
  return registry
    .all()
    .filter((d) => d.config !== undefined)
    .map((d) => ({ harness: d.id, surface: d.config! }));
}
