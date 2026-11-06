import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { HARNESS_LIFECYCLE, isHarness, type Harness } from '@weavecode/core';

/**
 * 会话级 worktree 绑定（B5 最小切片）：
 * 起手 = `git worktree add <项目>/.weave/worktrees/<sessionId> -b weave/session-<id8>`，
 * 会话 cwd 落 worktree（与主干工作区隔离，解并行会话 git 竞态）；
 * 结束 = SessionEnd 后把分支并回项目当前分支（merge）。
 *
 * 冲突策略（定位稿 6.4/6.5 梯队全部后置）：merge 冲突 = **不并、保留 worktree、
 * 如实上报状态**——绝不 --force、绝不 reset 用户分支、绝不替用户解冲突。并回动作
 * 幂等：已并过的登记（merged）不再并第二次；登记落
 * `<dataDir>/cache/hooks/session-worktrees.json`（cache 档，与 pane-envs 同口径：
 * 只解 daemon 自己的重启——worktree 本体登记在项目 `.git` 里，重启不丢）。
 */

const execFileAsync = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
  /** 进程退出码；spawn 层失败（ENOENT 等）由实现直接抛出。 */
  code: number;
}

/** git 调用缝：数组传参无 shell；非零退出不抛（语义由调用方判读）。测试可注入。 */
export type WorktreeGitExec = (
  file: string,
  args: string[],
  options: { cwd: string },
) => Promise<GitResult>;

export const defaultWorktreeGitExec: WorktreeGitExec = async (file, args, options) => {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd: options.cwd,
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout: String(stdout), stderr: String(stderr), code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    // spawn 层失败（git 不在 PATH）与命令非零退出都归一成带码结果——调用方按码判读
    if (e.code === 'ENOENT') throw new Error('git is not available on PATH');
    return {
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : String(e.message ?? ''),
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
};

/** 项目下 worktree 落点（会话一目录，分支一命名规则——两处拼装只在这里）。 */
export function sessionWorktreeDir(projectPath: string, sessionId: string): string {
  return path.join(projectPath, '.weave', 'worktrees', sessionId);
}

export function sessionWorktreeBranch(sessionId: string): string {
  // 占位键剥前缀再截（不然所有 pending 都截成同一个 "pending-"，分支名互撞）
  const slug = sessionId.startsWith(PENDING_WT_PREFIX)
    ? sessionId.slice(PENDING_WT_PREFIX.length, PENDING_WT_PREFIX.length + 8)
    : sessionId.slice(0, 8);
  return `weave/session-${slug}`;
}

/**
 * 占位键前缀：new-session 建 worktree 那一刻 sessionId 未知（宿主自己生成）——
 * 先用 `pending-<uuid>` 建目录与登记，首个会话事件到达时按 cwd 前缀认领改绑
 * （claimPendingSessionWorktree）。同 pane-envs 的 pending-origins 一个哲学。
 */
export const PENDING_WT_PREFIX = 'pending-';

// ---- 登记表（cache 档：只解 daemon 重启；形状对不上整表视同没有，靠孤儿清扫兜） ----

export type WorktreeStatus = 'active' | 'merged' | 'conflict' | 'error';

/** 一条会话 worktree 登记（登记 = 提示 + 恢复入口，不是权威——权威在项目 `.git`）。 */
export interface SessionWorktreeEntry {
  sessionId: string;
  projectId: number;
  /** worktree 绝对路径（cwd 指向它）与分支名。 */
  path: string;
  branch: string;
  status: WorktreeStatus;
  /** conflict/error 时的原文（git 输出尾段，脱敏由日志层负责；这里只存原文）。 */
  message?: string;
  at: string;
}

const WORKTREES_FILE = 'session-worktrees.json';

/** 读登记表：缺失 / 坏文件 / 条目缺关键字段一律视同没有（不猜）。 */
export function readWorktreeRegistry(hooksDir: string): Record<string, SessionWorktreeEntry> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(hooksDir, WORKTREES_FILE), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, SessionWorktreeEntry> = {};
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (typeof value !== 'object' || value === null) continue;
      const e = value as Partial<SessionWorktreeEntry>;
      if (
        typeof e.projectId !== 'number' ||
        typeof e.path !== 'string' ||
        typeof e.branch !== 'string' ||
        typeof e.at !== 'string'
      ) {
        continue;
      }
      out[sessionId] = {
        sessionId,
        projectId: e.projectId,
        path: e.path,
        branch: e.branch,
        status: e.status ?? 'active',
        ...(typeof e.message === 'string' ? { message: e.message } : {}),
        at: e.at,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** 原子写登记表（0600，同 pane-envs 口径）；失败静默——登记是提示面，不该拖垮请求。 */
export function writeWorktreeRegistry(
  hooksDir: string,
  entries: Record<string, SessionWorktreeEntry>,
): void {
  const file = path.join(hooksDir, WORKTREES_FILE);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(entries)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
    chmodSync(file, 0o600);
  } catch {
    // 落盘失败绝不能冒泡（内存态照常工作，重启后由孤儿清扫重建）
  }
}

export function upsertWorktreeEntry(
  hooksDir: string,
  entry: SessionWorktreeEntry,
): void {
  const entries: Record<string, SessionWorktreeEntry> = readWorktreeRegistry(hooksDir);
  entries[entry.sessionId] = entry;
  writeWorktreeRegistry(hooksDir, entries);
}

export function removeWorktreeEntry(hooksDir: string, sessionId: string): void {
  const entries = readWorktreeRegistry(hooksDir);
  if (!(sessionId in entries)) return;
  delete entries[sessionId];
  writeWorktreeRegistry(hooksDir, entries);
}

// ---- git 操作面 ----

/** `.weave/worktrees` 的嵌套 gitignore（自带 `.gitignore` 那份本身要能提交）。 */
const WORKTREES_GITIGNORE = '*\n!.gitignore\n';

function ensureWorktreesIgnored(projectPath: string, exec: WorktreeGitExec): Promise<void> {
  // 嵌套 gitignore（init 的既有裁决：weave 不碰用户根 .gitignore）——但存量项目
  // 可能还没重跑 init，这里按同一形状补一份（幂等：已存在不覆写用户的手改）。
  const dir = path.join(projectPath, '.weave', 'worktrees');
  const file = path.join(dir, '.gitignore');
  if (existsSync(file)) return Promise.resolve();
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(file, WORKTREES_GITIGNORE, 'utf8');
  } catch {
    // 写不了（只读盘等）→ 下面 add 会把未忽略的 worktree 目录列出来，由调用方报错
  }
  // 嵌套 gitignore 生效要求父 `.weave/.gitignore`（init 生成，忽略目录内一切）
  // 与仓库已跟踪状态无关——worktree 目录未被跟踪时嵌套规则即生效，无需 git 命令。
  void exec;
  return Promise.resolve();
}

