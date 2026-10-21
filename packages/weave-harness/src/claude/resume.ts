import type { ResumeCommandSpec } from '../driver.js';

/**
 * 批 4b 迁入：Claude resume 命令规格；`WEAVE_CLAUDE_BIN` / `claudeBin` 环境与
 * 测试覆盖由 runner 保留。prompt 走 stdin（`claude --resume <sessionId> -p`
 * 无位置参数时读管道）——命令行不含用户内容，Windows 的 .cmd shim 由此可
 * 经 shell 安全启动。
 */
export const CLAUDE_RESUME: ResumeCommandSpec = {
  supported: true,
  bin: 'claude',
  // prompt 经 stdin（-p 无位置参数时读管道）；命令行无用户内容 → win32 可安全
  // 经 shell 启动解析 .cmd shim（不经 shell spawn 'claude' 必 ENOENT）。
  args: (sessionId) => ['--resume', sessionId, '-p'],
  promptStdin: true,
  // 交互式打开：无 -p，进终端后由用户继续对话。
  openArgs: (sessionId) => ['--resume', sessionId],
  // 编排边级提取：fork 一次无头回合——继承会话上下文提炼信息，不动原会话、
  // 不留转录（--no-session-persistence 只关落盘，hook 照发，故 forkSessionId
  // 由 server 预登记、ingest 侧过滤）。实测 2.1.296：fork 真继承上下文。
  extractArgs: (sessionId, forkSessionId) => [
    '--resume',
    sessionId,
    '--fork-session',
    '--no-session-persistence',
    '--session-id',
    forkSessionId,
  ],
  // weave 的 claude 集成（hook 面 / 阻塞问答键序 / 计划正文）都按 2.1.287 起的
  // 宿主任约写，低于它的不接新会话（UI 置灰并报出实际版本）。
  minVersion: '2.1.287',
};
