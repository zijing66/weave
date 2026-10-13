import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import type { EnableOverride } from '@weavecode/core';

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

/** 以模型词表（on/off/inherit）覆写某服务器的启停，落 settings 三键。 */
export function setMcpEnableOverride(
  projectPath: string,
  name: string,
  state: EnableOverride,
): Promise<void> {
  return setMcpEnableState(projectPath, name, TO_FILE[state]);
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
