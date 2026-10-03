import {
  CLAUDE_DRIVER,
  HarnessRegistry,
  registerRuntimeDrivers,
  type HarnessDriver,
} from '@weave/harness';
import { ClaudeInitTemplate } from './harnesses/claude.js';

/** cli 侧 claude init 驱动：批 2 骨架 + init 槽（init 实现半球留 cli）。 */
const CLAUDE_INIT_DRIVER: HarnessDriver = {
  ...CLAUDE_DRIVER,
  capabilities: [...CLAUDE_DRIVER.capabilities, 'init'],
  init: ClaudeInitTemplate,
};

/**
 * init 槽注册点（图①-b 步 B）：骨架驱动 + claude init 模板类。
 * registry 同 id 先到先得（重复注册抛错），骨架 CLAUDE_DRIVER 无 init 槽，
 * 故先 unregister 再携带 init 槽重新注册（codex init 归批 5）。
 */
export function buildInitRegistry(): HarnessRegistry {
  const reg = new HarnessRegistry();
  registerRuntimeDrivers(reg);
  reg.unregister('claude');
  reg.register(CLAUDE_INIT_DRIVER);
  return reg;
}
