import { CLAUDE_DRIVER } from './claude/index.js';
import { CODEX_DRIVER } from './codex/index.js';
import type { HarnessRegistry } from './driver.js';

/**
 * 运行时驱动注册点：批 2 只注册两个骨架 DRIVER（capabilities 为空占位）——
 * 批 4a 补 assets、批 4b 补 events/resume、批 5 补 init/detect 槽，分阶段补槽。
 */
export function registerRuntimeDrivers(reg: HarnessRegistry): void {
  reg.register(CLAUDE_DRIVER);
  reg.register(CODEX_DRIVER);
}
