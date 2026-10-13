import path from 'node:path';
import { lstat, readdir, readFile, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { HARNESS_DIRS, HARNESS_KEYS, INSTRUCTION_FILES, type Harness, logger } from '@weavecode/core';
import { hashFile, projectPackFiles, unregisterProject } from '@weavecode/server';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — weave-templates is symlinked via pnpm workspaces
import { templateRegistry } from '@weavecode/templates';
import { stripWeaveSettings } from './settings-gen.js';
import { stripWeaveMcp } from './mcp-gen.js';
import {
  WEAVE_BLOCK_START,
  WEAVE_BLOCK_END,
  WEAVE_MANAGED_HEADER,
} from './claudemd-gen.js';
import { WEAVE_HELPER_MARKER } from './harnesses/claude.js';
import { registerPluginTemplates } from './plugin-templates.js';
import { NESTED_GITIGNORE } from './executor.js';
import {
  COMMIT_MESSAGE,
  findGitRepoRoot,
  type GitExec,
  type GitResult,
  defaultGitExec,
} from './git-commit.js';
import { t } from '../i18n/index.js';

/**
 * `weave uninstall`：把 `weave init` 的生成物原样减回去。
 *
 * 判据全部用「写入时的指纹」，绝不按位置猜：
 * - helpers：文件内容带 WEAVE_HELPER_MARKER
 * - 模板/插件模板/工具包：与来源逐字节相等（用户改过的留下，进 keptUserFiles）
 * - settings/.mcp.json：剥除函数只动 weave 写入的键
 * - 指令文件：整文件 weave header → 删；否则只剥 weave:block；链接摘掉
 * - 嵌套 .gitignore：内容逐字节等于生成常量才删
 *
 * git 策略（用户裁决）：
 * - HEAD 恰是 init 提交且只含 weave 管得着的路径 → `git reset --mixed HEAD~1`
 *   回滚指针（工作树保持现状，无痕）
 * - 否则把本次改动路径（含 `.weave`）逐路径 add 成一笔卸载提交
 * - 暂存区非空 → 跳过 git（不牵连用户已暂存的内容）
 *
 * server 注册表：本地有无 .weave/ 都要查——有行就注销（清运行数据 + 管道
 * 文件 + 删行）；失败单独上报，不牵连本地清理。
 */

export interface UninstallOptions {
  targetDir: string;
  execGit?: GitExec;
  /** server 注册表 DB 与管道根；缺省走真实数据目录（测试注入临时根）。 */
  dbPath?: string;
  hooksDir?: string;
}

export type UninstallGitOutcome =
  | 'reset'
  | 'committed'
  | 'no-changes'
  | 'skipped-dirty-index'
  | 'skipped-not-repo'
  | 'failed';

/** server 侧注销结果：本地不管初始化与否，注册表里有就得走这一步。 */
export interface UninstallServerResult {
  outcome: 'removed' | 'absent' | 'failed';
  name?: string;
  purged?: { events: number; dispatches: number; sessions: number };
  error?: string;
}

export interface UninstallResult {
  status: 'ok' | 'not-initialized';
  removedFiles: string[];
  removedDirs: string[];
  modifiedFiles: string[];
  /** weave 生成位但内容与来源不一致（疑似用户修改）——保守保留。 */
  keptUserFiles: string[];
  restoredFromBackup?: string;
  git: UninstallGitOutcome;
  gitSha?: string;
  gitError?: string;
  server: UninstallServerResult;
}

const UNINSTALL_COMMIT_MESSAGE = 'chore: weave uninstall 移除 init 生成物';

/** 次名指令文件（合一时链到主名者）——init 顶替/备份的正是它。 */
const INSTRUCTION_ALIAS = INSTRUCTION_FILES[1];

/**
 * init 提交允许包含的路径前缀——reset 门用。指令文件名与各 harness 项目目录
 * 皆表驱动（新增 harness 自动纳入），不写 harness 名或路径字面量。
 */
const WEAVE_MANAGED_PATHS = [
  ...INSTRUCTION_FILES,
  '.mcp.json',
  ...HARNESS_KEYS.map((h) => HARNESS_DIRS[h].projectDir),
  '.weave',
];

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfPresent(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf-8');
  } catch {
    return null;
  }
}

