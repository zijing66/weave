import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { hashFile } from '../install/fingerprint.js';
import { fileAssetTargetDir } from '../install/file-assets.js';
import { assetSurfaceFor } from '../surfaces.js';
import type { ProjectRepository, ProjectRow } from '../repositories/projects.js';
import type { PluginStateRepository } from '../repositories/plugin-states.js';
import type { LoadedPluginInfo, PluginManager } from './plugin-loader.js';
import {
  addToolkitDir,
  readSourcesFile,
  removeToolkitDir,
} from './plugin-installer.js';
import {
  builtinToolkitRoot,
  discoverToolkitPacks,
  type ToolkitPack,
  type ToolkitSource,
} from './toolkit-scan.js';

/**
 * 批 10 工具包服务：按包成分分三条既有管线启用/禁用——
 *   ① 插件位整体（CC 原生包原样复制进项目 `.claude/plugins/<pack>/`，禁用按
 *      checksum 清扫：用户改写过的文件保留）；
 *   ② 表面解包（裸表面/Codex → 批 4a AssetSurface 目标目录，同 checksum 清扫）；
 *   ③ weave 规则成分（既有 plugin-loader 注册，`plugin_states` 级联到包开关）。
 * 状态单一事实源 = 落盘/级联事实；`projects.meta.toolkit.enabled[]` 只是索引，
 * 读侧以磁盘与 plugin_states 校验为准（meta 读时自愈）。
 *
 * 风险 9：项目插件位（`.claude/plugins/<pack>/`）的 CC 自动发现语义**待实测
 * 锁定**——此处只保证「落盘保持 `.claude-plugin/` 结构」，加载语义不在本批断言。
 */

export type ToolkitErrorCode = 'not-found' | 'host-version' | 'invalid';

export class ToolkitError extends Error {
  constructor(
    message: string,
    readonly code: ToolkitErrorCode,
  ) {
    super(message);
    this.name = 'ToolkitError';
  }
}

/** 启用时写入的包级记录（marker + checksum，`.weave/toolkit/<id>.json`）。 */
export interface ToolkitRecord {
  packId: string;
  provenance: 'builtin' | 'external-dir';
  sourceRoot: string;
  sourceDir: string;
  enabledAt: string;
  /** 相对项目根的 posix 路径 → 启用时内容 sha256（禁用比对改写用）。 */
  files: Record<string, string>;
}

export interface ToolkitPackInfo extends ToolkitPack {
  /** 读侧：落盘/级联事实校验后的启用态。 */
  enabled: boolean;
  /** weave 成分的装载状态（loader 未就绪时缺省）。 */
  weave?: { status: LoadedPluginInfo['status']; ruleCount: number; error?: string };
}

export interface ToolkitListResult {
  packs: ToolkitPackInfo[];
  dirs: string[];
}

export interface ToolkitToggleResult {
  pack: ToolkitPackInfo;
  warnings: string[];
}

/** mod 类包的宿主版本下限（Claude Code ≥ 2.1.287 契约，EARLY ACCESS）。 */
export const MIN_MOD_HOST_VERSION = [2, 1, 287] as const;

/** 版本字符串（semver）是否 ≥ min。 */
export function isVersionAtLeast(version: string, min: readonly number[]): boolean {
  const parts = version.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < min.length; i++) {
    const v = Number.isFinite(parts[i]) ? parts[i]! : 0;
    if (v > min[i]) return true;
    if (v < min[i]) return false;
  }
  return true;
}

let cachedVersion: { value: string | null; at: number } | undefined;

/**
 * 宿主 Claude Code 版本（mod 启用闸）。`claude --version` 解析首个 semver，
 * 成功结果缓存 10 分钟；不可得返回 null（调用方降级为提示不拦截——weave server
 * 侧无法可靠获取时宁可放行并告警，也不让低误报挡住功能）。
 */
export async function detectClaudeVersion(): Promise<string | null> {
  if (cachedVersion && Date.now() - cachedVersion.at < 600_000) return cachedVersion.value;
  const value = await new Promise<string | null>((resolve) => {
    let out = '';
    // Windows 上 `claude` 是 .cmd shim，无 shell 会 ENOENT —— win32 走 shell
    // 且命令串固定字面（claude --version），无注入面；其余平台直接 spawn。
    const child =
      process.platform === 'win32'
        ? spawn('claude --version', { windowsHide: true, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn('claude', ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 5000);
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const m = /(\d+\.\d+\.\d+)/.exec(out);
      resolve(m ? m[1]! : null);
    });
  });
  cachedVersion = { value, at: Date.now() };
  return value;
}

