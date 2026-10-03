import type { HarnessDriver } from '../driver.js';
import { CODEX_ASSETS } from './assets.js';
import { CODEX_DETECTOR } from './detect.js';

export { CODEX_DETECTOR } from './detect.js';

/**
 * Codex 接入模块的驱动：批 4a 补 assets 槽、批 5 补 detect——init 槽不在此
 * （由 cli init/wiring 携带）；events/resume 无对等物（❌，永不注册）。
 */
export const CODEX_DRIVER: HarnessDriver = {
  id: 'codex',
  displayName: 'Codex',
  capabilities: ['assets', 'detect'],
  assets: CODEX_ASSETS,
  detect: CODEX_DETECTOR,
};