export interface CreateWorktreeResult {
  ok: boolean;
  /** worktree 绝对路径（成功时返回；失败不带）。 */
  path?: string;
  branch?: string;
  error?: string;
  /** 409 语义：环境不支持（非 git 仓 / git 缺席 / 脏冲突位），前端据此置灰。 */
  unsupported?: boolean;
}

/**
 * 起手建 worktree：`git worktree add <路径> -b <分支>`（分支从项目当前 HEAD 拉出）。
 * 非 git 仓 / git 缺席 → `unsupported:true`（调用方回 409，前端置灰，不炸）。
 * 同一会话重复建 = 幂等命中（路径已存在且登记还在 → 原样返回）。
 */
export async function createSessionWorktree(
  projectPath: string,
  sessionId: string,
  exec: WorktreeGitExec = defaultWorktreeGitExec,
): Promise<CreateWorktreeResult> {
  let check: GitResult;
  try {
    check = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: projectPath });
  } catch (e) {
    // git 缺席（ENOENT 由 exec 抛）：环境不支持——与「非 git 仓」同一面（409/置灰），不炸
    return { ok: false, unsupported: true, error: e instanceof Error ? e.message : 'git unavailable' };
  }
  if (check.code !== 0) {
    return { ok: false, unsupported: true, error: 'not inside a git repository' };
  }
  const branch = sessionWorktreeBranch(sessionId);
  const wtPath = sessionWorktreeDir(projectPath, sessionId);
  const exists = await exec('git', ['rev-parse', '--verify', `${branch}^{commit}`], {
    cwd: projectPath,
  });
  const dirExists = existsSync(wtPath);
  if (exists.code === 0 && dirExists) {
    // 幂等：同一会话二次请求（重试 / 双击）原样返回，不重建
    return { ok: true, path: wtPath, branch };
  }
  if (dirExists) {
    return { ok: false, error: `worktree directory already exists: ${wtPath}` };
  }
  await ensureWorktreesIgnored(projectPath, exec);
  // 起会话那一拍主干工作区可能有用户自己的脏文件：worktree add 只动新目录与
  // 新分支，不碰工作区，安全；分支名冲突（同会话 id 撞了旧分支但目录没了）时
  // 复用既有分支（checkout 而不是 -b）。
  const add = exists.code === 0
    ? await exec('git', ['worktree', 'add', wtPath, branch], { cwd: projectPath })
    : await exec('git', ['worktree', 'add', '-b', branch, wtPath], { cwd: projectPath });
  if (add.code !== 0) {
    const msg = (add.stderr || add.stdout).trim().split('\n').slice(-3).join(' | ');
    return { ok: false, error: msg || 'git worktree add failed' };
  }
  return { ok: true, path: wtPath, branch };
}