interface FileCopy {
  src: string;
  /** 相对项目根的 posix 路径。 */
  rel: string;
}

async function walkFiles(
  base: string,
  relBase: string,
  out: Array<{ rel: string; abs: string }>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(path.join(base, ...relBase.split('/').filter(Boolean)), {
      withFileTypes: true,
    });
  } catch {
    return;
  }
  for (const entry of entries) {
    // 只剔除仓库噪音（node_modules/.git）；`.claude-plugin/` 是包结构本体，
    // 必须随包原样复制进插件位。
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await walkFiles(base, rel, out);
    else out.push({ rel, abs: path.join(base, ...rel.split('/')) });
  }
}

/**
 * 启用落盘计划（五闸④的唯一事实源）：按 `targets` 分流——
 * - CC 原生包 × claude → 插件位整体（保持 `.claude-plugin/` 结构）；
 * - skills × codex → `.codex/skills/`（Codex 无插件机制，只能表面解包）；
 * - 裸表面 × claude → `.claude/skills|commands|agents/`（CC 包已在插件位，
 *   不重复解包）；非 `targets` 内的 harness 表面零条目。
 */
async function buildFilePlan(projectPath: string, pack: ToolkitPack): Promise<FileCopy[]> {
  const plan: FileCopy[] = [];
  const claude = pack.targets.includes('claude');

  if (pack.ccPack && claude) {
    const base = `.claude/plugins/${path.basename(pack.dir)}`;
    const files: Array<{ rel: string; abs: string }> = [];
    await walkFiles(pack.dir, '', files);
    for (const f of files) plan.push({ src: f.abs, rel: `${base}/${f.rel}` });
  }

  if (pack.skills.length > 0) {
    for (const harness of pack.targets) {
      if (harness === 'claude' && pack.ccPack) continue; // 插件位已覆盖
      // 批 4a：skills 表面单一事实源 = AssetSurface.projectSkillsDir()
      const skillsBase = assetSurfaceFor(harness).projectSkillsDir();
      for (const skill of pack.skills) {
        const files: Array<{ rel: string; abs: string }> = [];
        await walkFiles(path.join(pack.dir, 'skills', skill), '', files);
        for (const f of files) {
          plan.push({ src: f.abs, rel: `${skillsBase}/${skill}/${f.rel}` });
        }
      }
    }
  }

  // 裸表面包的单文件资产（claude-only：codex 无对应项目表面）
  if (claude && !pack.ccPack) {
    for (const [dirName, category] of [
      ['commands', 'command'],
      ['agents', 'agent'],
    ] as const) {
      const srcBase = path.join(pack.dir, dirName);
      const files: Array<{ rel: string; abs: string }> = [];
      await walkFiles(srcBase, '', files);
      if (files.length === 0) continue;
      const targetDir = fileAssetTargetDir(category, 'claude', 'project', projectPath, homedir());
      for (const f of files) {
        const name = f.rel.split('/').pop()!;
        plan.push({ src: f.abs, rel: toPosix(path.relative(projectPath, path.join(targetDir, name))) });
      }
    }
  }
  return plan;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function recordPathFor(projectPath: string, packId: string): string {
  return path.join(projectPath, '.weave', 'toolkit', `${packId}.json`);
}

async function readRecord(p: string): Promise<ToolkitRecord | null> {
  try {
    const raw = JSON.parse(await readFile(p, 'utf8')) as ToolkitRecord;
    return raw && typeof raw === 'object' && typeof raw.packId === 'string' ? raw : null;
  } catch {
    return null;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

/** 删除文件后自底向上清理空目录（直到项目根；非空目录保留 = 用户内容）。 */
async function pruneEmptyDirs(projectPath: string, fileRels: string[]): Promise<void> {
  const candidates = new Set<string>();
  for (const rel of fileRels) {
    let dir = path.posix.dirname(rel);
    while (dir && dir !== '.' && dir !== '/') {
      candidates.add(dir);
      dir = path.posix.dirname(dir);
    }
  }
  const sorted = [...candidates].sort((a, b) => b.split('/').length - a.split('/').length);
  for (const rel of sorted) {
    const abs = path.join(projectPath, ...rel.split('/'));
    try {
      const entries = await readdir(abs);
      if (entries.length === 0) await rm(abs, { recursive: true, force: true });
    } catch {
      // 目录已消失/不可读——跳过
    }
  }
}

/** 宿主版本闸（5.6）：mod 包 enable 前校验；不可得时降级为 warning。 */
export interface ModHostGate {
  ok: boolean;
  message?: string;
  warning?: string;
}

export function evaluateModHostGate(version: string | null): ModHostGate {
  if (process.env.WEAVE_SKIP_MOD_VERSION_CHECK === '1') return { ok: true };
  if (!version) {
    return {
      ok: true,
      warning: '无法检测宿主 Claude Code 版本，mod 工具包需要 ≥ 2.1.287 才能被加载',
    };
  }
  if (!isVersionAtLeast(version, MIN_MOD_HOST_VERSION)) {
    return {
      ok: false,
      message: `宿主 Claude Code ${version} 低于 2.1.287，mod 工具包不落盘（请先升级 Claude Code）`,
    };
  }
  return { ok: true };
}

export interface ToolkitServiceDeps {
  projects: ProjectRepository;
  states: PluginStateRepository;
  /** loader 门面（daemon 侧为 PluginManager；测试可注入桩）。 */
  plugins: Pick<PluginManager, 'list' | 'setPluginEnabled'> &
    Partial<Pick<PluginManager, 'loadToolkitRoot' | 'reloadAll'>>;
  /** 覆盖内置扫描根（测试）。 */
  builtinRoot?: string;
  /** 覆盖 sources.json 所在根（测试；缺省全局插件根）。 */
  sourcesRoot?: string;
  /** 覆盖宿主版本探测（测试）。 */
  claudeVersion?: () => Promise<string | null>;
}

export class ToolkitService {
  constructor(private readonly deps: ToolkitServiceDeps) {}

  /** 扫描源：内置根（测试可覆盖）+ sources.json 注册的外置目录。 */
  private async sources(): Promise<ToolkitSource[]> {
    const builtin = this.deps.builtinRoot ?? builtinToolkitRoot();
    const sources: ToolkitSource[] = [{ root: builtin, provenance: 'builtin' }];
    const { dirs } = await readSourcesFile(this.deps.sourcesRoot);
    for (const dir of dirs) sources.push({ root: dir, provenance: 'external-dir' });
    return sources;
  }

  private async allPacks(): Promise<ToolkitPack[]> {
    const packs: ToolkitPack[] = [];
    for (const source of await this.sources()) {
      packs.push(...(await discoverToolkitPacks(source)));
    }
    return packs;
  }

  /**
   * 包清单 + 启用态（读侧以落盘/级联校验），顺带把 meta 索引自愈到事实。
   * `source` 消歧：同 id 可同时来自内置与外置（provenance 不同），
   * 精确匹配 sourceRoot，缺省 builtin 优先。
   */
  async list(projectId: number): Promise<ToolkitListResult> {
    const project = this.requireProject(projectId);
    const packs = await this.allPacks();
    const infos: ToolkitPackInfo[] = [];
    for (const pack of packs) infos.push(await this.packInfo(project, pack));
    await this.healMeta(project, infos);
    const { dirs } = await readSourcesFile(this.deps.sourcesRoot);
    return { packs: infos, dirs };
  }

  /** 幂等启用：已启用（记录在且文件齐）→ 无任何写入，直接回后置状态。 */
  async enable(
    projectId: number,
    packId: string,
    sourceRoot?: string,
  ): Promise<ToolkitToggleResult> {
    const project = this.requireProject(projectId);
    const pack = await this.resolvePack(packId, sourceRoot);
    const warnings: string[] = [];

    if (pack.kind === 'mod' && pack.targets.includes('claude')) {
      const detect = this.deps.claudeVersion ?? detectClaudeVersion;
      const gate = evaluateModHostGate(await detect());
      if (!gate.ok) throw new ToolkitError(gate.message ?? 'mod host gate', 'host-version');
      if (gate.warning) warnings.push(gate.warning);
    }

    const projectPath = project.path;
    const recPath = recordPathFor(projectPath, pack.id);
    const existing = await readRecord(recPath);
    const record: ToolkitRecord = existing ?? {
      packId: pack.id,
      provenance: pack.provenance,
      sourceRoot: pack.sourceRoot,
      sourceDir: pack.dir,
      enabledAt: new Date().toISOString(),
      files: {},
    };
    let recordChanged = existing === null;

    const plan = await buildFilePlan(projectPath, pack);
    for (const item of plan) {
      const destAbs = path.join(projectPath, ...item.rel.split('/'));
      const expected = record.files[item.rel];
      if (expected !== undefined) {
        // 本包写入过：缺失补回；在（可能被改写）则绝不覆盖——改写保护。
        if (!(await fileExists(destAbs))) {
          await mkdir(path.dirname(destAbs), { recursive: true });
          await cp(item.src, destAbs);
        }
        continue;
      }
      if ((await hashFile(destAbs)) === 'missing') {
        await mkdir(path.dirname(destAbs), { recursive: true });
        await cp(item.src, destAbs);
        record.files[item.rel] = await hashFile(item.src);
        recordChanged = true;
      }
      // 目标已存在且非本包记录 → 用户文件：append-only，不覆盖不记账。
    }

    // 记录文件 = 文件管线的落盘事实（weave-only 包无落盘成分，不写记录）。
    if (recordChanged && plan.length > 0) {
      await mkdir(path.dirname(recPath), { recursive: true });
      await writeFile(recPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
    }

    // 管线③：weave 规则成分级联启用；loader 未就绪时先落 states（重载时生效）。
    if (pack.weavePack) {
      const cascaded = this.deps.plugins.setPluginEnabled(pack.id, true);
      if (!cascaded) this.deps.states.setEnabled(pack.id, true);
    }

    this.rememberEnabled(project, pack.id, true);
    return { pack: await this.packInfo(project, pack), warnings };
  }

  /** 幂等禁用：checksum 一致的文件删除，用户改写过的保留，记录文件删除。 */
  async disable(projectId: number, packId: string, sourceRoot?: string): Promise<ToolkitToggleResult> {
    const project = this.requireProject(projectId);
    const pack = await this.resolvePack(packId, sourceRoot);
    await this.removePackFiles(project, pack, pack.sourceRoot);

    if (pack.weavePack) {
      const cascaded = this.deps.plugins.setPluginEnabled(pack.id, false);
      if (!cascaded) this.deps.states.setEnabled(pack.id, false);
    }
    this.rememberEnabled(project, pack.id, false);
    return { pack: await this.packInfo(project, pack), warnings: [] };
  }

  /** 文件管线清扫（disable 与 remove-dir 级联共用）。 */
  private async removePackFiles(
    project: ProjectRow,
    pack: ToolkitPack,
    onlyFromSourceRoot?: string,
  ): Promise<void> {
    const recPath = recordPathFor(project.path, pack.id);
    const record = await readRecord(recPath);
    if (!record) return;
    if (onlyFromSourceRoot && path.resolve(record.sourceRoot) !== path.resolve(onlyFromSourceRoot)) return;

    const removed: string[] = [];
    for (const [rel, expected] of Object.entries(record.files)) {
      const abs = path.join(project.path, ...rel.split('/'));
      const current = await hashFile(abs);
      if (current === expected) {
        await rm(abs, { force: true });
        removed.push(rel);
      }
      // current === 'missing'：已消失；≠ expected：用户改写 → 保留（闸②）
    }
    await rm(recPath, { force: true });
    await pruneEmptyDirs(project.path, removed);
  }

  /** 外置目录管理：list / add-dir / remove-dir（级联卸载该目录来源的已启用包）。 */
  async listDirs(): Promise<{ dirs: string[]; indexes: string[] }> {
    return readSourcesFile(this.deps.sourcesRoot);
  }

  async addDir(dir: string): Promise<{ dirs: string[] }> {
    const abs = path.resolve(dir);
    const sources = await addToolkitDir(abs, this.deps.sourcesRoot);
    // 登记即入 loader（loader 未就绪则跳过——下次 daemon 启动/reloadAll 补上）。
    await this.deps.plugins.loadToolkitRoot?.(abs, 'global', null);
    return { dirs: sources.dirs };
  }

  async removeDir(dir: string): Promise<{ dirs: string[]; disabled: string[] }> {
    const abs = path.resolve(dir);
    const dirPacks = await discoverToolkitPacks({ root: abs, provenance: 'external-dir' });
    const sources = await removeToolkitDir(abs, this.deps.sourcesRoot);

    const disabled: string[] = [];
    for (const project of this.deps.projects.list()) {
      const metaIds = this.enabledIndex(project);
      for (const pack of dirPacks) {
        const record = await readRecord(recordPathFor(project.path, pack.id));
        const fromThisDir = record !== null && path.resolve(record.sourceRoot) === abs;
        const weaveOnlyEnabled = !record && metaIds.includes(pack.id) && pack.weavePack;
        if (!fromThisDir && !weaveOnlyEnabled) continue;
        await this.removePackFiles(project, pack, abs);
        if (pack.weavePack) {
          const cascaded = this.deps.plugins.setPluginEnabled(pack.id, false);
          if (!cascaded) this.deps.states.setEnabled(pack.id, false);
        }
        this.rememberEnabled(project, pack.id, false);
        if (!disabled.includes(pack.id)) disabled.push(pack.id);
      }
    }
    // 空根重扫 → 该根下残余 weave 成分（若目录已物理消失）级联摘除。
    await this.deps.plugins.loadToolkitRoot?.(abs, 'global', null);
    return { dirs: sources.dirs, disabled };
  }

  // ---- 内部：启用态计算 / meta 索引 / 包解析 ----

  private requireProject(projectId: number): ProjectRow {
    const project = this.deps.projects.getById(projectId);
    if (!project) throw new ToolkitError(`Project not found: ${projectId}`, 'not-found');
    return project;
  }

  private async resolvePack(packId: string, sourceRoot?: string): Promise<ToolkitPack> {
    const packs = (await this.allPacks()).filter((p) => p.id === packId);
    if (sourceRoot) {
      const match = packs.find((p) => path.resolve(p.sourceRoot) === path.resolve(sourceRoot));
      if (match) return match;
    }
    const builtin = packs.find((p) => p.provenance === 'builtin');
    const chosen = builtin ?? packs[0];
    if (!chosen) throw new ToolkitError(`Toolkit pack not found: ${packId}`, 'not-found');
    return chosen;
  }

  /** 启用态 = 各成分事实的 AND（文件成分看落盘，weave 成分看级联状态）。 */
  private async computeEnabled(project: ProjectRow, pack: ToolkitPack): Promise<boolean> {
    const facts: boolean[] = [];
    const plan = await buildFilePlan(project.path, pack);
    if (plan.length > 0) {
      const record = await readRecord(recordPathFor(project.path, pack.id));
      let present = !!record;
      if (record) {
        for (const rel of Object.keys(record.files)) {
          if (!(await fileExists(path.join(project.path, ...rel.split('/'))))) {
            present = false;
            break;
          }
        }
      }
      facts.push(present);
    }
    if (pack.weavePack) facts.push(this.deps.states.get(pack.id)?.enabled ?? false);
    return facts.length > 0 ? facts.every(Boolean) : false;
  }

  private async packInfo(project: ProjectRow, pack: ToolkitPack): Promise<ToolkitPackInfo> {
    const enabled = await this.computeEnabled(project, pack);
    const info: ToolkitPackInfo = { ...pack, enabled };
    if (pack.weavePack) {
      const loaded = this.deps.plugins.list().find((p) => p.id === pack.id);
      if (loaded) {
        info.weave = {
          status: loaded.status,
          ruleCount: loaded.ruleCount,
          ...(loaded.error ? { error: loaded.error } : {}),
        };
      }
    }
    return info;
  }

  private enabledIndex(project: ProjectRow): string[] {
    const meta = this.deps.projects.getMeta(project.id);
    const toolkit = meta?.['toolkit'];
    const enabled = toolkit && typeof toolkit === 'object' ? (toolkit as Record<string, unknown>)['enabled'] : undefined;
    return Array.isArray(enabled) ? enabled.filter((x): x is string => typeof x === 'string') : [];
  }

  private rememberEnabled(project: ProjectRow, packId: string, on: boolean): void {
    const current = new Set(this.enabledIndex(project));
    if (on) current.add(packId);
    else current.delete(packId);
    this.deps.projects.setMeta(project.id, { toolkit: { enabled: [...current].sort() } });
  }

  /** meta 索引自愈到事实（读侧以落盘/级联为准，索引只跟随）。 */
  private async healMeta(project: ProjectRow, infos: ToolkitPackInfo[]): Promise<void> {
    const actual = [...new Set(infos.filter((i) => i.enabled).map((i) => i.id))].sort();
    const indexed = [...new Set(this.enabledIndex(project))].sort();
    // 已从扫描面消失但仍被索引的 id 保留在索引里（外置目录暂离线时不误清）。
    const visible = new Set(infos.map((i) => i.id));
    const merged = [...new Set([...indexed.filter((id) => !visible.has(id)), ...actual])].sort();
    if (merged.join('\n') !== indexed.join('\n')) {
      this.deps.projects.setMeta(project.id, { toolkit: { enabled: merged } });
    }
  }
}
