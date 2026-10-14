import type { PromptRelaySpec } from '../driver.js';
import { resolveClaudePeer } from './peers.js';

/**
 * 单向注入注记（置于投递载荷头部）：本通道没有接收方会话——中继进程发完
 * 即退（`--no-session-persistence`），目标回的 SendMessage 必然落空。不加
 * 这句目标会把消息当聊天回一条，白烧一轮还可能报「找不到 @weave」。
 */
const ONE_WAY_NOTE =
  '[weave one-way injection — no reply is expected: do not call SendMessage or ListAgents, just act on this prompt in this session.]';

/**
 * prompt 通道层① 中继规格（spike E2E 实测 15.8s 全环）：受限工具集 headless
 * claude——只给 SendMessage/ListAgents；`--no-session-persistence` 不入 peer
 * 注册表零污染；投递指令全文走 stdin（命令行无用户内容，win32 .cmd shim 可
 * 安全经 shell 启动）。server 侧用中性 cwd 避开项目 hooks。
 */
export const CLAUDE_PROMPT_RELAY: PromptRelaySpec = {
  bin: 'claude',
  args: ['-p', '--no-session-persistence', '--tools', 'SendMessage,ListAgents', '-n', 'weave'],
  senderName: 'weave',
  instruction: (peerName, text) =>
    `Send the following message verbatim to the Claude session named "${peerName}" using the SendMessage tool, then stop. Do not use any other tool.\n\n${ONE_WAY_NOTE}\n\n${text}`,
  resolve: resolveClaudePeer,
};
