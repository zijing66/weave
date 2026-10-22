/**
 * weave 自带、**由 daemon 托管**的 MCP 服务目录（Streamable HTTP）。
 *
 * 它们不会自动写进用户配置，只在 MCP 页以「内置」行出现；安装**只允许 user 档**
 * （令牌会写进配置，项目档配置会跟着仓库走）。端点固定是 daemon 的 `/mcp`，
 * 安装时由服务端填入实际端口与本机令牌，前端永远看不到令牌。
 */
export interface BuiltinMcpServer {
  /** MCP 服务器名（写进配置的键）。 */
  name: string;
  /** 一句话说明（web 直接展示）。 */
  description: string;
  /** daemon 上的 MCP 端点路径。 */
  path: string;
}

export const BUILTIN_MCP_SERVERS: readonly BuiltinMcpServer[] = [
  {
    name: 'weave-orchestration',
    description:
      '编排的读写/校验/触发/运行日志（daemon 托管的 Streamable HTTP MCP；仅本机）',
    path: '/mcp',
  },
];
