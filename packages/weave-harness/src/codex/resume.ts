import type { ResumeCommandSpec } from '../driver.js';

/**
 * Codex resume 命令规格：裸 bin `codex` 起新会话（宿主无子命令即进交互 CLI），
 * 无头形 = `codex exec resume <id> -`（prompt 走 stdin，命令行不含用户内容）。
 * **不给 `openArgs`**：交互式 resume 要 codex 自己的 session id，而 weave 不收
 * codex 事件（B0 闸门未开）、手里没有这个 id——「在终端打开 codex 会话」仍 501。
 */
export const CODEX_RESUME: ResumeCommandSpec = {
  supported: true,
  bin: 'codex',
  args: (sessionId) => ['exec', 'resume', sessionId, '-'],
  promptStdin: true,
};
