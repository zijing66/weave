import {
  HARNESS_DRIVERS,
  HarnessRegistry,
  createRuntimeRegistry,
  type HarnessDriver,
  type InitTemplateClass,
} from '@weavecode/harness';
import type { Harness } from '@weavecode/core';
import { ClaudeInitTemplate } from './harnesses/claude.js';
import { CodexInitTemplate } from './harnesses/codex.js';

/**
 * init 槽表（cli 侧）——**加 harness = 这里加一行**（`satisfies` 穷尽，漏加即编译
 * 失败）；骨架驱动由 harness 根 `HARNESS_DRIVERS` 提供，本表只补 init 实现半球。
 */
const HARNESS_INIT_TEMPLATES = {
  claude: ClaudeInitTemplate,
  codex: CodexInitTemplate,
} satisfies Record<Harness, InitTemplateClass>;

/**
 * init 槽注册点（图①-b 步 B）：遍历 init 槽表，把骨架驱动携带 init 槽后按 id
 * 覆盖重注册（registry 同 id 先到先得，重复注册抛错，故先 unregister 再 register）。
 */
export function buildInitRegistry(): HarnessRegistry {
  const reg = createRuntimeRegistry();
  for (const h of Object.keys(HARNESS_INIT_TEMPLATES) as Harness[]) {
    const base = HARNESS_DRIVERS[h];
    const driver: HarnessDriver = {
      ...base,
      capabilities: base.capabilities.includes('init')
        ? base.capabilities
        : [...base.capabilities, 'init'],
      init: HARNESS_INIT_TEMPLATES[h],
    };
    reg.unregister(h);
    reg.register(driver);
  }
  return reg;
}
