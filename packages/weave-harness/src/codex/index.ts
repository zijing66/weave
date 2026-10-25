import type { HarnessDriver } from '../driver.js';
import { CODEX_ASSETS } from './assets.js';
import { CODEX_CAPTURE } from './capture.js';
import { CODEX_CONFIG } from './config.js';
import { CODEX_DETECTOR } from './detect.js';
import { CODEX_EVENT_SOURCE } from './event-source.js';
import { CODEX_MESSAGING } from './messaging.js';
import { CODEX_PLUGINS } from './plugins.js';
import { CODEX_PLUGIN_STATE } from './plugin-state.js';
import { CODEX_PROVISION } from './provision.js';
import { CODEX_RESUME } from './resume.js';
import { CODEX_LOG_SOURCE } from './rollout.js';
import { CODEX_COMMANDS } from './commands.js';

export { CODEX_DETECTOR } from './detect.js';
export { CODEX_PLUGIN_STATE } from './plugin-state.js';
export { CODEX_MESSAGING } from './messaging.js';
export { CODEX_RESUME } from './resume.js';
export { CODEX_EVENT_SOURCE, CodexEventSource, CodexTurnBuffer } from './event-source.js';
export { CODEX_LOG_SOURCE, CodexLogSource } from './rollout.js';
export { CODEX_CAPTURE } from './capture.js';
export { codexInterruptMarkerAt } from './transcript.js';
export { CODEX_PLUGINS, createCodexPluginSurface, CODEX_MARKETPLACE } from './plugins.js';
export { CODEX_CONFIG, ensureTrustAccepted as ensureCodexTrustAccepted } from './config.js';
export { CODEX_PROVISION, codexProvisionCheck } from './provision.js';
export * from './mcp.js';
export * from './toml.js';
export { CODEX_COMMANDS } from './commands.js';

/**
 * Codex 接入模块的驱动：批 4a 补 assets 槽、批 5 补 detect、P2 补 pluginState
 * （config.toml 启用态）、session-orchestration 批 1 补 messaging（显式不支持面）、
 * 起会话补 resume、**采集补 capture + events**（codex 0.163 的 hooks 引擎装
 * `<CODEX_HOME>/hooks.json`，见 `capture.ts`）、logs 降为兜底（hooks 未被信任
 * 时仍能看到存量会话）、**plugins 补安装/市场面**（`codex plugin add` /
 * `marketplace`，见 `plugins.ts`）、**config 补配置面**（config.toml 词表 +
 * TOML 读写，见 `config.ts`）、**provision 补安装形态检查**（桌面端/CLI 双面孔
 * 的版本漂移警告，见 `provision.ts`）——init 槽不在此（由 cli init/wiring 携带）。
 */
export const CODEX_DRIVER: HarnessDriver = {
  id: 'codex',
  displayName: 'Codex',
  capabilities: [
    'assets',
    'detect',
    'plugins',
    'pluginState',
    'messaging',
    'resume',
    'events',
    'capture',
    'logs',
    'config',
    'commands',
    'provision',
  ],
  assets: CODEX_ASSETS,
  detect: CODEX_DETECTOR,
  plugins: CODEX_PLUGINS,
  pluginState: CODEX_PLUGIN_STATE,
  messaging: CODEX_MESSAGING,
  resume: CODEX_RESUME,
  events: CODEX_EVENT_SOURCE,
  capture: CODEX_CAPTURE,
  logs: CODEX_LOG_SOURCE,
  config: CODEX_CONFIG,
  commands: CODEX_COMMANDS,
  provision: CODEX_PROVISION,
};