async function readJsonIfPresent(p: string): Promise<Record<string, unknown> | undefined> {
  const text = await readTextIfPresent(p);
  if (text === null) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 用户文件不是合法 JSON → 不动
  }
  return undefined;
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(full)));
    else out.push(full);
  }
  return out;
}

async function sameBytes(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([readTextIfPresent(a), readTextIfPresent(b)]);
  return x !== null && x === y;
}

/** 删掉文件后自底向上清空目录（到 stopDir 为止，不含）；非空即停。 */
async function pruneEmptyDirs(startDir: string, stopDir: string, removed: string[]): Promise<void> {
  let dir = startDir;
  const stop = path.resolve(stopDir);
  for (;;) {
    if (path.resolve(dir) === stop || !dir.startsWith(stop + path.sep)) return;
    try {
      await rmdir(dir);
      removed.push(dir);
    } catch {
      return; // 非空（用户内容）或已不存在
    }
    dir = path.dirname(dir);
  }
}

class Uninstaller {
  private readonly targetDir: string;
  private readonly execGit: GitExec;
  private readonly dbPath?: string;
  private readonly hooksDir?: string;
  readonly result: UninstallResult;

  constructor(opts: UninstallOptions) {
    this.targetDir = path.resolve(opts.targetDir);
    this.execGit = opts.execGit ?? defaultGitExec;
    this.dbPath = opts.dbPath;
    this.hooksDir = opts.hooksDir;
    this.result = {
      status: 'ok',
      removedFiles: [],
      removedDirs: [],
      modifiedFiles: [],
      keptUserFiles: [],
      git: 'no-changes',
      server: { outcome: 'absent' },
    };
  }

  async run(): Promise<UninstallResult> {
    const weaveDir = path.join(this.targetDir, '.weave');
    if (!(await pathExists(weaveDir))) {
      this.result.status = 'not-initialized';
      this.unregisterFromServer();
      return this.result;
    }

    // `.weave` 还在时先取走只有它知道的事：工具包落盘指纹 + AGENTS.md 备份。
    const packFiles = await projectPackFiles(this.targetDir);
    const agentsBackup = await newestAgentsBackup(weaveDir);

    // 插件模板的来源在 `.weave/plugins`（+ 全局根），拆除前先发现。
    let pluginTemplates: { category: string; sourcePath: string }[] = [];
    try {
      pluginTemplates = (await registerPluginTemplates(this.targetDir)).registered;
    } catch (err) {
      logger.warn(t('uninstall.pluginScanFailed', { error: String(err) }));
    }

    for (const h of HARNESS_KEYS) {
      await this.sweepHarness(h, pluginTemplates);
    }
    await this.sweepMcp();
    await this.sweepInstructionFiles(agentsBackup);
    await this.sweepPackFiles(packFiles);

    // `.weave` 整目录（含 backup/config.yaml/toolkit/嵌套 gitignore）
    await rm(weaveDir, { recursive: true, force: true });
    this.result.removedDirs.push(weaveDir);

    await this.runGit();
    this.unregisterFromServer();
    return this.result;
  }

