import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { LOCAL_INSTRUCTION_FILES, logger } from '@weavecode/core';
import { t } from '../i18n/index.js';
import { findGitRepoRoot } from './git-commit.js';

/**
 * 本机私有指令文件的 git 免登记（`.git/info/exclude`）。
 *
 * `CLAUDE.local.md` / `AGENTS.override.md` 是**机器本地的**（用户手编、weave
 * 从不写内容）——与嵌套 gitignore「要随仓传播」的需求相反，exclude 的
 * per-clone 语义恰好正确：本机不进 git status、协作者不受影响。用户自己的
 * `.gitignore` 永不碰（既有裁决），git 仓缺席时静默跳过。
 *
 * 写入走 `# weave:start/end` 标记块（与 CLAUDE.md 管理块同约定）：重跑 init
 * 原地替换，幂等。
 */

export const EXCLUDE_BLOCK_START = '# weave:start';
export const EXCLUDE_BLOCK_END = '# weave:end';

/** 免登记名单：local 指令文件 + `.weave/token`（本机凭据，config.yaml 仍可提交）。 */
export function excludeEntries(): readonly string[] {
  return [...LOCAL_INSTRUCTION_FILES, '.weave/token'];
}

/**
 * Ensure the repo's `info/exclude` carries weave's block. Idempotent; a no-op
 * outside a git repository (matches nested-gitignore behaviour).
 */
export async function ensureGitExcludes(targetDir: string): Promise<void> {
  const repoRoot = await findGitRepoRoot(targetDir);
  if (!repoRoot) return;

  const excludePath = path.join(repoRoot, '.git', 'info', 'exclude');
  const existing = (await readFile(excludePath, 'utf-8').catch(() => null)) ?? '';
  const startIdx = existing.indexOf(EXCLUDE_BLOCK_START);
  const endIdx = existing.indexOf(EXCLUDE_BLOCK_END);

  // 标记块已在 → 内容不变就是幂等命中（行集固定，无需重写）
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) return;

  const block = `${EXCLUDE_BLOCK_START}\n${excludeEntries().join('\n')}\n${EXCLUDE_BLOCK_END}\n`;
  const merged =
    startIdx !== -1 || endIdx !== -1
      ? existing // 半截块（手动删了一半）：不猜，原样保留
      : existing.replace(/\s*$/, '') + (existing.trim() ? '\n\n' : '') + block;

  await mkdir(path.dirname(excludePath), { recursive: true });
  await writeFile(excludePath, merged, 'utf-8');
  logger.dim(t('init.exclude.done', { file: path.relative(repoRoot, excludePath) }));
}
