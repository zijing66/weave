import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import type { PluginScope, PluginSurface } from '@weavecode/harness';
import { hashFile } from '../install/fingerprint.js';
import { fileAssetTargetDir } from '../install/file-assets.js';
import { assetSurfaceFor, pluginSurfaceFor } from '../surfaces.js';
import type { ProjectRepository, ProjectRow } from '../repositories/projects.js';
import type { LibraryRepository } from '../repositories/libraries.js';
import type { PluginStateRepository } from '../repositories/plugin-states.js';
import { marketLibraryRoots } from '../market/resolve.js';
import { marketDir } from '../market/manifest.js';
import { marketIdOf } from '../market/identity.js';
import type { LoadedPluginInfo, PluginManager } from './plugin-loader.js';
import { effective, setProjectEnabled } from './plugin-project-state.js';
import {
  builtinToolkitRoot,
  discoverToolkitPacks,
  type ToolkitPack,
  type ToolkitProvenance,
  type ToolkitSource,
} from './toolkit-scan.js';

/**
 * 批 10 工具包服务，批 3 改 CC 原生包管线：按包成分分三条既有管线启用/禁用——
 *   ① CC 原生包（mod 同机制，H2）→ harness PluginSurface 全局安装（幂等两步
 *      CLI）+ 项目 settings `enabledPlugins` 开关；**项目插件位零副本**（宿主
 *      不扫描项目 `.claude/plugins/`——H4，存量副本读时自愈清扫，list 报
 *      legacyCopies），disable 只关项目启用、全局安装保留；
 *   ② 表面解包（裸表面/Codex → 批 4a AssetSurface 目标目录，同 checksum 清扫）；
 *   ③ weave 规则成分（按项目 `meta.plugins.enabled` 开关——D3 effective 单点，
 *      全局 plugin_states 仍是「默认启用」，不再按项目 flip）。
 * 状态单一事实源 = 落盘事实 + D3 effective；`projects.meta.toolkit.enabled[]`
 * 只是索引，读侧以磁盘与 effective 校验为准（meta 读时自愈）。
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
  provenance: ToolkitProvenance;
  sourceRoot: string;
  sourceDir: string;
  enabledAt: string;
  /** 相对项目根的 posix 路径 → 启用时内容 sha256（禁用比对改写用）。 */
  files: Record<string, string>;
}

export interface ToolkitPackInfo extends ToolkitPack {
  /** 所属仓库 namespace（市场身份，`marketIdOf(pack.dir)`）：内置包 = `weave`、
   *  外部市场包 = 该市场 id、不在任何市场下的包缺省（前端归「本地」）。 */
  namespace?: string;
  /** 读侧：落盘/级联事实校验后的启用态。 */
  enabled: boolean;
  /** 是否已安装（CC/mod = harness 全局安装态；表面包 = 本项目落盘记录；weave 装载即源恒 true）。 */
  installed: boolean;
  /** CC 注册键 `<name>@<市场>`：仅 CC 落地包（targets 含 claude）有；表面/纯 SPI 包无。 */
  key?: string;
  /** 该键已登记的安装 scope（`user` = 全局装、`project` = 项目内装）；未装为空。 */
  scopes?: PluginScope[];
  /** weave 成分的装载状态（loader 未就绪时缺省）。 */
  weave?: { status: LoadedPluginInfo['status']; ruleCount: number; error?: string };
}

export interface ToolkitListResult {
  packs: ToolkitPackInfo[];
  /** 项目插件位残留（Weave 旧副本；宿主不加载，可安全清理）。 */
  legacyCopies: string[];
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

let cachedVersion: { value: string; at: number } | undefined;

/** win32 上只杀得到 cmd.exe 外壳：孙进程 claude.exe 会吊住 stdout 管道，close 不触发。 */
function killTree(child: ChildProcess): void {
  // 外壳自身已退出（孙进程吊住管道）时它的 pid 可能已被系统复用——/t 杀树会误伤
  // 无关进程，这种情形宁可不杀。
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    }).unref();
    return;
  }
  child.kill('SIGKILL');
}

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
      killTree(child);
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
  // 只缓存成功值：一次探测超时不得把版本闸的降级（放行）状态锁死 10 分钟。
  if (value !== null) cachedVersion = { value, at: Date.now() };
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
    // 只剔除仓库噪音（node_modules/.git）。
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await walkFiles(base, rel, out);
    else out.push({ rel, abs: path.join(base, ...rel.split('/')) });
  }
}

/** 管线①判定：CC 原生插件包，或 mods-only 包（mods 是 Claude 插件的一种，
 * 同走「全局安装 + 项目启用」，不落表面解包）。 */
