import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/**
 * 角色插件 manifest（RPG 稿 §三 + 11.2#9 / 11.3#14 的角色半边）：角色 = 可复用的
 * weave 插件，市场分发——本文件定它的声明形态。与既有 `WeavePluginManifestSchema`
 * 同目录约定（`weave-plugin.json`）+ 新增 `role` 段；**不扩插件 schema 本体**
 * （插件机制改动走三件套硬约束，角色类型消费方在 RPG 侧）。
 *
 * 目录约定：
 * ```
 * <plugin>/
 *   weave-plugin.json     # 既有插件 manifest（+ role 段见下）
 *   persona/CLAUDE.md     # 人设素材（实例化时并入角色仓库）
 *   ```
 *
 * `role` 段声明（实例化 = 角色 provisioning 的输入）：
 * - archetype   七型模板（六维基线键）
 * - persona     人设素材路径（相对插件根）；实例化时读出的文本落角色仓库
 * - skills      默认装备清单（skill 名；修炼动词逐一安装）
 * - mcp         默认 MCP server 名（换装动词安装）
 * - plugins     默认插件 key（`<name>@<market>`，PluginSurface 键形唯一拼装点）
 */

export const RoleManifestSchema = z.object({
  archetype: z.string().min(1).max(20),
  persona: z.string().min(1).max(400),
  skills: z.array(z.string().min(1).max(200)).default([]),
  mcp: z.array(z.string().min(1).max(200)).default([]),
  plugins: z.array(z.string().min(1).max(200)).default([]),
});
export type RoleManifest = z.infer<typeof RoleManifestSchema>;

/** 既有插件 manifest 里认角色类型：`role` 段过 schema 即角色插件。 */
export const ROLE_MANIFEST_KEY = 'role';

export type RolePluginReadResult =
  | { ok: true; role: RoleManifest }
  | { ok: false; error: string };

/**
 * 从插件 manifest JSON 文本里取角色段（无 `role` 段 = 不是角色插件，ok:false
 * 且 error 说明原因——调用方据此跳过，不算错误）。
 */
export function readRoleManifest(manifestJson: string): RolePluginReadResult {
  let doc: unknown;
  try {
    doc = JSON.parse(manifestJson);
  } catch (err) {
    return { ok: false, error: `Invalid manifest JSON: ${err instanceof Error ? err.message : err}` };
  }
  if (typeof doc !== 'object' || doc === null || ROLE_MANIFEST_KEY in doc === false) {
    return { ok: false, error: 'Not a role plugin (no "role" section)' };
  }
  const parsed = RoleManifestSchema.safeParse((doc as Record<string, unknown>)[ROLE_MANIFEST_KEY]);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid role manifest: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    };
  }
  return { ok: true, role: parsed.data };
}

/** 读盘上插件目录的 manifest 并取角色段。 */
export async function readRolePlugin(pluginDir: string): Promise<RolePluginReadResult> {
  let raw: string;
  try {
    raw = await readFile(pluginDir, 'utf-8');
  } catch (err) {
    return { ok: false, error: `Cannot read manifest: ${err instanceof Error ? err.message : err}` };
  }
  return readRoleManifest(raw);
}

/** 人设素材全文（实例化时落角色仓库；读不到返回 null，调用方降级为空人设）。 */
export async function readPersonaFile(pluginRoot: string, relPath: string): Promise<string | null> {
  const full = path.resolve(pluginRoot, relPath);
  if (!full.startsWith(path.resolve(pluginRoot))) return null; // 路径穿越弃读
  try {
    return await readFile(full, 'utf-8');
  } catch {
    return null;
  }
}
