import type { PlatformInfo } from '@weave/core';

export interface McpGeneratorInput {
  platform: PlatformInfo;
  /** Whether to include the weave MCP server entry */
  includeWeaveServer: boolean;
}

export function generateMcpJson(input: McpGeneratorInput): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = {};

  if (input.includeWeaveServer) {
    const command = input.platform.os === 'windows' ? 'cmd' : 'npx';
    const args = input.platform.os === 'windows'
      ? ['/c', 'npx', 'weave', 'mcp', 'start']
      : ['weave', 'mcp', 'start'];

    mcpServers['weave'] = {
      command,
      args,
      env: { WEAVE_MCP: 'true' },
    };
  }

  return { mcpServers };
}
