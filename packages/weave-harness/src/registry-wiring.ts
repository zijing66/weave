import { CLAUDE_DRIVER } from './claude/index.js';
import { CODEX_DRIVER } from './codex/index.js';
import { HarnessRegistry } from './driver.js';

/**
 * 运行时驱动注册点：批 4a 已补 assets 槽、批 4b 已补 events/resume、
 * 批 5 已补 detect 槽——init 槽不在此（init 实现半球留 cli，
 * 由 `weave-cli/src/init/wiring.ts` unregister + 携带 init 重新注册）。
 */
export function registerRuntimeDrivers(reg: HarnessRegistry): void {
  reg.register(CLAUDE_DRIVER);
  reg.register(CODEX_DRIVER);
}

/** 新建注册表并灌入运行时驱动（消费方一行装配样板的唯一出处）。 */
export function createRuntimeRegistry(): HarnessRegistry {
  const reg = new HarnessRegistry();
  registerRuntimeDrivers(reg);
  return reg;
}
