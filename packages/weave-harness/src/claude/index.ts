import type { HarnessDriver } from '../driver.js';
import { CLAUDE_ASSETS } from './assets.js';

/**
 * Claude 接入模块的驱动：批 4a 补 assets 槽（capabilities 含 'assets'）——
 * events/resume 批 4b、init/detect 批 5 增量补（见 registry-wiring 注记）。
 */
export const CLAUDE_DRIVER: HarnessDriver = {
  id: 'claude',
  displayName: 'Claude Code',
  capabilities: ['assets'],
  assets: CLAUDE_ASSETS,
};
