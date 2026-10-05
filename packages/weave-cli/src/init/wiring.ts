import {
  CLAUDE_DRIVER,
  CODEX_DRIVER,
  HarnessRegistry,
  createRuntimeRegistry,
  type HarnessDriver,
} from '@weave/harness';
import { ClaudeInitTemplate } from './harnesses/claude.js';
import { CodexInitTemplate } from './harnesses/codex.js';

/** cli 侧 claude init 驱动：批 2 骨架 + init 槽（init 实现半球留 cli）。 */
const CLAUDE_INIT_DRIVER: HarnessDriver = {
  ...CLAUDE_DRIVER,
  capabilities: [...CLAUDE_DRIVER.capabilities, 'init'],
  init: ClaudeInitTemplate,
};

/** cli 侧 codex init 驱动（批 5）：骨架 + init 槽（仅显式选择 codex 时才跑）。 */
const CODEX_INIT_DRIVER: HarnessDriver = {
  ...CODEX_DRIVER,
  capabilities: [...CODEX_DRIVER.capabilities, 'init'],
  init: CodexInitTemplate,
};

/**
 * init 槽注册点（图①-b 步 B）：骨架驱动 + 两个 init 模板类。
 * registry 同 id 先到先得（重复注册抛错），骨架驱动无 init 槽，
 * 故各 id 先 unregister 再携带 init 槽重新注册。
 */
export function buildInitRegistry(): HarnessRegistry {
  const reg = createRuntimeRegistry();
  reg.unregister('claude');
  reg.register(CLAUDE_INIT_DRIVER);
  reg.unregister('codex');
  reg.register(CODEX_INIT_DRIVER);
  return reg;
}
