import { spawn } from 'node:child_process';

/**
 * 项目内路径「进不进 git」的分类——同步域自动/手动分界的唯一判据。
 *
 * 用户裁决：**不进 git 的自动同步；进 git 的仍走 `weave init` 生成 + commit**，
 * 同步域只检测漂移、dashboard 提醒用户去终端跑 `weave init`（不代写）。
 *
 * 「会进 git」= tracked ∪ untracked-but-not-ignored（后者下次 `git add` 就进）。
 * 所以 `check-ignore` 单独用不够——tracked 文件也可能命中 ignore 规则，判序恒为
 * 先 tracked、后 ignored。非 git 仓库全算「不进 git」。
 *
 * 一轮 sweep 建一次（`gitClassify`），别逐文件起进程。
 */

/** 一条路径的同步归类。 */
export type SyncClass = 'auto' | 'manual';

export type GitPathKind = 'tracked' | 'ignored' | 'untracked' | 'outside';

export interface GitClassify {
  /** 相对路径 → 实际 git 状态。 */
  kindOf(relPath: string): GitPathKind;
  /** `auto` = 不进 git（代写无害、自愈）；`manual` = 会进 git（只报不写）。 */
  classOf(relPath: string): SyncClass;
}

interface GitRun {
  stdout: string;
  /** false = 进程根本没跑起来（git 不在 PATH / 目录不存在）。 */
  ran: boolean;
  /** 退出码；`check-ignore` 无命中即 1，不算失败。 */
  code: number | null;
}

/** 跑一个只读 git 子进程；`input` 给定时走 stdin（`-z --stdin` 用）。 */
function git(projectPath: string, args: string[], input?: string): Promise<GitRun> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', projectPath, ...args], {
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let stdout = '';
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', () => resolve({ stdout: '', ran: false, code: null }));
    child.on('close', (code) => resolve({ stdout, ran: true, code }));
    if (input !== undefined) child.stdin?.end(input);
  });
}

function splitNul(raw: string): string[] {
  return raw.split('\0').filter((s) => s.length > 0);
}

/**
 * 对给定的项目相对路径（posix 分隔）做一次批量分类。
 *
 * 两条查询**并行**起：`ls-files` 取 tracked、`check-ignore --stdin` 取 ignored，
 * 都没命中的在仓库里即 untracked。原先串行三轮（ls-files → rev-parse → check-ignore）
 * 在 Windows 上是 `/projects/:id/updates` 的全部耗时（实测 ~450ms，每个 git 子进程
 * 约 150ms）；仓库探测改看 `ls-files` 的退出码，省掉 `rev-parse` 那一轮。
 */
export async function gitClassify(
  projectPath: string,
  relPaths: readonly string[],
): Promise<GitClassify> {
  const paths = [...new Set(relPaths)];
  const kinds = new Map<string, GitPathKind>();
  if (paths.length === 0) return classifier(kinds);

  const [listed, ignored] = await Promise.all([
    git(projectPath, ['ls-files', '-z', '--', ...paths]),
    // 默认会跳过 index 里已有的路径，故 tracked 恒先命中，判序不用自己管。
    git(projectPath, ['check-ignore', '-z', '--stdin'], paths.map((p) => `${p}\0`).join('')),
  ]);

  // 非 git 仓库下 `ls-files` 直接失败（退出码 128）——此时全算「不进 git」。
  if (!listed.ran || listed.code !== 0) {
    for (const p of paths) kinds.set(p, 'outside');
    return classifier(kinds);
  }

  const tracked = new Set(splitNul(listed.stdout));
  const ignoredSet = new Set(splitNul(ignored.stdout));
  for (const p of paths) {
    kinds.set(p, tracked.has(p) ? 'tracked' : ignoredSet.has(p) ? 'ignored' : 'untracked');
  }
  return classifier(kinds);
}

function classifier(kinds: Map<string, GitPathKind>): GitClassify {
  const kindOf = (relPath: string): GitPathKind => kinds.get(relPath) ?? 'outside';
  return {
    kindOf,
    classOf: (relPath: string): SyncClass => {
      const kind = kindOf(relPath);
      return kind === 'ignored' || kind === 'outside' ? 'auto' : 'manual';
    },
  };
}
