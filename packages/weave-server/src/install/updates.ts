import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Harness } from '@weavecode/core';
import { FingerprintCache, hashMcpConfig } from './fingerprint.js';
import {
  buildLibraryIndex,
  findSkillSource,
  findMcpSource,
  findFileAssetSource,
  type LibraryIndex,
} from './library-index.js';
import { readMcpServers } from './installer.js';
import { readGlobalMcpServers, readGlobalSkills } from './global-config.js';
import { readCodexMcpServers } from './codex-toml.js';
import { FILE_ASSET_CATEGORIES, FILE_ASSET_SPECS } from './file-assets.js';
import type { FileAssetCategory } from './file-assets.js';
import { assetSurfaces } from '../surfaces.js';
import { readInstalledLedger } from './install-ledger.js';
import {
  detectPluginTemplateUpdates,
  type PluginTemplateUpdate,
} from './plugin-templates.js';
import { detectInitFileUpdates, needsInit, type InitFileUpdate } from './init-files.js';
import type { LibraryRow } from '../repositories/libraries.js';

/**
 * Update detection — compares installed assets against their library sources.
 *
 * An installed skill is "outdated" when its directory content hash differs from
 * the source directory's hash; an MCP entry is outdated when its config hash
 * differs from the source template's; a file asset when its file hash differs.
 * Assets without a matching library source are `custom` (no update path) —
 * e.g. hand-authored skills or MCP entries added via the form, not from a
 * template.
 *
 * Scope + agent are inferred from the install path:
 *   project skill → `<project>/.claude/skills/<name>/` (claude)
 *                   `<project>/.codex/skills/<name>/`  (codex)
 *   user    skill → `~/.claude/skills/<name>/` (claude) · `~/.agents/skills/<name>/` (codex)
 *   project mcp   → `.mcp.json`
 *   user    mcp   → `~/.claude.json`
 *   codex   mcp   → `~/.codex/config.toml`
 */

export interface SkillUpdate {
  name: string;
  scope: 'project' | 'user';
  /** Which agent's surface the skill is installed on. */
  agent: Harness;
  /** true = installed content differs from source (update available). */
  outdated: boolean;
  /** true = no library source found (cannot update). */
  custom: boolean;
  /** true = 账本登记过但盘上已不在（补齐路径会重装）。 */
  missing?: boolean;
  /** Resolved source directory when not custom. */
  sourceDir?: string;
  libraryId?: number;
}

export interface McpUpdate {
  name: string;
  scope: 'project' | 'user';
  /** Which agent's surface the server is configured on (Codex = config.toml). */
  agent?: Harness;
  outdated: boolean;
  custom: boolean;
  /** true = 账本登记过但配置已不在（补齐路径会重新写回）。 */
  missing?: boolean;
  libraryId?: number;
}

export interface FileAssetUpdate {
  category: FileAssetCategory;
  name: string;
  scope: 'project' | 'user';
  outdated: boolean;
  custom: boolean;
  /** true = 账本登记过但盘上已不在（补齐路径会重装）。 */
  missing?: boolean;
  libraryId?: number;
}

export interface UpdateReport {
  skills: SkillUpdate[];
  mcp: McpUpdate[];
  files: FileAssetUpdate[];
  /** 项目自有 weave 源（`.weave/plugins` 的 manifest.templates）的物化漂移。 */
  pluginTemplates: PluginTemplateUpdate[];
  /** init 生成物的漂移（不进 git 的可自愈；会进 git 的只报不写）。 */
  initFiles: InitFileUpdate[];
  /** Count of outdated assets sync can actually apply（含 auto 归类的 init 文件）。 */
  available: number;
  /** 会进 git 的 init 文件有漂移 → dashboard 提醒用户跑 `weave init`。 */
  needsInit: boolean;
}

/**
 * Detect skill + MCP + file-asset updates for a project against the registered
 * libraries. `index` may be passed in (reused across calls) or omitted to
 * rebuild it.
 */
export async function detectUpdates(
  projectPath: string,
  libraries: LibraryRow[],
  cache: FingerprintCache,
  index?: LibraryIndex,
): Promise<UpdateReport> {
  const idx = index ?? (await buildLibraryIndex(libraries));
  // 四路各自独立（技能哈希的 stat 往返、init 文件的 git 子进程、配置读取），
  // 串起来就是四段耗时相加；并行后总耗时为最慢那一路。
  const [skills, mcp, files, pluginTemplates, initFiles] = await Promise.all([
    detectSkillUpdates(projectPath, cache, idx),
    detectMcpUpdates(projectPath, idx),
    detectFileAssetUpdates(projectPath, cache, idx),
    // 项目自有 weave 源无账本（声明即期望态），不随 libraries 存亡——独立扫描。
    detectPluginTemplateUpdates(projectPath, cache),
    // init 生成物同样无账本（期望态由 harness 生成器给），按 git 归类分流。
    detectInitFileUpdates(projectPath),
  ]);
  // 账本补齐：报告是按盘面枚举的，"账上有、报告里没有"就等于盘上已被删除。
  await mergeMissingFromLedger(projectPath, { skills, mcp, files }, idx);
  const available = skills.filter((s) => !s.custom && s.outdated).length
    + mcp.filter((s) => !s.custom && s.outdated).length
    + files.filter((s) => !s.custom && s.outdated).length
    + pluginTemplates.filter((t) => t.outdated).length
    + initFiles.filter((f) => f.outdated && f.syncClass === 'auto').length;
  return {
    skills,
    mcp,
    files,
    pluginTemplates,
    initFiles,
    available,
    needsInit: needsInit(initFiles),
  };
}

