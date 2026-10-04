import type { HarnessDriver } from '../driver.js';
import { CLAUDE_ASSETS } from './assets.js';
import { CLAUDE_EVENT_SOURCE } from './event-source.js';
import { CLAUDE_PLUGINS } from './plugins.js';
import { CLAUDE_RESUME } from './resume.js';
import { CLAUDE_DETECTOR } from './detect.js';

export { ClaudeEventSource, CLAUDE_EVENT_SOURCE } from './event-source.js';
export { CLAUDE_PLUGINS, createClaudePluginSurface, WEAVE_MARKETPLACE } from './plugins.js';
export type { PluginExecutor, PluginExecResult } from './plugins.js';
export { CLAUDE_RESUME } from './resume.js';
export { CLAUDE_DETECTOR } from './detect.js';

/**
 * Claude 接入模块的驱动：批 4a 补 assets、批 4b 补 events/resume、批 5 补
 * detect、批 3 补 plugins——init 槽不在此（init 实现半球留 cli，由 init/wiring 携带）。
 */
export const CLAUDE_DRIVER: HarnessDriver = {
  id: 'claude',
  displayName: 'Claude Code',
  capabilities: ['assets', 'events', 'resume', 'detect', 'plugins'],
  assets: CLAUDE_ASSETS,
  events: CLAUDE_EVENT_SOURCE,
  resume: CLAUDE_RESUME,
  detect: CLAUDE_DETECTOR,
  plugins: CLAUDE_PLUGINS,
};
