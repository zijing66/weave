import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename, relative, dirname } from 'node:path';
import type { Harness } from '@weave/core';
import { FILE_ASSET_SPECS, FILE_ASSET_CATEGORIES, type FileAssetCategory } from './file-assets.js';
import { hasNonEmptyModules } from '../watch/plugin-mods.js';
import { parseToolkitPack, type ToolkitKind, type ToolkitComponent } from '../hooks/toolkit-scan.js';

export interface SkillAsset {
  /** Skill name — the containing directory's basename. */
  name: string;
  /** Absolute path to the skill directory (copy this whole tree). */
  dirPath: string;
  /** Path relative to the library root (for display). */
  relPath: string;
  /**
   * The skill's parent directory (typically a `skills/` folder) relative to the
   * library root. Skills sharing a parent group together in the panel; an empty
   * string means the skill sits directly under the library root.
   */
  group: string;
}

/** Minimal MCP server template (matches Claude Code `.mcp.json` entry shape). */
export interface McpTemplate {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Absolute path to the JSON file this template was loaded from. */
  sourcePath: string;
  /** Path relative to the library root (for display). */
  relPath: string;
}

/** A single-file asset template (command / agent / workflow / rule / output-style). */
export interface FileAssetTemplate {
  /** Asset name — the file stem (e.g. "review" for review.md). */
  name: string;
  /** Absolute path to the template file (install = copy this one file). */
  filePath: string;
  /** Path relative to the library root (for display). */
  relPath: string;
  /** The kind directory's parent relative to the library root, for grouping. */
  group: string;
  category: FileAssetCategory;
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '.cache',
]);

/** 插件包发现于注册库内（市场扫描出口；web/src/lib/api.ts 镜像同形）。 */
export interface MarketPluginAsset {
  name: string;
  version: string;
  description?: string;
  /** Absolute path to the pack directory (install / enable source). */
  dirPath: string;
  /** Pack dir relative to the library root (posix; 包子树排除根的匹配键). */
  relPath: string;
  ccPack: boolean;
  weavePack: boolean;
  kind: ToolkitKind;
  components: ToolkitComponent[];
  targets: Harness[];
  /** Pack-internal skills carrying a SKILL.md（隶属包，随包启停，不独立安装）。 */
  skills: string[];
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * 窄包谓词——与 toolkit 的 `isToolkitPackDir` 刻意不同：裸表面（仅 skills/
 * 等目录）不算包，否则普通 skill 仓库会幻影出一个 plugin。mods（hooks.json
 * 非空 modules）归 plugin。
 */
async function isMarketPluginPack(dir: string): Promise<boolean> {
  if (await fileExists(join(dir, '.claude-plugin', 'plugin.json'))) return true;
  if (await fileExists(join(dir, 'weave-plugin.json'))) return true;
  try {
    const raw: unknown = JSON.parse(await readFile(join(dir, 'hooks', 'hooks.json'), 'utf8'));
    return hasNonEmptyModules(raw);
  } catch {
    return false;
  }
}

/** 防御性深度上限（病态树兜底）；正常仓库任意深度的包都要能发现。 */
const MAX_PACK_DEPTH = 10;

/**
 * 扫描库内插件包：**全递归**遍历任意深度子目录做窄谓词命中 → 解析委托
 * `parseToolkitPack` → 停钻（包是原子单元，不进包内找嵌套包）。`.claude`/
 * `.codex` 等点目录与 SKIP_DIRS 由 walk 跳过。
 *
 * 包内资源（skill/表面成分/mcp）**隶属该包**——不独立安装、随包启停；
 * 路由侧把返回的 relPath 集合作为 excludeRelRoots 传给其余三条扫描。
 */
export async function scanLibraryPlugins(libPath: string): Promise<MarketPluginAsset[]> {
  const out: MarketPluginAsset[] = [];
  const walk = async (dir: string, level: number): Promise<void> => {
    if (await isMarketPluginPack(dir)) {
      const pack = await parseToolkitPack(dir, { root: libPath, provenance: 'market' }, '');
      if (pack) {
        const skills: string[] = [];
        for (const n of pack.skills) {
          if (await fileExists(join(dir, 'skills', n, 'SKILL.md'))) skills.push(n);
        }
        out.push({
          name: pack.name,
          version: pack.version,
          ...(pack.description ? { description: pack.description } : {}),
          dirPath: pack.dir,
          relPath: relative(libPath, dir).replace(/\\/g, '/'),
          ccPack: pack.ccPack,
          weavePack: pack.weavePack,
          kind: pack.kind,
          components: pack.components,
          targets: pack.targets,
          skills,
        });
      }
      return; // 命中包即停钻（包不嵌套）
    }
    if (level >= MAX_PACK_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), level + 1);
    }
  };
  await walk(libPath, 0);
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/**
 * 包子树排除：`relPath` 位于任一排除根之内（含等于）→ true。
 * 排除根为 posix 相对路径；空串表示整库即包（全部资源隶属）。
 */