/** 项目行推送面的一行摘要：角标条数 + 「待 init」提醒（同一次检测的两个面）。 */
export interface ProjectUpdateSummary {
  /** 可代写同步的过期项数（含 auto 归类的 init 文件）。 */
  available: number;
  /** 会进 git 的 init 文件有漂移 → 提醒用户跑 `weave init`。 */
  needsInit: boolean;
}

/**
 * 全项目更新摘要（projectId → 摘要，含 0/false）：项目行角标推送面的数据源。
 * 与 `GET /projects/:id/updates` 同一检测函数（同源不双算），库索引一轮构建
 * 一次、整轮复用。
 */
export async function detectProjectUpdateCounts(
  projects: ReadonlyArray<{ id: number; path: string }>,
  libraries: LibraryRow[],
  cache: FingerprintCache,
): Promise<Record<number, ProjectUpdateSummary>> {
  const index = await buildLibraryIndex(libraries);
  const out: Record<number, ProjectUpdateSummary> = {};
  for (const project of projects) {
    const report = await detectUpdates(project.path, libraries, cache, index);
    out[project.id] = { available: report.available, needsInit: report.needsInit };
  }
  return out;
}

/**
 * 把账本里"账上有、盘上无"的资产并进报告（标记 `missing` + `outdated`，复用
 * syncAll 已有的重装路径）。库源已消失的条目跳过——无从重装，标出来只会让
 * 同步报错。scope 只认 project：全局资产是用户级共享，不随项目同步走。
 */
async function mergeMissingFromLedger(
  projectPath: string,
  report: { skills: SkillUpdate[]; mcp: McpUpdate[]; files: FileAssetUpdate[] },
  idx: LibraryIndex,
): Promise<void> {
  for (const record of await readInstalledLedger(projectPath)) {
    if (record.category === 'skill') {
      if (!findSkillSource(idx, record.name)) continue;
      const present = report.skills.some(
        (s) => s.scope === 'project' && s.name === record.name && s.agent === record.agent,
      );
      if (present) continue;
      report.skills.push({
        name: record.name,
        scope: 'project',
        agent: record.agent,
        outdated: true,
        custom: false,
        missing: true,
      });
      continue;
    }
    if (record.category === 'mcp') {
      if (!findMcpSource(idx, record.name)) continue;
      if (report.mcp.some((m) => m.scope === 'project' && m.name === record.name)) continue;
      report.mcp.push({
        name: record.name,
        scope: 'project',
        outdated: true,
        custom: false,
        missing: true,
      });
      continue;
    }
    const assetCategory = record.assetCategory;
    if (assetCategory === undefined || !findFileAssetSource(idx, assetCategory, record.name)) continue;
    const present = report.files.some(
      (f) => f.scope === 'project' && f.category === assetCategory && f.name === record.name,
    );
    if (present) continue;
    report.files.push({
      category: assetCategory,
      name: record.name,
      scope: 'project',
      outdated: true,
      custom: false,
      missing: true,
    });
  }
}

/** List installed skill names under a skills root (dirs + symlinks to dirs —
 * user-level installs are symlinks, which `Dirent.isDirectory()` alone misses
 * because it reports the link type, not the target). */
async function listSkillNames(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    try {
      if ((await stat(path.join(dir, e.name))).isDirectory()) out.push(e.name);
    } catch {
      // vanished or broken link — skip
    }
  }
  return out;
}

