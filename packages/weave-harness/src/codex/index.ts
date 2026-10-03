import type { HarnessDriver } from '../driver.js';
import { CODEX_ASSETS } from './assets.js';

/**
 * Codex 接入模块的驱动：批 4a 补 assets 槽（capabilities 含 'assets'，能力
 * 矩阵 ⚠ skills 面）——init/detect 批 5；events/resume 无对等物（❌，永不注册）。
 */
export const CODEX_DRIVER: HarnessDriver = {
  id: 'codex',
  displayName: 'Codex',
  capabilities: ['assets'],
  assets: CODEX_ASSETS,
};
