import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEAVE_PLUGIN_MANIFEST, WeavePluginManifestSchema, HARNESS_KEYS, type Harness } from '@weavecode/core';
import { hasNonEmptyModules } from '../watch/plugin-mods.js';
import { readSourcesFile } from './plugin-installer.js';

/**
 * 批 10 工具包扫描：内置 `presets/harness-tools/<scope>/<pack>/` 与用户
 * `add-dir` 注册的外置目录走同一条扫描管线，唯一区别是 provenance。
 * 不发明新格式——三种识别沿用既有约定：
 *   ① `.claude-plugin/plugin.json` → CC 插件包（组件清单由原生约定推导）
 *   ② `weave-plugin.json`          → weave 规则包（装载复用 plugin-loader）
 *   ③ 仅 `skills/` 等裸表面        → 表面解包包
 * 一个包可同时命中 ①②。
 */

export type ToolkitProvenance = 'builtin' | 'external-dir' | 'market';

/** 工具箱类型徽标：weave.json 显式标注优先，缺省由包内容推导。 */
export type ToolkitKind = 'skill' | 'hook' | 'mod' | 'rule' | 'surface';

export type ToolkitComponent = 'skill' | 'command' | 'agent' | 'hook' | 'mod' | 'rule';

export interface ToolkitSource {
  /** 扫描根：内置 harness-tools 根，或 add-dir 注册的本地目录。 */
  root: string;
  provenance: ToolkitProvenance;
}

export interface ToolkitPack {
  /** 包 id：weave manifest.id 优先，否则目录名。 */
  id: string;
  name: string;
  version: string;
  description?: string;
  /** 功能范围分组（根下一级容器目录名；包直接放根下时为空串）。 */
  scope: string;
  /** 源包目录（绝对路径）。 */
  dir: string;
  provenance: ToolkitProvenance;
  /** 所属扫描根（provenance 判别 + add-dir 级联卸载用）。 */
  sourceRoot: string;
  targets: Harness[];
  kind: ToolkitKind;
  components: ToolkitComponent[];
  /** 有 `.claude-plugin/plugin.json`（CC 原生包）。 */
  ccPack: boolean;
  /** 有 `weave-plugin.json`（weave 规则成分，走 plugin-loader）。 */
  weavePack: boolean;
  /** skills/ 下的 skill 目录名（表面解包用）。 */
  skills: string[];
}

const CC_MANIFEST_DIR = '.claude-plugin';
const CC_MANIFEST = 'plugin.json';
const TOOLKIT_MANIFEST = 'weave.json';
/** 扫描深度：root(0) → scope 容器(1) → pack(2)，对应 depth-3 树。 */
const MAX_SCAN_LEVEL = 2;
/**
 * market 源深度对齐市场扫描（install/scanner.ts MAX_PACK_DEPTH=10）：
 * 市场侧按 10 层发现的深包若 toolkit 侧 depth-2 截断，会因「toolkit 列表
 * 无此包」在资源市场 plugin 区显示为不可启用（mods 无安装按钮的成因之一）。
 */
const MARKET_MAX_SCAN_LEVEL = 10;
/** targets 缺省/全无效时的回落。 */
const DEFAULT_TARGETS: Harness[] = ['claude'];

/** 内置工具包源根（随 copy-presets.mjs 递归拷入 dist，depth-3 无需适配）。 */
export function builtinToolkitRoot(): string {
  // resolve 掉 fileURLToPath 可能保留的尾部分隔符——sourceRoot 参与记录与
  // source 消歧比较，必须是无尾分隔的规范形。
  return path.resolve(fileURLToPath(new URL('./presets/harness-tools/', import.meta.url)));
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function readJson(p: string): Promise<Record<string, unknown> | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(p, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 目录是否为一个工具包包位（四种识别任一命中）。 */
export async function isToolkitPackDir(dir: string): Promise<boolean> {
  if (await isStrictPackDir(dir)) return true;
  return (
    (await isDir(path.join(dir, 'skills'))) ||
    (await isDir(path.join(dir, 'commands'))) ||
    (await isDir(path.join(dir, 'agents')))
  );
}

/**
 * 严格包位：manifest（CC/weave）或 mods 谓词命中——不含裸表面识别。
 * 用于 market 源根层判定：库根只因 `skills/` 等裸表面命中时是「容器」而非
 * 包（skill 仓库根常带 skills/），当包会吞掉整棵树、嵌套包（mods）永远
 * 发现不了 → 资源市场 plugin 卡有、toolkit 清单无 → 「—」。
 */
async function isStrictPackDir(dir: string): Promise<boolean> {
  if (await readJson(path.join(dir, CC_MANIFEST_DIR, CC_MANIFEST))) return true;
  // weave manifest 只判断存在性（合法性交给 plugin-loader 校验，rejected 也是信息）
  try {
    await stat(path.join(dir, WEAVE_PLUGIN_MANIFEST));
    return true;
  } catch {
    // 继续判 mods
  }
  // mods-only 包（无 manifest、仅 hooks.json 非空 modules）
  return hasNonEmptyModules(await readJson(path.join(dir, 'hooks', 'hooks.json')));
}

async function listDirNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

async function listMarkdownNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name.replace(/\.md$/, ''))
      .sort();
  } catch {
    return [];
  }
}

function normalizeTargets(raw: unknown): Harness[] {
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_TARGETS;
  const out = raw.filter((h): h is Harness => HARNESS_KEYS.includes(h as Harness));
  return out.length > 0 ? out : DEFAULT_TARGETS;
}

