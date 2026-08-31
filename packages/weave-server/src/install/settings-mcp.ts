import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';

/**
 * Per-project MCP enable/disable state, stored in `.claude/settings.json`.
 *
 * Claude Code honours `enableAllProjectMcpServers` (boolean) plus
 * `enabledMcpjsonServers` / `disabledMcpjsonServers` (string arrays of server
 * names) to override the default trust prompt per server. weave persists a
 * tri-state per project server name and rewrites only those three keys,
 * preserving everything else in settings.json.
 */

const SETTINGS_FILE = '.claude/settings.json';

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readSettings(projectPath: string): Promise<Record<string, unknown>> {
  const file = path.join(projectPath, SETTINGS_FILE);
  if (!(await pathExists(file))) return {};
  try {
    const parsed = JSON.parse(await readFile(file, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function writeSettings(projectPath: string, settings: Record<string, unknown>): Promise<void> {
  const file = path.join(projectPath, SETTINGS_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
}

export type McpEnableState = 'enabled' | 'disabled' | 'default';

export interface McpEnableMap {
  /** name → enable state for servers with an explicit override. */
  overrides: Record<string, McpEnableState>;
  /** Whether `enableAllProjectMcpServers` is set true. */
  enableAll: boolean;
}

/** Read the MCP enable map from settings.json. */
export async function readMcpEnableMap(projectPath: string): Promise<McpEnableMap> {
  const s = await readSettings(projectPath);
  const enabled = arr(s.enabledMcpjsonServers);
  const disabled = arr(s.disabledMcpjsonServers);
  const overrides: Record<string, McpEnableState> = {};
  for (const n of enabled) overrides[n] = 'enabled';
  for (const n of disabled) overrides[n] = 'disabled';
  return { overrides, enableAll: s.enableAllProjectMcpServers === true };
}

/** Set the enable state for one project MCP server, then persist settings.json. */
export async function setMcpEnableState(
  projectPath: string,
  name: string,
  state: McpEnableState,
): Promise<void> {
  const s = await readSettings(projectPath);
  const enabled = new Set(arr(s.enabledMcpjsonServers));
  const disabled = new Set(arr(s.disabledMcpjsonServers));
  enabled.delete(name);
  disabled.delete(name);
  if (state === 'enabled') enabled.add(name);
  else if (state === 'disabled') disabled.add(name);
  // 'default' → present in neither array
  patch(s, 'enabledMcpjsonServers', enabled);
  patch(s, 'disabledMcpjsonServers', disabled);
  await writeSettings(projectPath, s);
}

function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

function patch(s: Record<string, unknown>, key: string, set: Set<string>): void {
  if (set.size === 0) {
    delete s[key];
  } else {
    s[key] = [...set].sort();
  }
}