/** Detect skill updates (project + user, Claude + Codex) against the index. */
export async function detectSkillUpdates(
  projectPath: string,
  cache: FingerprintCache,
  idx: LibraryIndex,
): Promise<SkillUpdate[]> {
  const home = homedir();
  // 项目面与 user 面皆由各 harness 的资产面派生（项目根 = projectSkillsRoots[0]，
  // 全局根 = globalSkillsRoots[0]——只扫安装目标根，其后的只读根不入更新面：更新
  // 会写回 [0]，把共用根里别人铺的那份再铺一遍只会被宿主遮住）。
  // 顺序与原硬编码一致：先全部项目面、再全部 user 面（按 harness 注册序）。
  const surfaces: { dir: string; scope: 'project' | 'user'; agent: Harness }[] = [
    ...assetSurfaces().map((s) => ({
      dir: path.join(projectPath, ...s.projectSkillsRoots()[0].split('/')),
      scope: 'project' as const,
      agent: s.harness,
    })),
    ...assetSurfaces().map((s) => ({
      dir: s.globalSkillsRoots(home)[0],
      scope: 'user' as const,
      agent: s.harness,
    })),
  ];
  const out: SkillUpdate[] = [];
  for (const surface of surfaces) {
    for (const name of await listSkillNames(surface.dir)) {
      const installedDirName = path.join(surface.dir, name);
      const src = findSkillSource(idx, name);
      if (!src) {
        out.push({
          name,
          scope: surface.scope,
          agent: surface.agent,
          outdated: false,
          custom: true,
        });
        continue;
      }
      const [installedHash, sourceHash] = await Promise.all([
        cache.get(installedDirName),
        cache.get(src.dirPath),
      ]);
      out.push({
        name,
        scope: surface.scope,
        agent: surface.agent,
        outdated: installedHash !== sourceHash,
        custom: false,
        sourceDir: src.dirPath,
        libraryId: src.libraryId,
      });
    }
  }
  return out;
}

/** Detect single-file asset updates (commands/agents/workflows/rules/output-styles). */
export async function detectFileAssetUpdates(
  projectPath: string,
  cache: FingerprintCache,
  idx: LibraryIndex,
): Promise<FileAssetUpdate[]> {
  const out: FileAssetUpdate[] = [];
  for (const category of FILE_ASSET_CATEGORIES) {
    const spec = FILE_ASSET_SPECS[category];
    // Project surface only — user-level dirs (~/.claude/commands, …) are
    // managed by hand and rarely mirrored by a library; revisit if asked.
    // 这里的 skill/文件资产更新检测面向项目面；claude 是唯一有项目文件资产面的
    // harness，故取 claude 落点（无则跳过该类别）。
    const projectDir = spec.dirs.claude?.project;
    if (!projectDir) continue;
    const dir = path.join(projectPath, ...projectDir.split('/'));
    let files: string[];
    try {
      files = (await readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith(spec.ext))
        .map((e) => e.name);
    } catch {
      continue; // kind not present in this project
    }
    for (const file of files) {
      const name = file.slice(0, -spec.ext.length);
      const src = findFileAssetSource(idx, category, name);
      if (!src) {
        out.push({ category, name, scope: 'project', outdated: false, custom: true });
        continue;
      }
      const [installedHash, sourceHash] = await Promise.all([
        cache.getFile(path.join(dir, file)),
        cache.getFile(src.filePath),
      ]);
      out.push({
        category,
        name,
        scope: 'project',
        outdated: installedHash !== sourceHash,
        custom: false,
        libraryId: src.libraryId,
      });
    }
  }
  return out;
}

/** Detect MCP updates (project + user + Codex config.toml) against the index. */
async function detectMcpUpdates(projectPath: string, idx: LibraryIndex): Promise<McpUpdate[]> {
  const [projectServers, globalServers, codexServers] = await Promise.all([
    readMcpServers(projectPath).catch(() => ({})),
    readGlobalMcpServers().catch(() => ({})),
    readCodexMcpServers().catch(() => ({})),
  ]);
  const out: McpUpdate[] = [];
  for (const [name, cfg] of Object.entries(projectServers)) {
    const src = findMcpSource(idx, name);
    if (!src) {
      out.push({ name, scope: 'project', outdated: false, custom: true });
    } else {
      out.push({
        name,
        scope: 'project',
        outdated: hashMcpConfig(cfg) !== hashMcpConfig(src.config),
        custom: false,
        libraryId: src.libraryId,
      });
    }
  }
  for (const [name, cfg] of Object.entries(globalServers)) {
    const src = findMcpSource(idx, name);
    if (!src) {
      out.push({ name, scope: 'user', outdated: false, custom: true });
    } else {
      out.push({
        name,
        scope: 'user',
        outdated: hashMcpConfig(cfg) !== hashMcpConfig(src.config),
        custom: false,
        libraryId: src.libraryId,
      });
    }
  }
  for (const [name, cfg] of Object.entries(codexServers)) {
    const src = findMcpSource(idx, name);
    if (!src) {
      out.push({ name, scope: 'user', agent: 'codex', outdated: false, custom: true });
    } else {
      out.push({
        name,
        scope: 'user',
        agent: 'codex',
        outdated: hashMcpConfig(cfg) !== hashMcpConfig(src.config),
        custom: false,
        libraryId: src.libraryId,
      });
    }
  }
  return out;
}

/** Re-export for callers that only want the global skills listing. */
export { readGlobalSkills };

