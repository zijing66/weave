import type { PluginStateSurface } from '../driver.js';
import { CLAUDE_PLUGINS } from './plugins.js';

/**
 * Claude 插件启用态表面：`~/.claude/settings.json` 的 enabledPlugins——
 * 实现已在 plugins 槽（同一份 settings 读写），本模块只是把该能力
 * 也给 pluginState 槽（路由按槽枚举，不写 harness 分支）。
 */
export const CLAUDE_PLUGIN_STATE: PluginStateSurface = {
  readGlobalEnabled: () => CLAUDE_PLUGINS.readGlobalEnabled(),
  writeGlobalEnabled: (key, enabled) => CLAUDE_PLUGINS.writeGlobalEnabled(key, enabled),
};