export type MergeOutcome =
  | { ok: true; merged: true; branch: string }
  | { ok: false; merged: false; conflict: boolean; error: string };

/**
 * 结束并回：把会话分支 merge 进项目当前分支。约束（裁决钉死）：
 * - merge 前置检查工作区干净吗？**不**——主干工作区的脏文件是用户自己的活，
 *   merge 只要不撞上它们的路径就能走；撞上（git 自己拒绝）原样上报，绝不 stash。
 * - 冲突 = 立刻 `merge --abort` 恢复主干原状，登记落 `conflict`，worktree 完好保留。
 * - 幂等：已 merged 的登记直接命中返回；分支已并过（`git merge-base --is-ancestor`
 *   为真）也算已并（登记丢失时免重并）。
 */
export async function mergeSessionWorktree(
  projectPath: string,
  entry: SessionWorktreeEntry,
  exec: WorktreeGitExec = defaultWorktreeGitExec,
): Promise<MergeOutcome> {
  // 目标分支 = 项目当前检出分支（会话存活期间用户可能切过分支；合进「当下」那支）
  const head = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectPath });
  if (head.code !== 0) {
    return { ok: false, merged: false, conflict: false, error: 'cannot resolve current branch' };
  }
  const target = head.stdout.trim();
  const ancestor = await exec(
    'git',
    ['merge-base', '--is-ancestor', entry.branch, target],
    { cwd: projectPath },
  );
  if (ancestor.code === 0) {
    return { ok: true, merged: true, branch: entry.branch };
  }
  // 分支还活着吗：登记说有、git 说没有（用户删了）→ 如实报，不重建
  const verify = await exec('git', ['rev-parse', '--verify', `${entry.branch}^{commit}`], {
    cwd: projectPath,
  });
  if (verify.code !== 0) {
    return { ok: false, merged: false, conflict: false, error: `branch ${entry.branch} no longer exists` };
  }
  const merge = await exec('git', ['merge', '--no-edit', '--no-ff', entry.branch], {
    cwd: projectPath,
  });
  if (merge.code === 0) {
    return { ok: true, merged: true, branch: entry.branch };
  }
  // 冲突（或脏文件挡路）：一律 abort 还原，再按输出分档——冲突位由 abort 前的状态
  // 判（CONFLICT 字样），其余（untracked would be overwritten 等）归 error。
  const output = `${merge.stderr}\n${merge.stdout}`;
  await exec('git', ['merge', '--abort'], { cwd: projectPath });
  if (/CONFLICT/i.test(output)) {
    return { ok: false, merged: false, conflict: true, error: 'merge conflicts — worktree kept for manual merge' };
  }
  return { ok: false, merged: false, conflict: false, error: output.trim().split('\n').slice(-3).join(' | ') || 'git merge failed' };
}

/**
 * 清 worktree（已并回 / 会话删除后的落盘收尾）：`git worktree remove` + 删分支。
 * 冲突保留的 worktree **不由这里清**（用户还没并，目录就是他的工作现场）。
 * 失败静默（目录残留由 `git worktree prune` 在下次操作时自愈）。
 */
export async function cleanupSessionWorktree(
  projectPath: string,
  entry: SessionWorktreeEntry,
  exec: WorktreeGitExec = defaultWorktreeGitExec,
): Promise<void> {
  await exec('git', ['worktree', 'remove', entry.path], { cwd: projectPath });
  await exec('git', ['branch', '-D', entry.branch], { cwd: projectPath });
}

