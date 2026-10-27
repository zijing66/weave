import type { ResumeCommandSpec } from '../driver.js';

/**
 * Codex resume 命令规格：裸 bin `codex` 起新会话（宿主无子命令即进交互 CLI），
 * 无头形 = `codex exec resume <id> -`（prompt 走 stdin，命令行不含用户内容），
 * 交互形 = `codex resume <id>`（`codex resume --help`：位置参数收 UUID）。
 *
 * 交互 resume 要的就是 codex 自己的 session id——rollout 的 `session_meta.session_id`
 * 即它（`weave-harness/src/codex/rollout.ts` 尾读采集），故 `openArgs` 给得出。
 */
export const CODEX_RESUME: ResumeCommandSpec = {
  supported: true,
  bin: 'codex',
  args: (sessionId) => ['exec', 'resume', sessionId, '-'],
  promptStdin: true,
  openArgs: (sessionId) => ['resume', sessionId],
  // 懒建档破局：/rename 是本地命令（不过模型），对无线程 TUI 注入即建 rollout
  bootstrapText: (projectName) => `/rename ${projectName}`,
};
