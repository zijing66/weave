import type { PromptRelaySpec } from '../driver.js';
import { resolveClaudePeer } from './peers.js';

/**
 * 单向注入注记（只给手动面，置于投递载荷头部）：手动发送没有接收方会话——
 * 中继进程发完即退（`--no-session-persistence`），目标回的 SendMessage 必然
 * 落空。不加这句目标会把消息当聊天回一条，白烧一轮还可能报「找不到 @weave」。
 * 编排域（序列步）不加：那是要保留的双向对话。
 */
const ONE_WAY_NOTE =
  '[weave one-way injection — no reply is expected: do not call SendMessage or ListAgents, just act on this prompt in this session.]';

/**
 * prompt 通道层① 中继规格（spike E2E 实测 15.8s 全环）：受限工具集 headless
 * claude——只给 SendMessage/ListAgents；`--no-session-persistence` 不入 peer
 * 注册表零污染；投递指令全文走 stdin（命令行无用户内容，win32 .cmd shim 可
 * 安全经 shell 启动）。server 侧用中性 cwd 避开项目 hooks。
 *
 * 启动开关（实测 2026-10-15）：`--strict-mcp-config`（中继不用任何 MCP 服务，
 * 别为它拉一遍）与 `--disable-slash-commands`（不解析 skills）——两项都验证过
 * 仍能正确应答且工具白名单照旧。**不要加 `--bare`**：它虽快 ~9×（38s→2.5s），
 * 但在当前 CLI 版本下 `--tools` 白名单失效（实测中继把提示词当检索意图、去调
 * WebSearch 而不投递），且只认 ANTHROPIC_API_KEY/apiKeyHelper（OAuth 会认证失败）。
 */
export const CLAUDE_PROMPT_RELAY: PromptRelaySpec = {
  bin: 'claude',
  args: [
    '-p',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--tools',
    'SendMessage,ListAgents',
    '-n',
    'weave',
  ],
  senderName: 'weave',
  instruction: (peerName, text, opts) =>
    `Send the following message verbatim to the Claude session named "${peerName}" using the SendMessage tool, then stop immediately. Do not use any other tool and do not wait for a reply — the handover is done once the tool call returns, so this process must exit promptly.\n\n${
      opts.oneWay ? `${ONE_WAY_NOTE}\n\n` : ''
    }${text}`,
  resolve: resolveClaudePeer,
};
