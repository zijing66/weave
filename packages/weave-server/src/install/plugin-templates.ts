import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { WEAVE_PLUGIN_MANIFEST, WeavePluginManifestSchema, type WeavePluginManifest } from '@weavecode/core';
import { assetSurfaceFor } from '../surfaces.js';
import type { FingerprintCache } from './fingerprint.js';

/**
 * 项目自有 weave 源（`<project>/.weave/plugins/<plugin>/weave-plugin.json` 的
 * `manifest.templates`）与已物化副本之间的漂移。
 *
 * **声明即期望态**——没有账本：manifest 声明了哪个模板，其落点就该是那份内容。
 * 判据 = 目标缺失 / 内容与源不同（复用 FingerprintCache 的内容指纹，与
 * libraries 面同口径）。源根只看项目侧（全局插件根的模板不在本面，见
 * `packages/weave-cli/src/init/plugin-templates.ts` 的两根扫描）。
 *
 * 物化面只有 claude：init 的插件模板注入是 claude 的步（codex 该步
 * `skipNoFace`，见 `packages/weave-cli/src/init/harnesses/codex.ts`）——落点一律
 * 经 AssetSurface 取，本模块不拼 `.claude/` 路径。
 */

/** manifest.templates 的键（复数）→ 资产类别（单数）。 */
const TEMPLATE_CATEGORIES: Record<string, 'skill' | 'command' | 'agent'> = {
  skills: 'skill',
  commands: 'command',
  agents: 'agent',
};

export type PluginTemplateCategory = 'skill' | 'command' | 'agent';

export interface PluginTemplateUpdate {
  pluginId: string;
  category: PluginTemplateCategory;
  /** 模板名（basename 去 `.md`）。 */
  name: string;
  sourcePath: string;
  targetPath: string;
  /** 目标缺失或内容与源不同。 */
  outdated: boolean;
}

/** 枚举项目插件根的一级子目录，产出合法 manifest（解析失败即非插件目录）。 */
async function listPluginManifests(
  root: string,
): Promise<Array<{ dir: string; manifest: WeavePluginManifest }>> {
  const out: Array<{ dir: string; manifest: WeavePluginManifest }> = [];
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return out; // 根不存在 = 无项目插件
  }
  for (const name of names) {
    const dir = path.join(root, name);
    try {
      const raw = JSON.parse(await readFile(path.join(dir, WEAVE_PLUGIN_MANIFEST), 'utf8'));
      const parsed = WeavePluginManifestSchema.safeParse(raw);
      if (parsed.success) out.push({ dir, manifest: parsed.data });
    } catch {
      // 非插件目录 / manifest 损坏——交给 daemon 加载器报 rejected
    }
  }
  return out;
}

/** 一个插件的 manifest.templates → (源, 落点) 对；路径穿越的条目丢弃。 */
function resolveTemplates(
  projectPath: string,
  pluginDir: string,
  manifest: WeavePluginManifest,
): Array<Omit<PluginTemplateUpdate, 'outdated'>> {
  const out: Array<Omit<PluginTemplateUpdate, 'outdated'>> = [];
  if (!manifest.templates) return out;
  const surface = assetSurfaceFor('claude');
  const skillsDir = path.join(projectPath, ...surface.projectSkillsDir().split('/'));

  for (const [key, rels] of Object.entries(manifest.templates)) {
    const category = TEMPLATE_CATEGORIES[key];
    if (!category) continue;
    for (const rel of rels ?? []) {
      const sourcePath = path.resolve(pluginDir, rel);
      if (!sourcePath.startsWith(path.resolve(pluginDir) + path.sep)) continue; // 路径穿越
      const base = path.basename(sourcePath);
      const targetDir =
        category === 'skill'
          ? skillsDir
          : surface.targetDir(category, 'project', projectPath, homedir());
      out.push({
        pluginId: manifest.id,
        category,
        name: base.replace(/\.md$/, ''),
        sourcePath,
        targetPath: path.join(targetDir, base),
      });
    }
  }
  return out;
}

/** 项目插件模板的漂移清单（含全部声明，`outdated` 标注是否需同步）。 */
export async function detectPluginTemplateUpdates(
  projectPath: string,
  cache: FingerprintCache,
): Promise<PluginTemplateUpdate[]> {
  const out: PluginTemplateUpdate[] = [];
  const root = path.join(projectPath, '.weave', 'plugins');
  for (const { dir, manifest } of await listPluginManifests(root)) {
    for (const entry of resolveTemplates(projectPath, dir, manifest)) {
      const [src, dst] =
        entry.category === 'skill'
          ? await Promise.all([cache.get(entry.sourcePath), cache.get(entry.targetPath)])
          : await Promise.all([
              cache.getFile(entry.sourcePath),
              cache.getFile(entry.targetPath),
            ]);
      out.push({ ...entry, outdated: src !== dst });
    }
  }
  return out;
}

/**
 * 覆盖物化一个模板副本——显式同步动作，已存在的副本被源覆盖（init 侧的
 * `writeFileIfAbsent` 不覆盖语义不适用于用户点同步）。
 */
export async function materializePluginTemplate(t: PluginTemplateUpdate): Promise<void> {
  if (t.category === 'skill') {
    await rm(t.targetPath, { recursive: true, force: true });
    await cp(t.sourcePath, t.targetPath, { recursive: true });
    return;
  }
  await mkdir(path.dirname(t.targetPath), { recursive: true });
  await cp(t.sourcePath, t.targetPath);
}
