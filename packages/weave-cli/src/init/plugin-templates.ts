import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import {
  detectPlatform,
  WEAVE_PLUGIN_MANIFEST,
  WeavePluginManifestSchema,
  type WeavePluginManifest,
} from '@weavecode/core';
import { templateRegistry, type TemplateEntry } from '@weavecode/templates';

/** 遍历两个插件根（全局 + 项目）的一级子目录，产出合法 manifest。 */
async function* iteratePluginManifests(
  projectDir: string,
  globalRoot?: string,
): AsyncGenerator<{ dir: string; manifest: WeavePluginManifest }> {
  const roots = [
    globalRoot ?? path.join(detectPlatform().configDir, 'weave', 'plugins'),
    path.join(projectDir, '.weave', 'plugins'),
  ];
  for (const root of roots) {
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      continue; // 目录不存在 = 无插件
    }
    for (const name of names) {
      const dir = path.join(root, name);
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(path.join(dir, WEAVE_PLUGIN_MANIFEST), 'utf8'));
      } catch {
        continue; // 非插件目录（manifest 解析失败交给 daemon 加载器报 rejected）
      }
      const parsed = WeavePluginManifestSchema.safeParse(raw);
      if (parsed.success) yield { dir, manifest: parsed.data };
    }
  }
}

/**
 * 扩展点③（模板注入）的发现面：扫描插件根目录的 manifest.templates，
 * 注册进 TemplateRegistry（name = `<pluginId>:<模板名>`，内置优先冲突拒绝）。
 * 纯读取不落库——插件规则由 daemon 的 plugin-loader 负责，init 只关心模板。
 */
export async function registerPluginTemplates(
  projectDir: string,
  globalRoot?: string,
): Promise<{ registered: TemplateEntry[]; skipped: string[] }> {
  const registered: TemplateEntry[] = [];
  const skipped: string[] = [];

  for await (const { dir, manifest } of iteratePluginManifests(projectDir, globalRoot)) {
    if (!manifest.templates) continue;
    const { id, templates } = manifest;

    // manifest 键是复数（skills/commands/agents），TemplateEntry.category 是单数
    const CATEGORY_OF: Record<string, 'skill' | 'command' | 'agent'> = {
      skills: 'skill',
      commands: 'command',
      agents: 'agent',
    };
    for (const [key, paths] of Object.entries(templates)) {
      const category = CATEGORY_OF[key];
      if (!category) continue;
      for (const rel of paths ?? []) {
        const abs = path.resolve(dir, rel);
        if (!abs.startsWith(path.resolve(dir) + path.sep)) {
          skipped.push(rel); // 路径穿越
          continue;
        }
        const base = path.basename(abs).replace(/\.md$/, '');
        const entry: TemplateEntry = {
          name: `${id}:${base}`,
          category,
          sourcePath: abs,
          description: `${id} 插件模板`,
        };
        if (templateRegistry.register(entry)) registered.push(entry);
        else skipped.push(entry.name); // 同名（内置或先前注册）拒绝
      }
    }
  }
  return { registered, skipped };
}

/**
 * 扩展点④（MCP server 定义）：收集插件 manifest.mcpServers 供 init 合并进 .mcp.json。
 * 冲突策略（namespace）：与 `existing`（核心已生成的 server 名）或其他插件同名时
 * 重命名为 `<pluginId>-<name>`——绝不覆盖核心 server。
 */
export async function collectPluginMcpServers(
  projectDir: string,
  globalRoot?: string,
  existing: string[] = [],
): Promise<{ servers: Record<string, unknown>; renamed: string[] }> {
  const servers: Record<string, unknown> = {};
  const renamed: string[] = [];
  const taken = new Set(existing);

  for await (const { manifest } of iteratePluginManifests(projectDir, globalRoot)) {
    if (!manifest.mcpServers) continue;
    for (const [name, config] of Object.entries(manifest.mcpServers)) {
      let key = name;
      if (taken.has(key)) {
        key = `${manifest.id}-${name}`;
        renamed.push(`${name} → ${key}`);
      }
      taken.add(key);
      servers[key] = config;
    }
  }
  return { servers, renamed };
}
