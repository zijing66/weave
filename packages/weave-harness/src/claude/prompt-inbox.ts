import type { PromptInboxSpec } from '../driver.js';

/**
 * claude 的会话本地收件箱直投规格（层①-a）：**claude 专属机制**，协议与键名都在
 * 这里，server 只做通用传输（连 socket → 写帧 → 关）。
 *
 * 出处（非逆向）：Claude Code 文档 `cross-session-messaging#the-sessions-inbox-socket`
 * 明说该节用途含「让脚本或 hook 投递进会话」，并给出 auth 行格式；CLI 在 `--debug`
 * 里也打印完整配方。要点：
 * - 会话启动即把 socket / token 导出给**该会话自己的 hooks 与 Bash**（在任何 hook
 *   之前，含 SessionStart）——**每个会话进程各换一份**（socket 名随进程重新生成），
 *   所以旧值不可持久化复用，见 docs/plan/inbox-socket-delivery.md。
 * - 帧 = 换行分隔 JSON 两行：auth 行 + user 行；**native Windows 必须带 auth 行**
 *   （首行非合法 auth 行则连接被关、什么都不投递），macOS/Linux 可选（带上更好）。
 * - 接收侧照常走它自己的 inbound controls（Held/Refused/尺寸与突发上限）。
 */
export const CLAUDE_PROMPT_INBOX: PromptInboxSpec = {
  socketEnv: 'CLAUDE_CODE_MESSAGING_SOCKET',
  tokenEnv: 'CLAUDE_CODE_MESSAGING_TOKEN',
  requiresAuthOn: (platform) => platform === 'win32',
  frame: ({ token, text }) => {
    const lines: string[] = [];
    if (token) lines.push(JSON.stringify({ type: 'auth', token }));
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }));
    return lines.join('\n') + '\n';
  },
};
