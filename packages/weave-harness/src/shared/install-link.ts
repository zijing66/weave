import { cp, lstat, mkdir, rm, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * 装面安装链路（批 9，R9）：全局安装 symlink 优先，失败回退复制。
 * 卸载先 lstat——链接只 unlink（绝不递归，防删穿市场源），复制体才 rm 递归。
 *
 * 落在 harness 而非 server：全局装面（`~/.claude/skills`、`~/.claude/weave-marketplace`、
 * `~/.agents/skills`）本就是 harness 专属布局，而「往这些位置铺包」的 harness 侧
 * 实现（`claude/plugins.ts`）也要用它——原语放 server 会让 harness 反向依赖 server，
 * 违反 `@weavecode/harness → @weavecode/core` 是 harness 唯一外向依赖。
 * server 侧（`market/install-link.ts`）保留同名薄委托，消费点零改。
 */

/** 安装形态：`link` = symlink/junction，`copy` = 复制回退。 */
export type InstallLinkMode = 'link' | 'copy';

export type RemoveInstalledResult = 'link' | 'removed' | 'absent';

/** Windows junction 免特权，POSIX 用 dir 链接；EPERM/EEXIST/ENOTSUP → 回退 cp。 */
export async function linkOrCopy(source: string, target: string): Promise<InstallLinkMode> {
  const src = path.resolve(source);
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await symlink(src, target, process.platform === 'win32' ? 'junction' : 'dir');
    return 'link';
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EEXIST' && code !== 'ENOTSUP') throw e;
  }
  await cp(src, target, { recursive: true });
  return 'copy';
}

/** 卸载装面副本：lstat 是链接 → unlink；普通目录 → rm 递归；不存在 → no-op。 */
export async function removeInstalled(target: string): Promise<RemoveInstalledResult> {
  let st;
  try {
    st = await lstat(target);
  } catch {
    return 'absent';
  }
  if (st.isSymbolicLink()) {
    await unlink(target);
    return 'link';
  }
  await rm(target, { recursive: true, force: true });
  return 'removed';
}

/**
 * 读侧判定装面形态——**不落状态**，每次按盘上实际情形判：状态会失真（用户手动
 * 改过、回退复制过、包升级后重铺过），lstat 不会。UI 据此标「链接/副本」，
 * 副本态提示可开开发者模式改用链接。
 */
export async function installForm(target: string): Promise<InstallLinkMode | 'absent'> {
  try {
    const st = await lstat(target);
    return st.isSymbolicLink() ? 'link' : 'copy';
  } catch {
    return 'absent';
  }
}
