import type { HarnessDriver } from '../driver.js';
import { CODEX_ASSETS } from './assets.js';
import { CODEX_DETECTOR } from './detect.js';
import { CODEX_EVENT_SOURCE } from './event-source.js';
import { CODEX_MESSAGING } from './messaging.js';
import { CODEX_PLUGIN_STATE } from './plugin-state.js';
import { CODEX_RESUME } from './resume.js';
import { CODEX_LOG_SOURCE } from './rollout.js';

export { CODEX_DETECTOR } from './detect.js';
export { CODEX_PLUGIN_STATE } from './plugin-state.js';
export { CODEX_MESSAGING } from './messaging.js';
export { CODEX_RESUME } from './resume.js';
export { CODEX_EVENT_SOURCE, CodexEventSource, CodexTurnBuffer } from './event-source.js';
export { CODEX_LOG_SOURCE, CodexLogSource } from './rollout.js';
export * from './mcp.js';
export * from './toml.js';

/**
 * Codex 接入模块的驱动：批 4a 补 assets 槽、批 5 补 detect、P2 补 pluginState
 * （config.toml 启用态）、session-orchestration 批 1 补 messaging（显式不支持面）、
 * 起会话补 resume（裸 bin 起新会话；无 openArgs——weave 没有 codex 的 session id）、
 * codex 采集补 events + logs（尾读 rollout JSONL，见 `rollout.ts`）——
 * init 槽不在此（由 cli init/wiring 携带）；plugins 无对等物（❌ 永不注册——
 * Codex 无插件安装/市场机制）。
 */
export const CODEX_DRIVER: HarnessDriver = {
  id: 'codex',
  displayName: 'Codex',
  capabilities: ['assets', 'detect', 'pluginState', 'messaging', 'resume', 'events', 'logs'],
  assets: CODEX_ASSETS,
  detect: CODEX_DETECTOR,
  pluginState: CODEX_PLUGIN_STATE,
  messaging: CODEX_MESSAGING,
  resume: CODEX_RESUME,
  events: CODEX_EVENT_SOURCE,
  logs: CODEX_LOG_SOURCE,
};