/**
 * worktree 路径归一（面板/登记按原样等值匹配口径）：worktree 里的会话 cwd 是
 * worktree 目录本身，与项目登记路径不同——按登记前缀认回所属项目。
 */
export function projectOfCwd(
  projects: ReadonlyArray<{ id: number; path: string }>,
  cwd: string | null | undefined,
): { id: number; path: string } | null {
  if (!cwd) return null;
  const normalized = path.normalize(cwd);
  let best: { id: number; path: string } | null = null;
  let bestLen = -1;
  for (const p of projects) {
    const base = path.normalize(p.path);
    if (normalized === base || normalized.startsWith(base + path.sep)) {
      if (base.length > bestLen) {
        best = p;
        bestLen = base.length;
      }
    }
  }
  return best;
}

/** 退出事件名（谁的 sessionExit 归 harness 生命周期表；非法 harness = 无退出事件）。 */
export function sessionExitEventOf(harness: string | null | undefined): string | null {
  if (!isHarness(harness)) return null;
  return HARNESS_LIFECYCLE[harness].sessionExit;
}

// ---- 结束并回的驱动（daemon 侧轮询，照 SessionSweeper/SnapshotRefresher 的哲学）----

export interface WorktreeMergeScanDeps {
  /** 会话行（listWithCounts 的派生字段 lastEventType / harness 是退出判据）；函数形态 = 每拍现取。 */
  sessions:
    | Array<{
        sessionId: string;
        harness?: Harness | null;
        lastEventType?: string | null;
      }>
    | (() => Array<{
        sessionId: string;
        harness?: Harness | null;
        lastEventType?: string | null;
      }>)
    | (() => ReadonlyArray<{
        sessionId: string;
        harness?: Harness | null;
        lastEventType?: string | null;
      }>);
  /** 项目路径反查（登记里的 projectId）。 */
  projectPathOf(projectId: number): string | undefined;
  /** 占位认领用：某项目最近的 hook 事件（payload 里带 cwd，事件序新→旧）。 */
  recentEventsOf?(projectId: number): ReadonlyArray<{ sessionId: string | null; payload: string }>;
  hooksDir: string;
  exec?: WorktreeGitExec;
  /** 每次登记变化后的回调（web 的合并状态展示走既有 sessions 失效帧）。 */
  onChange?: () => void;
}

/**
 * 扫一轮：登记里 status=active 且其会话已发退出事件的 → 并回 + 落盘收尾。
 * 挂点在 ingest 消费（inbox-worker）之外的 daemon 定时拍——**不动 B1 文件域**
 * （message-deliverer / delivery/send / inbox-worker），由装配方 15s 一拍调用。
 * 重启恢复即同一条路：登记在 cache 里，重启后第一次扫描把上次没接上的并回接完。
 *
 * 返回处理的会话数（测试断言用；无候选 = 0，可反复调用）。
 */
export async function sweepWorktreeMerges(deps: WorktreeMergeScanDeps): Promise<number> {
  const exec = deps.exec ?? defaultWorktreeGitExec;
  const entries = readWorktreeRegistry(deps.hooksDir);
  // 占位认领先走：pending 登记按「最近事件里 cwd 恰为该 worktree 路径」的会话改绑。
  if (deps.recentEventsOf) {
    for (const [key, entry] of Object.entries(entries)) {
      if (!key.startsWith(PENDING_WT_PREFIX)) continue;
      const events = deps.recentEventsOf(entry.projectId);
      for (const ev of events) {
        if (!ev.sessionId) continue;
        const cwd = payloadCwdOf(ev.payload);
        if (cwd && path.normalize(cwd) === path.normalize(entry.path)) {
          delete entries[key];
          entries[ev.sessionId] = { ...entry, sessionId: ev.sessionId };
          writeWorktreeRegistry(deps.hooksDir, entries);
          deps.onChange?.();
          break;
        }
      }
    }
  }
  let handled = 0;
  const sessionRows = typeof deps.sessions === 'function' ? deps.sessions() : deps.sessions;
  for (const entry of Object.values(entries)) {
    if (entry.status !== 'active') continue;
    const session = sessionRows.find((s) => s.sessionId === entry.sessionId);
    const exit = sessionExitEventOf(session?.harness);
    // 会话行没了（手动删过）或退出事件还没到：都不动（前者交孤儿清扫）
    if (!session || !exit || session.lastEventType !== exit) continue;
    const projectPath = deps.projectPathOf(entry.projectId);
    if (!projectPath) continue;
    const outcome = await mergeSessionWorktree(projectPath, entry, exec);
    const merged: SessionWorktreeEntry = outcome.ok
      ? { ...entry, status: 'merged', at: new Date().toISOString() }
      : outcome.conflict
        ? { ...entry, status: 'conflict', message: outcome.error, at: new Date().toISOString() }
        : { ...entry, status: 'error', message: outcome.error, at: new Date().toISOString() };
    upsertWorktreeEntry(deps.hooksDir, merged);
    if (outcome.ok) {
      await cleanupSessionWorktree(projectPath, entry, exec);
      removeWorktreeEntry(deps.hooksDir, entry.sessionId);
    }
    handled++;
    deps.onChange?.();
  }
  return handled;
}

