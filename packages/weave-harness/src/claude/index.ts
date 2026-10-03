import type { HarnessDriver } from '../driver.js';
import { CLAUDE_ASSETS } from './assets.js';
import { CLAUDE_EVENT_SOURCE } from './event-source.js';
import { CLAUDE_RESUME } from './resume.js';

export { ClaudeEventSource, CLAUDE_EVENT_SOURCE } from './event-source.js';
export { CLAUDE_RESUME } from './resume.js';

/**
 * Claude 接入模块的驱动：批 4a 补 assets、批 4b 补 events/resume——
 * init/detect 批 5 增量补（见 registry-wiring 注记）。
 */
export const CLAUDE_DRIVER: HarnessDriver = {
  id: 'claude',
  displayName: 'Claude Code',
  capabilities: ['assets', 'events', 'resume'],
  assets: CLAUDE_ASSETS,
  events: CLAUDE_EVENT_SOURCE,
  resume: CLAUDE_RESUME,
};
