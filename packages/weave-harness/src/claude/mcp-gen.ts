function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge weave's generated servers into an existing user .mcp.json.
 *
 * Policy (weave init never overwrites user files):
 * - user-authored server entries and unknown top-level keys are preserved
 * - missing generated servers are appended
 */
export function mergeMcpJson(
  existing: Record<string, unknown>,
  generated: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };

  const generatedServers = isPlainObject(generated['mcpServers']) ? generated['mcpServers'] : {};
  const servers = isPlainObject(merged['mcpServers']) ? { ...merged['mcpServers'] } : {};

  for (const [name, config] of Object.entries(generatedServers)) {
    if (servers[name] === undefined) servers[name] = config;
  }
  merged['mcpServers'] = servers;
  return merged;
}

/**
 * uninstall 用的剥除：删 `weave` 服务键（weave 自己的配置键）；mcpServers 清空
 * 删键；顶层清空返回空对象，调用方据此删文件。用户自己的服务键不动。
 *
 * 生成器（generateMcpJson / mergeMcpJson）已退役——init 不再写 `.mcp.json` 的
 * weave stdio 条目（daemon 托管 MCP 取代）；本函数只清存量。
 */
export function stripWeaveMcp(existing: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  if (isPlainObject(out['mcpServers'])) {
    const servers: Record<string, unknown> = { ...(out['mcpServers'] as Record<string, unknown>) };
    delete servers['weave'];
    if (Object.keys(servers).length > 0) out['mcpServers'] = servers;
    else delete out['mcpServers'];
  }
  return out;
}
