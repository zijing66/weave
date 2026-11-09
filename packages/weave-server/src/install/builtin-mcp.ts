/**
 * weave 自带、**由 daemon 托管**的 MCP 服务目录（Streamable HTTP）。
 *
 * **user 档安装入口已退役（E4）**：全集由 `rpg/provisioning.ts`（provisionRole /
 * scaffoldCoordinator）自动写进内建仓库的项目档 `.mcp.json`（令牌不进版本历史，
 * 托管 `.gitignore` 收 `.mcp.json` 一行）；资源管理里内置行只剩「随角色仓库自动
 * 配置」文案与存量 user 档装机的一次性迁移提示。端点 = daemon 的 `/mcp[/<server>]`
 * （`/mcp` 裸路径保留给编排，存量已装配置不断）。加一行前先在
 * `daemon/mcp/registry.ts` 注册实现。
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
  {
    name: 'weave-sessions',
    description:
      '活会话的观察/投递/问答/中断/订阅/改动汇总（daemon 托管的 Streamable HTTP MCP；仅本机）',
    path: '/mcp/sessions',
  },
  {
    name: 'weave-projects',
    description:
      '项目/harness 配置（词表粒度读写）/weave 插件装卸/skill 清单/资源市场（daemon 托管的 Streamable HTTP MCP；仅本机）',
    path: '/mcp/projects',
  },
  {
    name: 'weave-events',
    description:
      '事件流查询/仪表盘总量与速率/接口日志/会话用量（daemon 托管的 Streamable HTTP MCP；仅本机）',
    path: '/mcp/events',
  },
];
