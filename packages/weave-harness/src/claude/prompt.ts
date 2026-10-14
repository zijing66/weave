import type { PromptRelaySpec } from '../driver.js';
import { resolveClaudePeer } from './peers.js';

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
  resolve: resolveClaudePeer,
};
