import type { HarnessDriver } from '../driver.js';
import { CODEX_ASSETS } from './assets.js';
import { CODEX_DETECTOR } from './detect.js';
import { CODEX_PLUGIN_STATE } from './plugin-state.js';

export { CODEX_DETECTOR } from './detect.js';
export { CODEX_PLUGIN_STATE } from './plugin-state.js';
export * from './toml.js';

/**
 * Codex 接入模块的驱动：批 4a 补 assets 槽、批 5 补 detect、P2 补 pluginState
 * （config.toml 启用态）——init 槽不在此（由 cli init/wiring 携带）；
 * events/resume/plugins 无对等物（❌，永不注册，同 codex/resume.ts 的
 * unsupported 先例——Codex 无插件安装/市场机制）。
 */
export const CODEX_DRIVER: HarnessDriver = {
  id: 'codex',
  displayName: 'Codex',
  capabilities: ['assets', 'detect', 'pluginState'],
  assets: CODEX_ASSETS,
  detect: CODEX_DETECTOR,
  pluginState: CODEX_PLUGIN_STATE,
};