/** 并回扫描节拍：15s 一拍（退出事件落库到并回之间的最坏延迟；同 SessionSweeper 量级）。 */
export const WORKTREE_SWEEP_INTERVAL_MS = 15_000;

/**
 * 两个 daemon 入口（start.ts / dev-entry.ts）共用的装配点：起定时器（unref——
 * 定时器不吊住 daemon 退出）。启动即扫一轮：上一个进程死前没接完的并回
 * （登记在 cache），重启后第一拍就接上（rearm 哲学）。
 */
export function startWorktreeMergeSweeper(
  deps: WorktreeMergeScanDeps,
): NodeJS.Timeout {
  const tick = (): void => {
    void sweepWorktreeMerges(deps).catch(() => {
      // 单轮失败（git 环境抖动等）不吊住调度：下一拍自会重试（登记状态如实可见）
    });
  };
  tick();
  const timer = setInterval(tick, WORKTREE_SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}

/** hook 事件 payload 里的 cwd（只解 JSON 的这一个字段；坏行 = null，不猜）。 */
function payloadCwdOf(payload: string): string | null {
  try {
    const raw: unknown = JSON.parse(payload);
    if (typeof raw !== 'object' || raw === null) return null;
    const cwd = (raw as { cwd?: unknown }).cwd;
    return typeof cwd === 'string' && cwd ? cwd : null;
  } catch {
    return null;
  }
}

/**
 * 占位认领（登记的 pending 键 → 真实 sessionId）：按 cwd 前缀反查 pending 登记，
 * 命中即改绑（目录名 / 分支名不动——分支与目录是会话的身份，登记键只是索引）。
 * 返回改绑后的登记（null = 没有占位命中；cwd 不是 worktree 目录也走 null）。
 */
export function claimPendingSessionWorktree(
  hooksDir: string,
  sessionId: string,
  cwd: string | null | undefined,
): SessionWorktreeEntry | null {
  if (!cwd || sessionId.startsWith(PENDING_WT_PREFIX)) return null;
  const normalized = path.normalize(cwd);
  const entries = readWorktreeRegistry(hooksDir);
  for (const [key, entry] of Object.entries(entries)) {
    if (!key.startsWith(PENDING_WT_PREFIX)) continue;
    if (path.normalize(entry.path) !== normalized) continue;
    delete entries[key];
    entries[sessionId] = { ...entry, sessionId };
    writeWorktreeRegistry(hooksDir, entries);
    return entries[sessionId]!;
  }
  return null;
}

/**
 * 孤儿清扫（daemon 启动一拍）：目录还在但登记早没了的 worktree（登记写失败 /
 * 手动删库残留）不猜归属、不删目录——只在 worktree 列表里 prune 已不存在的
 * 目录（git 自己的账本清理，零风险）。登记还在、目录没了的条目原样保留
 * （merge 侧会报 branch/目录问题，状态可见比静默消失诚实）。
 */
export async function pruneOrphanWorktrees(
  projectPaths: readonly string[],
  exec: WorktreeGitExec = defaultWorktreeGitExec,
): Promise<void> {
  for (const projectPath of projectPaths) {
    if (!existsSync(path.join(projectPath, '.weave', 'worktrees'))) continue;
    await exec('git', ['worktree', 'prune'], { cwd: projectPath });
  }
}
