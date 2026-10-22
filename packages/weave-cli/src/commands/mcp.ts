import type { Command } from '../parser.js';
import { runOrchestrationMcp } from '../mcp/orchestration-server.js';

/**
 * `weave mcp` —— 把 weave 的能力以 MCP 服务暴露给宿主。
 *
 * 当前只有 `orchestration`（stdio）：工具面只是 daemon 编排 API 的转发，
 * 不持有状态；宿主配置里写 `command: weave, args: ["mcp", "orchestration"]` 即可。
 */
export const mcpCommand: Command = {
  name: 'mcp',
  description: 'cmd.mcp.desc',
  subcommands: [
    {
      name: 'orchestration',
      description: 'cmd.mcp.orchestration.desc',
      action: async () => {
        await runOrchestrationMcp();
      },
    },
  ],
};
