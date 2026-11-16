import type { EnableOverride } from '@weavecode/core';
import { CLAUDE_ASSETS } from '@weavecode/harness';

/**
 * Per-project MCP enable/disable state（工具对象模型 ⇄ settings 三键族的词表桥）。
 * settings.json 的键形与落盘归 claude 能力面（AssetSurface.mcpEnableRead/Write），
 * server 只做 on/off/inherit 模型词表桥与生效态解析。
 */

export type McpEnableState = 'enabled' | 'disabled' | 'default';

export interface McpEnableMap {
  /** name → enable state for servers with an explicit override. */
  overrides: Record<string, McpEnableState>;
  /** Whether `enableAllProjectMcpServers` is set true. */
  enableAll: boolean;
}

/** Read the MCP enable map via the harness asset surface. */
export async function readMcpEnableMap(projectPath: string): Promise<McpEnableMap> {
  const read = CLAUDE_ASSETS.mcpEnableRead;
  if (!read) return { overrides: {}, enableAll: false };
  return read.call(CLAUDE_ASSETS, projectPath);
}

// --- 工具对象模型词表桥（模型 on/off/inherit ⇄ settings 文件 enabled/…） ---

const TO_MODEL: Record<McpEnableState, EnableOverride> = {
  enabled: 'on',
  disabled: 'off',
  default: 'inherit',
};

const TO_FILE: Record<EnableOverride, McpEnableState> = {
  on: 'enabled',
  off: 'disabled',
  inherit: 'default',
};

/** 某服务器的覆写态，以模型词表返回（无覆写 = inherit）。 */
export function mcpOverrideOf(map: McpEnableMap, name: string): EnableOverride {
  return TO_MODEL[map.overrides[name] ?? 'default'];
}

/** 生效态解析（服务端唯一）：显式覆写优先，未覆写跟随 enableAll。 */
export function resolveMcpEffective(map: McpEnableMap, name: string): boolean {
  const state = map.overrides[name];
  if (state === 'enabled') return true;
  if (state === 'disabled') return false;
  return map.enableAll;
}

/** Set the enable state for one project MCP server via the asset surface. */
export async function setMcpEnableState(
  projectPath: string,
  name: string,
  state: McpEnableState,
): Promise<void> {
  const write = CLAUDE_ASSETS.mcpEnableWrite;
  if (!write) return;
  await write.call(CLAUDE_ASSETS, projectPath, name, state);
}

/** 以模型词表（on/off/inherit）覆写某服务器的启停。 */
export function setMcpEnableOverride(
  projectPath: string,
  name: string,
  state: EnableOverride,
): Promise<void> {
  return setMcpEnableState(projectPath, name, TO_FILE[state]);
}
