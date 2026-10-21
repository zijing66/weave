import type { HarnessDriver } from '../driver.js';
import { CODEX_ASSETS } from './assets.js';
import { CODEX_CAPTURE } from './capture.js';
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
export { CODEX_CAPTURE } from './capture.js';
export * from './mcp.js';
export * from './toml.js';

/**
 * Codex 接入模块的驱动：批 4a 补 assets 槽、批 5 补 detect、P2 补 pluginState
 * （config.toml 启用态）、session-orchestration 批 1 补 messaging（显式不支持面）、
 * 起会话补 resume、**采集补 capture + events**（codex 0.163 的 hooks 引擎装
 * `<CODEX_HOME>/hooks.json`，见 `capture.ts`）、logs 降为兜底（hooks 未被信任
 * 时仍能看到存量会话）——init 槽不在此（由 cli init/wiring 携带）。
 * plugins 面 codex 有对等物（`codex plugin add` / `marketplace`），尚未接。
 */
export const CODEX_DRIVER: HarnessDriver = {
  id: 'codex',
  displayName: 'Codex',
  capabilities: ['assets', 'detect', 'pluginState', 'messaging', 'resume', 'events', 'capture', 'logs'],
  assets: CODEX_ASSETS,
  detect: CODEX_DETECTOR,
  pluginState: CODEX_PLUGIN_STATE,
  messaging: CODEX_MESSAGING,
  resume: CODEX_RESUME,
  events: CODEX_EVENT_SOURCE,
  capture: CODEX_CAPTURE,
  logs: CODEX_LOG_SOURCE,
};
