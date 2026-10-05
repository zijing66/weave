import type { ResumeCommandSpec } from '../driver.js';

/**
 * 批 4b 迁入：Claude resume 命令规格——bin/args 逐字来自 server
 * `resume-runner.ts` 现状（`claude --resume <sessionId> -p <prompt>`）；
 * `WEAVE_CLAUDE_BIN` / `claudeBin` 环境与测试覆盖由 runner 保留。
 */
export const CLAUDE_RESUME: ResumeCommandSpec = {
  supported: true,
  bin: 'claude',
  args: (sessionId, prompt) => ['--resume', sessionId, '-p', prompt],
  // 交互式打开：无 -p，进终端后由用户继续对话。
  openArgs: (sessionId) => ['--resume', sessionId],
};