/** 解析单个包目录；三种识别全未命中（无可装载成分）→ null。 */
export async function parseToolkitPack(
  dir: string,
  source: ToolkitSource,
  scope: string,
): Promise<ToolkitPack | null> {
  const dirName = path.basename(dir);
  const cc = await readJson(path.join(dir, CC_MANIFEST_DIR, CC_MANIFEST));
  const weaveRaw = await readJson(path.join(dir, WEAVE_PLUGIN_MANIFEST));
  const extra = await readJson(path.join(dir, TOOLKIT_MANIFEST));

  const skills = await listDirNames(path.join(dir, 'skills'));
  const commands = await listMarkdownNames(path.join(dir, 'commands'));
  const agents = await listMarkdownNames(path.join(dir, 'agents'));
  const hooksJson = await readJson(path.join(dir, 'hooks', 'hooks.json'));
  const isModPack = hasNonEmptyModules(hooksJson);
  const hasClassicHooks =
    !!hooksJson && typeof hooksJson['hooks'] === 'object' && hooksJson['hooks'] !== null;

  const components: ToolkitComponent[] = [];
  if (skills.length > 0) components.push('skill');
  if (commands.length > 0) components.push('command');
  if (agents.length > 0) components.push('agent');
  if (isModPack) components.push('mod');
  else if (hasClassicHooks) components.push('hook');
  if (weaveRaw) components.push('rule');
  if (components.length === 0) return null;

  const kindRaw = typeof extra?.['kind'] === 'string' ? extra['kind'] : null;
  const kind: ToolkitKind =
    kindRaw && ['skill', 'hook', 'mod', 'rule', 'surface'].includes(kindRaw)
      ? (kindRaw as ToolkitKind)
      : isModPack
        ? 'mod'
        : hasClassicHooks
          ? 'hook'
          : weaveRaw && !cc
            ? 'rule'
            : skills.length > 0
              ? 'skill'
              : 'surface';

  const weaveManifest = weaveRaw ? WeavePluginManifestSchema.safeParse(weaveRaw) : null;
  const id = weaveManifest?.success ? weaveManifest.data.id : dirName;
  const name =
    (typeof cc?.['name'] === 'string' ? cc['name'] : undefined) ??
    (weaveManifest?.success ? weaveManifest.data.name : undefined) ??
    dirName;
  const version =
    (weaveManifest?.success ? weaveManifest.data.version : undefined) ??
    (typeof cc?.['version'] === 'string' ? cc['version'] : undefined) ??
    '0.0.0';
  const description =
    (typeof cc?.['description'] === 'string' ? cc['description'] : undefined) ??
    (weaveManifest?.success ? weaveManifest.data.description : undefined);

  return {
    id,
    name,
    version,
    ...(description ? { description } : {}),
    scope,
    dir,
    provenance: source.provenance,
    sourceRoot: source.root,
    targets: normalizeTargets(extra?.['targets']),
    kind,
    components,
    ccPack: !!cc,
    weavePack: !!weaveRaw,
    skills,
  };
}

function skipEntry(name: string): boolean {
  return name === 'node_modules' || name.startsWith('.');
}

/**
 * 递归发现扫描根下的全部包：根自身可为包（外置目录直接指到包），
 * 否则下钻到 level ≤ 2（root → scope → pack；market 源放宽到 10 对齐
 * 市场扫描）；命中包即停（包不嵌套）。
 * 例外：market 源根层仅裸表面命中 → 视为容器继续下钻（见 isStrictPackDir）。
 */
export async function discoverToolkitPacks(source: ToolkitSource): Promise<ToolkitPack[]> {
  const out: ToolkitPack[] = [];
  const market = source.provenance === 'market';
  const maxLevel = market ? MARKET_MAX_SCAN_LEVEL : MAX_SCAN_LEVEL;
  const walk = async (dir: string, level: number, scope: string): Promise<void> => {
    if (await isToolkitPackDir(dir)) {
      // market 根层裸表面（如 skill 仓库根的 skills/）= 容器而非包：
      // 当包会 return 吞掉整棵树，嵌套 mods/manifest 包永远不被发现。
      const bareSurfaceContainer = level === 0 && market && !(await isStrictPackDir(dir));
      if (!bareSurfaceContainer) {
        const pack = await parseToolkitPack(dir, source, scope);
        if (pack) out.push(pack);
        return;
      }
    }
    if (level >= maxLevel) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在 = 无包
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || skipEntry(entry.name)) continue;
      await walk(path.join(dir, entry.name), level + 1, level === 0 ? entry.name : scope);
    }
  };
  await walk(source.root, 0, '');
  return out;
}

/** 内置根 + sources.json 注册的外置目录（同一管线，仅 provenance 不同）。 */
export async function discoverToolkitSources(): Promise<ToolkitSource[]> {
  const sources: ToolkitSource[] = [{ root: builtinToolkitRoot(), provenance: 'builtin' }];
  const { dirs } = await readSourcesFile();
  for (const dir of dirs) sources.push({ root: dir, provenance: 'external-dir' });
  return sources;
}

/**
 * 扫描根下含 `weave-plugin.json` 的包目录（depth ≤ 2，同 discoverToolkitPacks
 * 的下钻规则但只认 weave 成分）——plugin-loader 的深度扫描入口。
 */
export async function discoverWeavePackDirs(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, level: number): Promise<void> => {
    try {
      await stat(path.join(dir, WEAVE_PLUGIN_MANIFEST));
      out.push(dir);
      return; // 包不嵌套
    } catch {
      // 非包位继续下钻
    }
    if (level >= MAX_SCAN_LEVEL) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || skipEntry(entry.name)) continue;
      await walk(path.join(dir, entry.name), level + 1);
    }
  };
  await walk(root, 0);
  return out;
}
