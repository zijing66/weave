import { homedir } from 'node:os';
import type { McpServerConfig } from './installer.js';
import { assetSurfaceFor } from '../surfaces.js';
import {
  codexMcpExists as codexMcpExistsAt,
  readCodexMcpServers as readCodexMcpServersAt,
  removeCodexMcpServer as removeCodexMcpServerAt,
  writeCodexMcpServer as writeCodexMcpServerAt,
} from '@weavecode/harness';

/**
 * Codex config.toml 的 server 侧入口：路径解析 + 把 harness 里的表示法绑上默认
 * 路径。行级编辑与 `[mcp_servers.<name>]` 这一形都住 @weavecode/harness
 * （`codex/toml.ts` / `codex/mcp.ts`），本模块原位置 re-export，存量 import 零改动。
 */
export {
  CodexTomlCorruptError,
  parseDottedKey,
  sectionHeaderKey,
  renderTomlKey,
  renderTomlHeader,
  renderTomlString,
  splitTomlSections,
  upsertTomlSection,
  removeTomlSection,
  parseSectionEntries,
  upsertCodexPluginEnabledInText,
  readCodexMcpFromText,
  upsertCodexMcpInText,
  removeCodexMcpFromText,
} from '@weavecode/harness';
export type { TomlSection } from '@weavecode/harness';

/** Absolute path of the Codex user config (`~/.codex/config.toml`).
 * 批 4a：路径本体在 AssetSurface（`userConfigFile`）。 */
export function codexConfigFile(home: string = homedir()): string {
  return assetSurfaceFor('codex').userConfigFile(home);
}

/** Read MCP servers from `~/.codex/config.toml` (empty when absent/corrupt). */
export function readCodexMcpServers(
  file: string = codexConfigFile(),
): Promise<Record<string, McpServerConfig>> {
  return readCodexMcpServersAt(file);
}

/** Whether an `[mcp_servers.<name>]` section exists (cheap line-level check). */
export function codexMcpExists(name: string, file: string = codexConfigFile()): Promise<boolean> {
  return codexMcpExistsAt(name, file);
}

/** Insert or replace an MCP server in `~/.codex/config.toml` (refuses a
 * config that does not parse; creates the file when absent). */
export function writeCodexMcpServer(
  name: string,
  config: McpServerConfig,
  file: string = codexConfigFile(),
): Promise<void> {
  return writeCodexMcpServerAt(name, config, file);
}

/** Remove an MCP server section from `~/.codex/config.toml`. Returns whether
 * a section was removed (false = was not configured). */
export function removeCodexMcpServer(
  name: string,
  file: string = codexConfigFile(),
): Promise<boolean> {
  return removeCodexMcpServerAt(name, file);
}
