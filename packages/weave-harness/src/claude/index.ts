import type { HarnessDriver } from '../driver.js';

/**
 * Claude 接入模块的驱动（批 2 骨架）：capabilities 暂空，槽位分批补——
 * assets 批 4a、events/resume 批 4b、init/detect 批 5（见 registry-wiring 注记）。
 */
export const CLAUDE_DRIVER: HarnessDriver = {
  id: 'claude',
  displayName: 'Claude Code',
  capabilities: [],
};