const isCcPluginPack = (pack: ToolkitPack): boolean => pack.ccPack || pack.kind === 'mod';

/**
 * 启用落盘计划（五闸④的唯一事实源）：按 `targets` 分流——
 * - CC 原生包（含 mods）× claude → **零项目落盘**（全局安装 + 项目 enabledPlugins，
 *   见 enable；宿主不加载项目插件位副本）；
 * - skills × codex → `.codex/skills/`（Codex 无插件机制，只能表面解包）；
 * - 裸表面 × claude → `.claude/skills|commands|agents/`；非 `targets` 内的
 *   harness 表面零条目。
 */
async function buildFilePlan(projectPath: string, pack: ToolkitPack): Promise<FileCopy[]> {
  const plan: FileCopy[] = [];
  const claude = pack.targets.includes('claude');

  if (pack.skills.length > 0) {
    for (const harness of pack.targets) {
      if (harness === 'claude' && isCcPluginPack(pack)) continue; // CC 插件（含 mods）由全局安装覆盖
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
  if (claude && !isCcPluginPack(pack)) {
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
  plugins: Pick<PluginManager, 'list' | 'setPluginEnabled'>;
  /** 覆盖内置扫描根（测试）。 */
  builtinRoot?: string;
  /** managed 市场资源（M3 装载桥：市场根同管线入扫描源）；缺省不扫市场。 */
  libraries?: Pick<LibraryRepository, 'list'>;
  /** 覆盖宿主版本探测（测试）。 */
  claudeVersion?: () => Promise<string | null>;
  /** 插件安装面（测试注入假 exec 的 surface；缺省经 registry 取 Claude 面）。 */
  pluginSurface?: PluginSurface;
}

export class ToolkitService {
  constructor(private readonly deps: ToolkitServiceDeps) {}

  /** 扫描源：内置根（测试可覆盖）+ managed 市场资源根。 */
  private sources(): ToolkitSource[] {
    const builtin = this.deps.builtinRoot ?? builtinToolkitRoot();
    const sources: ToolkitSource[] = [{ root: builtin, provenance: 'builtin' }];
    if (this.deps.libraries) {
      for (const root of marketLibraryRoots(this.deps.libraries)) {
        sources.push({ root, provenance: 'market' });
      }
    }
    // 按解析形去重；首见优先 = builtin > market
    const seen = new Set<string>();
    return sources.filter((s) => {
      const key = path.resolve(s.root);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private async allPacks(): Promise<ToolkitPack[]> {
    const packs: ToolkitPack[] = [];
    for (const source of this.sources()) {
      packs.push(...(await discoverToolkitPacks(source)));
    }
    return packs;
  }

  /**
   * 包清单 + 启用态（读侧以落盘/级联校验），顺带把 meta 索引自愈到事实、
   * 清扫存量项目插件副本。`source` 消歧：同 id 可同时来自内置与市场
   * （provenance 不同），精确匹配 sourceRoot，缺省 builtin 优先。
   */
  async list(projectId: number): Promise<ToolkitListResult> {
    const project = this.requireProject(projectId);
    const packs = await this.allPacks();
    const infos: ToolkitPackInfo[] = [];
    for (const pack of packs) infos.push(await this.packInfo(project, pack));
    await this.healMeta(project, infos);
    return { packs: infos, legacyCopies: await this.scanLegacyCopies(project) };
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

    // 管线①：CC 原生包（含 mods-only——mods 是 Claude 插件的一种）全局安装
    // （幂等两步 CLI，无 manifest 包在 marketplace 副本合成）+ 项目启用；
    // 项目插件位零副本。
    const ccLanded = isCcPluginPack(pack) && pack.targets.includes('claude');
    if (ccLanded) {
      const surface = this.pluginSurface();
      const market = marketIdOf(pack.dir);
      await surface.globalInstall(pack.dir, {
        name: pack.name,
        version: pack.version,
        description: pack.description,
        // 外部市场来源：按该市场身份安装（文件留在数据目录，不占 weave 自建市场）
        ...(market ? { marketplace: { name: market, dir: path.join(marketDir(), market) } } : {}),
      });
      await surface.setProjectEnabled(projectPath, pack.name, true, market);
    }

    const recPath = recordPathFor(projectPath, pack.id);
    const existing = await this.readRecordHealed(projectPath, pack.id);
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

    // 记录文件 = 文件管线的落盘账本（改写保护 + 禁用按 checksum 删除）。
    // 只有向项目落文件的包才需要：CC 原生包的生效链在 installed_plugins +
    // 项目 enabledPlugins（computeEnabled 对其不读记录），weave-only 包走
    // meta/effective——两者均不落 `.weave/toolkit/`；存量旧账本顺手清除。
    if (plan.length > 0) {
      if (recordChanged) {
        await mkdir(path.dirname(recPath), { recursive: true });
        await writeFile(recPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
      }
    } else if (existing) {
      await rm(recPath, { force: true });
    }

    // 管线③：weave 规则成分按项目开关（D3：写 meta.plugins.enabled，
    // 不再 flip 全局 plugin_states——串项目修复）。
    if (pack.weavePack) {
      setProjectEnabled(project, pack.id, true, { projects: this.deps.projects });
    }

    this.rememberEnabled(project, pack.id, true);
    // meta 刚被改写：重取行读 effective（row.meta 是注册时快照）
    return { pack: await this.packInfo(this.requireProject(projectId), pack), warnings };
  }

  /** 幂等禁用：表面/解包文件按 checksum 删除（改写保留），记录删除；CC 原生包
   * 只关项目启用（enabledPlugins=false），全局安装保留。 */
  async disable(projectId: number, packId: string, sourceRoot?: string): Promise<ToolkitToggleResult> {
    const project = this.requireProject(projectId);
    const pack = await this.resolvePack(packId, sourceRoot);
    await this.applyDisabled(project, pack);
    return { pack: await this.packInfo(this.requireProject(projectId), pack), warnings: [] };
  }

  /** disable/uninstall 共用清理（与原 disable 主体逐段等价）：表面文件按
   * checksum 删除（改写保留）、CC 关项目启用、weave 关 meta、清启用索引。 */
  private async applyDisabled(project: ProjectRow, pack: ToolkitPack): Promise<void> {
    await this.removePackFiles(project, pack, pack.sourceRoot);

    if (isCcPluginPack(pack) && pack.targets.includes('claude')) {
      await this.pluginSurface().setProjectEnabled(project.path, pack.name, false, marketIdOf(pack.dir));
    }
    if (pack.weavePack) {
      setProjectEnabled(project, pack.id, false, { projects: this.deps.projects });
    }
    this.rememberEnabled(project, pack.id, false);
  }

  /** 卸载 = disable 全部清理 + CC/mod 包从 harness 全局卸载（与 `claude plugin
   * uninstall` 对齐；未安装由 surface 幂等吞掉；marketplace 源保留可重装）。
   * mod 宿主版本闸不适用（卸载不加载宿主）。 */
  async uninstall(projectId: number, packId: string, sourceRoot?: string): Promise<ToolkitToggleResult> {
    const project = this.requireProject(projectId);
    const pack = await this.resolvePack(packId, sourceRoot);
    await this.applyDisabled(project, pack);
    if (isCcPluginPack(pack) && pack.targets.includes('claude')) {
      // 逐 scope 卸（surface 内按各记录自己的 scope 发 CLI）——全局记录与项目记录
      // 一起摘掉，宿主才不会再把插件列为"已安装"。
      await this.pluginSurface().uninstall(pack.name, marketIdOf(pack.dir));
    }
    return { pack: await this.packInfo(this.requireProject(projectId), pack), warnings: [] };
  }

  /** 文件管线清扫（disable 与 uninstall 共用）。 */
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

  /**
   * 启用态 = 各成分事实的 AND：表面/解包成分看落盘，CC 原生包看「全局已装 &&
   * 项目 enabledPlugins 开」（批 3 判据），weave 成分看 D3 effective（项目覆盖
   * → 已同步未启用 → 回落全局）。
   * 读记录即触发存量项目副本自愈（读时清扫）。
   */
  private async computeEnabled(project: ProjectRow, pack: ToolkitPack): Promise<boolean> {
    const facts: boolean[] = [];
    const record = await this.readRecordHealed(project.path, pack.id);
    const plan = await buildFilePlan(project.path, pack);
    if (plan.length > 0) {
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
    if (isCcPluginPack(pack) && pack.targets.includes('claude')) {
      const surface = this.pluginSurface();
      const market = marketIdOf(pack.dir);
      facts.push(
        (await surface.isInstalled(pack.name, market)) &&
          (await surface.readProjectEnabled(project.path, pack.name, market)),
      );
    }
    if (pack.weavePack) {
      facts.push(effective(project, pack.id, { states: this.deps.states, defaultEnabled: false }));
    }
    return facts.length > 0 ? facts.every(Boolean) : false;
  }

  /** 该键已登记的安装 scope（读 installed_plugins.json；UI 用来显示"装在哪一处"）。 */
  private async installedScopes(key: string): Promise<PluginScope[] | undefined> {
    const records = (await this.pluginSurface().readInstalled())[key];
    if (!records || records.length === 0) return undefined;
    const scopes = [...new Set(records.map((r) => r.scope ?? 'user'))] as PluginScope[];
    return scopes;
  }

  private async packInfo(project: ProjectRow, pack: ToolkitPack): Promise<ToolkitPackInfo> {
    const enabled = await this.computeEnabled(project, pack);
    // 市场身份判据的唯一实现（`market/identity.ts`）；内置包落 `<dataDir>/market/weave/`
    // 下 → 天然得出 `weave`，与市场列表的仓库名同形。
    const namespace = marketIdOf(pack.dir);
    // 键形由 harness 的 surface 拼（server 只给"包名 + 市场身份"）
    const ccKey =
      isCcPluginPack(pack) && pack.targets.includes('claude')
        ? this.pluginSurface().pluginKey(pack.name, namespace)
        : undefined;
    const scopes = ccKey ? await this.installedScopes(ccKey) : undefined;
    const info: ToolkitPackInfo = {
      ...pack,
      ...(namespace ? { namespace } : {}),
      enabled,
      installed: await this.computeInstalled(project, pack, enabled),
      ...(ccKey ? { key: ccKey } : {}),
      ...(scopes && scopes.length > 0 ? { scopes } : {}),
    };
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

  /**
   * 安装态（市场「安装/已装」判定）：CC/mod 看 harness 全局安装记录；
   * weave 成分随扫描源热载无安装概念；表面包看本项目落盘账本（启用即已装）。
   */
  private async computeInstalled(
    project: ProjectRow,
    pack: ToolkitPack,
    enabled: boolean,
  ): Promise<boolean> {
    if (pack.weavePack && !isCcPluginPack(pack)) return true;
    if (isCcPluginPack(pack) && pack.targets.includes('claude')) {
      return this.pluginSurface().isInstalled(pack.name, marketIdOf(pack.dir));
    }
    return enabled || !!(await this.readRecordHealed(project.path, pack.id));
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
    // 已从扫描面消失但仍被索引的 id 保留在索引里（市场资源暂离线时不误清）。
    const visible = new Set(infos.map((i) => i.id));
    const merged = [...new Set([...indexed.filter((id) => !visible.has(id)), ...actual])].sort();
    if (merged.join('\n') !== indexed.join('\n')) {
      this.deps.projects.setMeta(project.id, { toolkit: { enabled: merged } });
    }
  }

  /** 插件安装面（deps 可注入假 exec；缺省经 registry 取 Claude 面——批 3 最浅接入）。 */
  private pluginSurface(): PluginSurface {
    return this.deps.pluginSurface ?? pluginSurfaceFor('claude');
  }

  /**
   * 读记录 + 存量项目插件副本自愈（仿 healMeta）：旧管线把 CC 包复制进项目
   * 插件位，宿主从不加载（H4）——按 checksum 删副本并重写记录；用户改写过的
   * 文件保留（由 legacyCopies 报出，清理走显式端点）。
   */
  private async readRecordHealed(
    projectPath: string,
    packId: string,
  ): Promise<ToolkitRecord | null> {
    const recPath = recordPathFor(projectPath, packId);
    const record = await readRecord(recPath);
    if (!record) return null;
    const relBase = toPosix(
      path.relative(projectPath, this.pluginSurface().projectPluginDir(projectPath)),
    );
    const legacy = Object.keys(record.files).filter((rel) => rel.startsWith(`${relBase}/`));
    if (legacy.length === 0) return record;
    const removed: string[] = [];
    for (const rel of legacy) {
      const abs = path.join(projectPath, ...rel.split('/'));
      if ((await hashFile(abs)) === record.files[rel]) {
        await rm(abs, { force: true });
        removed.push(rel);
      }
      delete record.files[rel];
    }
    await pruneEmptyDirs(projectPath, removed);
    await writeFile(recPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
    return record;
  }

  /** 项目插件位残留清单（readRecordHealed 覆盖不到的孤儿副本在此报出）。 */
  private async scanLegacyCopies(project: ProjectRow): Promise<string[]> {
    const dir = this.pluginSurface().projectPluginDir(project.path);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.map((e) => toPosix(path.relative(project.path, path.join(dir, e.name)))).sort();
  }

  /** 幂等清理项目插件位残留（宿主不加载的死数据，清理不改变任何加载行为）。 */
  async cleanupLegacyCopies(projectId: number): Promise<{ removed: string[] }> {
    const project = this.requireProject(projectId);
    const dir = this.pluginSurface().projectPluginDir(project.path);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return { removed: [] };
    }
    const removed: string[] = [];
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      await rm(abs, { recursive: true, force: true });
      removed.push(toPosix(path.relative(project.path, abs)));
    }
    try {
      if ((await readdir(dir)).length === 0) await rm(dir, { recursive: true, force: true });
    } catch {
      // 目录已消失——跳过
    }
    return { removed: removed.sort() };
  }
}