  /** server 注册表注销：行删掉 + 运行数据清掉；失败不牵连本地已完成的清理。 */
  private unregisterFromServer(): void {
    try {
      const removed = unregisterProject(this.targetDir, this.dbPath, this.hooksDir);
      if (removed) {
        this.result.server = { outcome: 'removed', name: removed.name, purged: removed.purged };
      }
    } catch (err) {
      this.result.server = {
        outcome: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** 单个 harness 目录面：helpers → 模板副本 → 插件模板副本 → settings → gitignore → 空壳。 */
  private async sweepHarness(h: Harness, pluginTemplates: { category: string; sourcePath: string }[]): Promise<void> {
    const hdir = path.join(this.targetDir, HARNESS_DIRS[h].projectDir);
    if (!(await pathExists(hdir))) return;

    const helpersDir = path.join(hdir, 'helpers');
    for (const file of await walkFiles(helpersDir)) {
      const content = await readTextIfPresent(file);
      if (content !== null && content.includes(WEAVE_HELPER_MARKER)) {
        await unlink(file);
        this.result.removedFiles.push(file);
      } else {
        this.result.keptUserFiles.push(file);
      }
    }

    // 核心模板副本：来源树按相对路径镜像比对，逐字节相等才删。
    const categoryDirs: [string, string | null][] = [
      ['skills', templateRegistry.getSkillsSourceDir()],
      ['commands', templateRegistry.getCommandsSourceDir()],
      ['agents', templateRegistry.getAgentsSourceDir()],
    ];
    for (const [dirName, srcDir] of categoryDirs) {
      if (!srcDir) continue;
      await this.removeTemplateMirrors(path.join(hdir, dirName), srcDir);
    }

    // 插件模板副本：init 的落位 = skills/<basename(src)> 子树 / commands|agents 单文件。
    for (const entry of pluginTemplates) {
      const src = entry.sourcePath;
      if (entry.category === 'skill') {
        await this.removeTemplateMirrors(path.join(hdir, 'skills', path.basename(src)), src);
      } else {
        const destDir = entry.category === 'command' ? 'commands' : 'agents';
        const dest = path.join(hdir, destDir, path.basename(src));
        await this.removeIfSame(dest, src);
      }
    }

    // settings.json：剥除后还有剩余键 → 写回；空了 → 删文件。
    const settingsPath = path.join(hdir, 'settings.json');
    const settings = await readJsonIfPresent(settingsPath);
    if (settings) {
      const stripped = stripWeaveSettings(settings);
      if (Object.keys(stripped).length > 0) {
        await writeFile(settingsPath, JSON.stringify(stripped, null, 2) + '\n', 'utf-8');
        this.result.modifiedFiles.push(settingsPath);
      } else {
        await unlink(settingsPath);
        this.result.removedFiles.push(settingsPath);
      }
    }

    // 嵌套自忽略 .gitignore：内容与生成常量逐字节相等才删。
    const gitignorePath = path.join(hdir, '.gitignore');
    if ((await readTextIfPresent(gitignorePath)) === NESTED_GITIGNORE) {
      await unlink(gitignorePath);
      this.result.removedFiles.push(gitignorePath);
    }

    // 空壳回收：内容面清空后各子目录与 harness 目录本身非空即停（用户内容保住）。
    for (const dir of ['helpers', 'skills', 'commands', 'agents']) {
      await pruneEmptyDirs(path.join(hdir, dir), this.targetDir, this.result.removedDirs);
    }
    await pruneEmptyDirs(hdir, this.targetDir, this.result.removedDirs);
  }

  /** dest 树与 src 树按相对路径镜像比对，逐字节相等才删（用户改过的留下）。 */
  private async removeTemplateMirrors(destDir: string, srcDir: string): Promise<void> {
    for (const srcFile of await walkFiles(srcDir)) {
      const rel = path.relative(srcDir, srcFile);
      await this.removeIfSame(path.join(destDir, rel), srcFile);
    }
  }

  private async removeIfSame(dest: string, src: string): Promise<void> {
    if (!(await pathExists(dest))) return;
    if (await sameBytes(dest, src)) {
      await unlink(dest);
      this.result.removedFiles.push(dest);
    } else {
      this.result.keptUserFiles.push(dest);
    }
  }

  /** 项目根 .mcp.json：剥 weave server 键，空了删文件。 */
  private async sweepMcp(): Promise<void> {
    const mcpPath = path.join(this.targetDir, '.mcp.json');
    const mcp = await readJsonIfPresent(mcpPath);
    if (!mcp) return;
    const stripped = stripWeaveMcp(mcp);
    if (Object.keys(stripped).length > 0) {
      await writeFile(mcpPath, JSON.stringify(stripped, null, 2) + '\n', 'utf-8');
      this.result.modifiedFiles.push(mcpPath);
    } else {
      await unlink(mcpPath);
      this.result.removedFiles.push(mcpPath);
    }
  }

  /**
   * 指令文件对（CLAUDE.md/AGENTS.md）：
   * - weave 建的链接 → 摘掉
   * - 真文件带 weave header → 整文件是 weave 的，删
   * - 真文件只有 weave:block → 剥段写回；两样都没有 → 用户的，不动
   * - init 顶替掉的 AGENTS.md 备份 → AGENTS.md 缺位时还原
   */
  private async sweepInstructionFiles(agentsBackup: string | null): Promise<void> {
    // 次名在前（原文件的摘链接/删除顺序），主名在后。
    for (const name of [...INSTRUCTION_FILES].reverse()) {
      const p = path.join(this.targetDir, name);
      let st;
      try {
        st = await lstat(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        await unlink(p);
        this.result.removedFiles.push(p);
        continue;
      }
      if (!st.isFile()) continue;
      const content = await readTextIfPresent(p);
      if (content === null) continue;
      if (content.includes(WEAVE_MANAGED_HEADER)) {
        await unlink(p);
        this.result.removedFiles.push(p);
        continue;
      }
      const startIdx = content.indexOf(WEAVE_BLOCK_START);
      const endIdx = content.indexOf(WEAVE_BLOCK_END);
      if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        const stripped = (content.slice(0, startIdx) + content.slice(endIdx + WEAVE_BLOCK_END.length))
          .replace(/\s+$/, '');
        // 剥段后全空 = 文件只剩 weave 内容 → 删；否则写回（补单换行收尾）。
        if (stripped === '') {
          await unlink(p);
          this.result.removedFiles.push(p);
        } else {
          await writeFile(p, stripped + '\n', 'utf-8');
          this.result.modifiedFiles.push(p);
        }
      }
    }
    // 既有的次名指令文件（用户后来自己写的）永远优先，不拿备份覆盖。
    if (agentsBackup && !(await pathExists(path.join(this.targetDir, INSTRUCTION_ALIAS)))) {
      const content = await readTextIfPresent(agentsBackup);
      if (content !== null) {
        await writeFile(path.join(this.targetDir, INSTRUCTION_ALIAS), content, 'utf-8');
        this.result.restoredFromBackup = path.join(this.targetDir, INSTRUCTION_ALIAS);
      }
    }
  }

  /** 工具包落盘文件：与安装时 sha256 相等才删（改过的留下），随后清空目录。 */
  private async sweepPackFiles(packFiles: Map<string, string>): Promise<void> {
    for (const [rel, sha] of packFiles) {
      const abs = path.resolve(this.targetDir, rel);
      // 越界路径（记录被手改）不碰
      if (abs !== this.targetDir && !abs.startsWith(this.targetDir + path.sep)) continue;
      if ((await hashFile(abs)) === sha) {
        await unlink(abs).catch(() => {});
        this.result.removedFiles.push(abs);
      } else if (await pathExists(abs)) {
        this.result.keptUserFiles.push(abs);
      }
    }
    const parents = [...new Set([...packFiles.keys()].map((rel) => path.dirname(path.resolve(this.targetDir, rel))))];
    for (const parent of parents) {
      await pruneEmptyDirs(parent, this.targetDir, this.result.removedDirs);
    }
  }

  // ---- git ----

  private async git(args: string[]): Promise<GitResult> {
    return this.execGit('git', args, { cwd: this.targetDir });
  }

  private async runGit(): Promise<void> {
    const repoRoot = await findGitRepoRoot(this.targetDir);
    if (!repoRoot) {
      this.result.git = 'skipped-not-repo';
      return;
    }
    try {
      // 暂存区非空 → 跳过（reset/commit 都会波及用户已暂存的内容）
      const staged = await this.git(['diff', '--cached', '--quiet']);
      if (staged.code !== 0) {
        this.result.git = 'skipped-dirty-index';
        return;
      }

      const log = await this.git(['log', '-1', '--format=%s\t%H\t%P']);
      if (log.code === 0) {
        const [subject, sha, parentSha] = log.stdout.trimEnd().split('\t');
        if (subject === COMMIT_MESSAGE && parentSha) {
          const tree = await this.git(['diff-tree', '--no-commit-id', '--name-only', '-r', sha]);
          const paths = tree.code === 0
            ? tree.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
            : [];
          const managed = (p: string) => WEAVE_MANAGED_PATHS.some(
            (w) => p === w || p === w + '/' || p.startsWith(w + '/'),
          );
          if (paths.length > 0 && paths.every(managed)) {
            const reset = await this.git(['reset', '--mixed', 'HEAD~1']);
            if (reset.code === 0) {
              this.result.git = 'reset';
              this.result.gitSha = parentSha.slice(0, 7);
              return;
            }
            this.result.git = 'failed';
            this.result.gitError = reset.stderr.trim() || 'git reset failed';
            return;
          }
        }
      }

      // 新提交路径：只提交「跟踪 ∪ 本次触碰」交集——被嵌套 gitignore 挡着的
      // 未跟踪文件（helpers、settings 等删掉即消失，git 无从感知），add 一个
      // 不存在的 pathspec 反而 fatal。恢复出的用户 AGENTS.md 本就是跟踪修改，
      // 自然落在交集内。绝不 -A、绝不 -f（与 init 收尾同一纪律）。
      const touched = [
        ...this.result.removedFiles,
        ...this.result.modifiedFiles,
        ...(this.result.restoredFromBackup ? [this.result.restoredFromBackup] : []),
        path.join(this.targetDir, '.weave'),
      ];
      const unique = [...new Set(touched.map((p) => path.relative(this.targetDir, p).replace(/\\/g, '/')))];
      const chunkSize = 50;
      const tracked = new Set<string>();
      for (let i = 0; i < unique.length; i += chunkSize) {
        const ls = await this.git(['ls-files', '--', ...unique.slice(i, i + chunkSize)]);
        if (ls.code !== 0) {
          this.result.git = 'failed';
          this.result.gitError = ls.stderr.trim() || 'git ls-files failed';
          return;
        }
        for (const line of ls.stdout.split('\n')) {
          if (line.trim()) tracked.add(line.trim().replace(/\\/g, '/'));
        }
      }
      const trackedPaths = [...tracked];
      if (trackedPaths.length > 0) {
        for (let i = 0; i < trackedPaths.length; i += chunkSize) {
          const add = await this.git(['add', '--', ...trackedPaths.slice(i, i + chunkSize)]);
          if (add.code !== 0) {
            this.result.git = 'failed';
            this.result.gitError = add.stderr.trim() || 'git add failed';
            return;
          }
        }
      }
      const stillClean = await this.git(['diff', '--cached', '--quiet']);
      if (stillClean.code === 0) {
        this.result.git = 'no-changes';
        return;
      }
      const commit = await this.git(['commit', '-m', UNINSTALL_COMMIT_MESSAGE]);
      if (commit.code !== 0) {
        this.result.git = 'failed';
        this.result.gitError = commit.stderr.trim() || 'git commit failed';
        return;
      }
      const head = await this.git(['rev-parse', '--short', 'HEAD']);
      this.result.git = 'committed';
      this.result.gitSha = head.code === 0 ? head.stdout.trim() : undefined;
    } catch (err) {
      this.result.git = 'failed';
      this.result.gitError = err instanceof Error ? err.message : String(err);
    }
  }
}

/** `.weave/backup/<指令文件>.<stamp>` 里最新的一份；没有返回 null。 */
async function newestAgentsBackup(weaveDir: string): Promise<string | null> {
  const backupDir = path.join(weaveDir, 'backup');
  let names: string[];
  try {
    names = await readdir(backupDir);
  } catch {
    return null;
  }
  const stamps = names
    .filter((n) => INSTRUCTION_FILES.some((f) => n.startsWith(f + '.')))
    .sort();
  return stamps.length > 0 ? path.join(backupDir, stamps[stamps.length - 1]) : null;
}

export async function executeUninstall(opts: UninstallOptions): Promise<UninstallResult> {
  return new Uninstaller(opts).run();
}
