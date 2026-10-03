import { CLAUDE_DRIVER } from './claude/index.js';
import { CODEX_DRIVER } from './codex/index.js';
import type { HarnessRegistry } from './driver.js';

/**
 * 运行时驱动注册点：批 4a 已补 assets 槽、批 4b 已补 events/resume——
 * 批 5 补 init/detect，分阶段补槽。
 */
export function registerRuntimeDrivers(reg: HarnessRegistry): void {
  reg.register(CLAUDE_DRIVER);
  reg.register(CODEX_DRIVER);
}
