import path from 'node:path';
import { lstat, mkdir, readFile, readlink, symlink, unlink, writeFile } from 'node:fs/promises';

/**
 * Keep CLAUDE.md and AGENTS.md as one file.
 *
 * Both names mean "the agent instructions for this project", and Codex reads
 * AGENTS.md natively while Claude Code reads CLAUDE.md. Writing both invites
 * drift, so weave writes one and makes the other a symlink.
 *
 * The link target is always RELATIVE (`AGENTS.md -> CLAUDE.md`) so the pair
 * survives a clone onto another machine. Note that a committed symlink is only
 * materialised as a link where git's `core.symlinks` is true — a Windows
 * checkout without Developer Mode gets a plain file containing the target
 * path. `weave doctor` detects that.
 */

/** Which of the two names holds the real content. CLAUDE.md wins when both exist. */
export type InstructionFile = 'CLAUDE.md' | 'AGENTS.md';

export interface InstructionLinkOptions {
  /** Take the default action without asking. */
  force: boolean;
  /** False in non-interactive runs (defaults are taken silently). */
  interactive: boolean;
  /**
   * Ask the user to choose. Injected so tests (and non-TTY runs) can decide
   * without a real prompt.
   */
  confirm: (question: string, detail: string) => Promise<boolean>;
}

export interface InstructionLinkResult {
  action: 'created' | 'linked' | 'replaced' | 'adopted' | 'unchanged';
  /** The file that holds the content; the other name links to it. */
  realFile: InstructionFile;
  /** Where a displaced file was preserved, when one was. */
  backedUpTo?: string;
}

const CLAUDE = 'CLAUDE.md';
const AGENTS = 'AGENTS.md';

type FileState = 'absent' | 'file' | 'link' | 'broken-link';

async function stateOf(file: string): Promise<{ state: FileState; target?: string }> {
  try {
    const st = await lstat(file);
    if (st.isSymbolicLink()) {
      const target = await readlink(file);
      // a link whose target is missing is effectively absent, but we still
      // need to remove the dangling entry before creating a new one
      try {
        await readFile(path.resolve(path.dirname(file), target));
        return { state: 'link', target };
      } catch {
        return { state: 'broken-link', target };
      }
    }
    return { state: 'file' };
  } catch {
    return { state: 'absent' };
  }
}

/** Create `linkName -> targetName` using a relative target. */
async function makeLink(dir: string, linkName: string, targetName: string): Promise<void> {
  const linkPath = path.join(dir, linkName);
  try {
    await symlink(targetName, linkPath, 'file');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      `Could not create ${linkName} -> ${targetName} (${linkPath}): ${
        code === 'EPERM' || code === 'EACCES' || code === 'UNKNOWN'
          ? 'this system does not allow symlinks without elevation. On Windows, enable Developer Mode ' +
            '(Settings > System > For developers) or run weave init from an elevated shell, then retry.'
          : String(err)
      }`,
    );
  }
}

/**
 * Preserve a file about to be replaced, under `.weave/backup/` (already
 * self-ignored, so the copy never lands in version control).
 */
async function backup(dir: string, name: string): Promise<string> {
  const dirPath = path.join(dir, '.weave', 'backup');
  await mkdir(dirPath, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dirPath, `${name}.${stamp}`);
  await writeFile(dest, await readFile(path.join(dir, name), 'utf-8'), 'utf-8');
  return dest;
}

/**
 * Ensure CLAUDE.md and AGENTS.md resolve to a single file.
 *
 * | CLAUDE.md | AGENTS.md | action                                        |
 * |-----------|-----------|-----------------------------------------------|
 * | absent    | absent    | link AGENTS.md -> CLAUDE.md (caller writes it) |
 * | present   | absent    | link AGENTS.md -> CLAUDE.md                   |
 * | absent    | present   | adopt AGENTS.md; link CLAUDE.md -> AGENTS.md  |
 * | present   | present   | ask; default: back up AGENTS.md, replace it   |
 * | either is already the right link |      | no-op                                    |
 *
 * Never deletes content without preserving it first — the default action for
 * the both-present case is destructive, so `backup()` always runs before the
 * unlink.
 */
export async function ensureInstructionLink(
  dir: string,
  opts: InstructionLinkOptions,
): Promise<InstructionLinkResult> {
  const claudePath = path.join(dir, CLAUDE);
  const agentsPath = path.join(dir, AGENTS);
  const claude = await stateOf(claudePath);
  const agents = await stateOf(agentsPath);

  // Already linked the way we want. A dangling AGENTS.md -> CLAUDE.md still
  // counts: the caller writes CLAUDE.md immediately after this call, and
  // treating it as "needs replacing" would prompt on every re-init.
  if (claude.state === 'link' && claude.target === AGENTS && agents.state === 'file') {
    return { action: 'unchanged', realFile: AGENTS };
  }
  if ((agents.state === 'link' || agents.state === 'broken-link') && agents.target === CLAUDE) {
    return { action: 'unchanged', realFile: CLAUDE };
  }

  // Only AGENTS.md carries content — adopt it rather than overwrite either way.
  if (claude.state === 'absent' && agents.state === 'file') {
    await makeLink(dir, CLAUDE, AGENTS);
    return { action: 'adopted', realFile: AGENTS };
  }

  // Nothing in the way for AGENTS.md: link it to CLAUDE.md, which the caller
  // then writes (or has already written — it may exist, or not yet).
  if (agents.state === 'absent') {
    // a dangling CLAUDE.md (e.g. left by an interrupted run) blocks symlink()
    if (claude.state === 'link' || claude.state === 'broken-link') await unlink(claudePath);
    await makeLink(dir, AGENTS, CLAUDE);
    return { action: 'created', realFile: CLAUDE };
  }

  // Both names exist and AGENTS.md holds independent content.
  const replaceAgents = opts.force
    ? true
    : await opts.confirm(
        'CLAUDE.md 与 AGENTS.md 都包含内容',
        `将把 AGENTS.md 替换为指向 CLAUDE.md 的软连接（原文件会备份到 .weave/backup/）。`,
      );
  if (!replaceAgents) {
    return { action: 'unchanged', realFile: CLAUDE };
  }

  const backedUpTo =
    agents.state === 'file' ? await backup(dir, AGENTS) : undefined;
  await unlink(agentsPath);
  await makeLink(dir, AGENTS, CLAUDE);
  return { action: 'replaced', realFile: CLAUDE, backedUpTo };
}
