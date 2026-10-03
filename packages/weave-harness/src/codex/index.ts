import type { HarnessDriver } from '../driver.js';

/**
 * Codex 接入模块的驱动（批 2 骨架）：capabilities 暂空，槽位分批补——
 * assets 批 4a、init/detect 批 5；events/resume 无对等物（能力矩阵 ❌，永不注册）。
 */
export const CODEX_DRIVER: HarnessDriver = {
  id: 'codex',
  displayName: 'Codex',
  capabilities: [],
};
