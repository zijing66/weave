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

/** 跑一个只读 git 子进程；非 0 退出不算失败（`check-ignore` 无命中即 1）。 */
function git(projectPath: string, args: string[]): Promise<{ stdout: string; ran: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', projectPath, ...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let stdout = '';
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', () => resolve({ stdout: '', ran: false }));
    child.on('close', () => resolve({ stdout, ran: true }));
  });
}

function splitNul(raw: string): string[] {
  return raw.split('\0').filter((s) => s.length > 0);
}

/**
 * 对给定的项目相对路径（posix 分隔）做一次批量分类。
 * 起两个进程以内：`ls-files` 取 tracked → `check-ignore` 只问还没归类的候选
 * （`check-ignore -z` 只配 `--stdin`，这里走参数式、按行切）。
 */
export async function gitClassify(
  projectPath: string,
  relPaths: readonly string[],
): Promise<GitClassify> {
  const paths = [...new Set(relPaths)];
  const kinds = new Map<string, GitPathKind>();

  const listed = paths.length > 0
    ? await git(projectPath, ['ls-files', '-z', '--', ...paths])
    : { stdout: '', ran: true };

  // `ls-files` 在非 git 仓库下直接失败——此时全算「不进 git」。
  if (!listed.ran) {
    for (const p of paths) kinds.set(p, 'outside');
    return classifier(kinds);
  }

  const tracked = new Set(splitNul(listed.stdout));
  const rest: string[] = [];
  for (const p of paths) {
    if (tracked.has(p)) kinds.set(p, 'tracked');
    else rest.push(p);
  }

  // 非 git 仓库的 `ls-files` 会带 fatal 但进程仍在——用 work-tree 探测兜底。
  if (rest.length > 0) {
    const workTree = await git(projectPath, ['rev-parse', '--is-inside-work-tree']);
    const inRepo = workTree.ran && workTree.stdout.trim() === 'true';
    if (!inRepo) {
      for (const p of rest) kinds.set(p, 'outside');
      return classifier(kinds);
    }
    const ignored = await git(projectPath, ['check-ignore', '--', ...rest]);
    const ignoredSet = new Set(ignored.stdout.split(/\r?\n/).filter((s) => s.length > 0));
    for (const p of rest) kinds.set(p, ignoredSet.has(p) ? 'ignored' : 'untracked');
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