function inExcludedRoot(relPath: string, excludeRelRoots: readonly string[] | undefined): boolean {
  if (!excludeRelRoots || excludeRelRoots.length === 0) return false;
  return excludeRelRoots.some((r) => r === '' || relPath === r || relPath.startsWith(`${r}/`));
}

/**
 * Recursively scan a library directory for skills. A skill is any directory
 * that directly contains a `SKILL.md` file. Once a skill directory is found we
 * do NOT descend into it (its `assets/`, `scripts/`, `references/` subtrees are
 * part of the skill, not separate skills).
 *
 * Handles both library layouts: weave-templates (`templates/skills/<name>/SKILL.md`)
 * and personal libraries like zj-skills (`<name>/SKILL.md` at the top level).
 *
 * `excludeRelRoots`：位于插件包子树内的 skill 不产出——skill 隶属 plugin，
 * 随包启停、不独立安装（缺省空数组 = 现状行为，存量调用零改）。
 */
export async function scanLibrarySkills(
  libPath: string,
  excludeRelRoots?: string[],
): Promise<SkillAsset[]> {
  const results: SkillAsset[] = [];
  await walk(libPath, libPath, results, excludeRelRoots);
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

async function walk(
  root: string,
  dir: string,
  out: SkillAsset[],
  excludeRelRoots?: string[],
): Promise<void> {
  if (inExcludedRoot(relative(root, dir).replace(/\\/g, '/'), excludeRelRoots)) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable / missing — skip
  }

  if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
    out.push({
      name: basename(dir),
      dirPath: dir,
      relPath: relative(root, dir).replace(/\\/g, '/'),
      group: relative(root, dirname(dir)).replace(/\\/g, '/'),
    });
    return; // do not descend into a skill's own subtree
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    await walk(root, join(dir, entry.name), out, excludeRelRoots);
  }
}

/**
 * Scan a library for MCP server templates. A template is a JSON file that
 * either (a) IS a single server config `{ command, args?, env? }` named after
 * its file stem, or (b) wraps multiple servers under `mcpServers`. Two file
 * layouts are recognised: `<lib>/mcp/<name>.json` and `<lib>/<name>.mcp.json`.
 * Files that fail to parse are skipped (never throw).
 */
