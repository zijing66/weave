import type { Harness } from '@weavecode/core';

/**
 * 各 harness 的官方安装命令（init 检测到未装时给用户确认后代跑）。安装知识归
 * harness 包——weave 不捆绑宿主二进制，只代跑官方渠道；探测用 bin 复用
 * `HARNESS_DRIVERS[h].resume.bin`，不在此重复。
 */
export const HARNESS_INSTALL: Record<Harness, { command: string }> = {
  claude: { command: 'npm install -g @anthropic-ai/claude-code' },
  codex: { command: 'npm install -g @openai/codex' },
};
