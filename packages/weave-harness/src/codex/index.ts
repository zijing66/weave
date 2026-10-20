import type { HarnessDriver } from '../driver.js';
import { CODEX_ASSETS } from './assets.js';
import { CODEX_DETECTOR } from './detect.js';
import { CODEX_MESSAGING } from './messaging.js';
import { CODEX_PLUGIN_STATE } from './plugin-state.js';
import { CODEX_RESUME } from './resume.js';

export { CODEX_DETECTOR } from './detect.js';
export { CODEX_PLUGIN_STATE } from './plugin-state.js';
export { CODEX_MESSAGING } from './messaging.js';
export { CODEX_RESUME } from './resume.js';
export * from './mcp.js';
export * from './toml.js';

/**
 * Codex 接入模块的驱动：批 4a 补 assets 槽、批 5 补 detect、P2 补 pluginState
 * （config.toml 启用态）、session-orchestration 批 1 补 messaging（显式不支持面）、
 * 起会话补 resume（裸 bin 起新会话；无 openArgs——weave 没有 codex 的 session id）——
 * init 槽不在此（由 cli init/wiring 携带）；events/plugins 无对等物（❌，
 * 永不注册——Codex 无事件采集、无插件安装/市场机制）。
 */
export const CODEX_DRIVER: HarnessDriver = {
  id: 'codex',
  displayName: 'Codex',
  capabilities: ['assets', 'detect', 'pluginState', 'messaging', 'resume'],
  assets: CODEX_ASSETS,
  detect: CODEX_DETECTOR,
  pluginState: CODEX_PLUGIN_STATE,
  messaging: CODEX_MESSAGING,
  resume: CODEX_RESUME,
};