export async function scanLibraryMcp(
  libPath: string,
  excludeRelRoots?: string[],
): Promise<McpTemplate[]> {
  const files: { abs: string; rel: string }[] = [];
  await collectMcpFiles(libPath, libPath, files, excludeRelRoots);
  const out: McpTemplate[] = [];
  for (const f of files) {
    try {
      const parsed = JSON.parse(await readFile(f.abs, 'utf-8')) as unknown;
      pushTemplates(parsed, f, out);
    } catch {
      // malformed JSON — skip
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function collectMcpFiles(
  root: string,
  dir: string,
  out: { abs: string; rel: string }[],
  excludeRelRoots?: string[],
): Promise<void> {
  if (inExcludedRoot(relative(root, dir).replace(/\\/g, '/'), excludeRelRoots)) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      await collectMcpFiles(root, join(dir, e.name), out, excludeRelRoots);
    } else if (e.isFile()) {
      const stem = e.name.replace(/\.mcp\.json$/i, '').replace(/\.json$/i, '');
      // accept *.mcp.json anywhere, or *.json directly under a `mcp/` dir
      const isMcpJson = /\.mcp\.json$/i.test(e.name);
      const inMcpDir = basename(dir) === 'mcp' && /\.json$/i.test(e.name);
      if ((isMcpJson || inMcpDir) && stem) {
        out.push({ abs: join(dir, e.name), rel: relative(root, join(dir, e.name)).replace(/\\/g, '/') });
      }
    }
  }
}

function pushTemplates(
  parsed: unknown,
  file: { abs: string; rel: string },
  out: McpTemplate[],
): void {
  const stem = file.rel.replace(/\.mcp\.json$/i, '').replace(/\.json$/i, '').replace(/^.*\//, '');
  // Shape (b): { mcpServers: { <name>: { command, ... } } }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const servers = obj.mcpServers;
    if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
      for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
        const t = asTemplate(name, cfg);
        if (t) out.push({ ...t, sourcePath: file.abs, relPath: file.rel });
      }
      return;
    }
    // Shape (a): single server config, named after the file stem
    const t = asTemplate(stem, obj);
    if (t) out.push({ ...t, sourcePath: file.abs, relPath: file.rel });
  }
}

function asTemplate(name: string, cfg: unknown): { name: string; command: string; args?: string[]; env?: Record<string, string> } | null {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
  const c = cfg as Record<string, unknown>;
  if (typeof c.command !== 'string' || !c.command) return null;
  const t: { name: string; command: string; args?: string[]; env?: Record<string, string> } = {
    name,
    command: c.command,
  };
  if (Array.isArray(c.args)) t.args = c.args.filter((a) => typeof a === 'string');
  if (c.env && typeof c.env === 'object' && !Array.isArray(c.env)) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.env as Record<string, unknown>)) {
      if (typeof v === 'string') env[k] = v;
    }
    if (Object.keys(env).length) t.env = env;
  }
  return t;
}

/** kind-dir basename → category (e.g. "commands" → "command"). */
const KIND_DIR_NAMES: Record<string, FileAssetCategory> = Object.fromEntries(
  FILE_ASSET_CATEGORIES.map((c) => [basename(FILE_ASSET_SPECS[c].dir), c]),
);

/**
 * Scan a library for single-file asset templates. A directory whose basename
 * matches a kind dir ("commands", "agents", "workflows", "rules",
 * "output-styles") contributes its direct files of the matching extension;
 * the kind dir is not descended into. Directories containing SKILL.md are
 * always skipped — they are skill dirs, even if coincidentally named like a
 * kind dir. Results are grouped per kind.
 */
export async function scanLibraryFileAssets(
  libPath: string,
  excludeRelRoots?: string[],
): Promise<Record<FileAssetCategory, FileAssetTemplate[]>> {
  const out = {} as Record<FileAssetCategory, FileAssetTemplate[]>;
  for (const c of FILE_ASSET_CATEGORIES) out[c] = [];
  await walkFileAssets(libPath, libPath, out, excludeRelRoots);
  for (const c of FILE_ASSET_CATEGORIES) {
    out[c].sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
}

async function walkFileAssets(
  root: string,
  dir: string,
  out: Record<FileAssetCategory, FileAssetTemplate[]>,
  excludeRelRoots?: string[],
): Promise<void> {
  if (inExcludedRoot(relative(root, dir).replace(/\\/g, '/'), excludeRelRoots)) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable / missing — skip
  }
  if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) return; // a skill dir

  const kind = KIND_DIR_NAMES[basename(dir)];
  if (kind) {
    const spec = FILE_ASSET_SPECS[kind];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(spec.ext)) continue;
      const stem = e.name.slice(0, -spec.ext.length);
      if (!stem) continue;
      const abs = join(dir, e.name);
      out[kind].push({
        name: stem,
        filePath: abs,
        relPath: relative(root, abs).replace(/\\/g, '/'),
        group: relative(root, dirname(dir)).replace(/\\/g, '/'),
        category: kind,
      });
    }
    return; // do not descend into a kind dir
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    await walkFileAssets(root, join(dir, entry.name), out, excludeRelRoots);
  }
}
