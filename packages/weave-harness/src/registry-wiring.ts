import type { Harness } from '@weavecode/core';
import { CLAUDE_DRIVER } from './claude/index.js';
import { CODEX_DRIVER } from './codex/index.js';
import { HarnessRegistry, type HarnessDriver } from './driver.js';

/**
 * 运行时驱动总表——**加 harness = 这里加一行**（`satisfies` 穷尽，漏加即
 * 编译失败）；注册与消费皆由本表派生，不再手写 id 清单。
 *
 * init 槽不在此（init 实现半球留 cli，由 `weave-cli/src/init/wiring.ts`
 * unregister + 携带 init 重新注册）。
 */
export const HARNESS_DRIVERS = {
  claude: CLAUDE_DRIVER,
  codex: CODEX_DRIVER,
} satisfies Record<Harness, HarnessDriver>;

/** 注册表全量注册点：遍历驱动表（唯一装配样板出处）。 */
export function registerRuntimeDrivers(reg: HarnessRegistry): void {
  for (const driver of Object.values(HARNESS_DRIVERS)) reg.register(driver);
}

/** 新建注册表并灌入运行时驱动（消费方一行装配样板的唯一出处）。 */
export function createRuntimeRegistry(): HarnessRegistry {
  const reg = new HarnessRegistry();
  registerRuntimeDrivers(reg);
  return reg;
}
