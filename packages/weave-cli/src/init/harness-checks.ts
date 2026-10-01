import path from 'node:path';
import { lstat, readFile, readlink, access } from 'node:fs/promises';
import { t } from '../i18n/index.js';

/**
 * Health checks over the state `weave init` produced.
 *
 * These catch the failures that are invisible until something downstream
 * misbehaves — a symlink git checked out as a plain file on a machine without
 * `core.symlinks`, an absolute statusline path left over from a moved or
 * renamed checkout. Surfaced by `weave status`.
 */

export interface HarnessCheck {
  id: string;
  message: string;
  /** What the user should do about it. */
  fix: string;
}

const CLAUDE = 'CLAUDE.md';
const AGENTS = 'AGENTS.md';
const STATUSLINE_MARKER = '.claude/helpers/statusline.cjs';
const SETTINGS = '.claude/settings.json';

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Is `p` a symlink, and does its target resolve? */
async function linkState(p: string): Promise<'absent' | 'file' | 'link' | 'dangling'> {
  try {
    const st = await lstat(p);
    if (!st.isSymbolicLink()) return 'file';
    const target = path.resolve(path.dirname(p), await readlink(p));
    return (await pathExists(target)) ? 'link' : 'dangling';
  } catch {
    return 'absent';
  }
}

/**
 * Detect a symlink that git materialised as a plain file.
 *
 * On a Windows checkout with `core.symlinks=false`, git writes the link target
 * as the file's *content* — so AGENTS.md ends up containing the literal text
 * `CLAUDE.md` and Codex reads that instead of the instructions.
 */
async function checkLinkCheckout(dir: string): Promise<HarnessCheck | null> {
  const agents = path.join(dir, AGENTS);
  if ((await linkState(agents)) !== 'file') return null;

  const content = (await readFile(agents, 'utf-8').catch(() => '')).trim();
  if (content !== CLAUDE) return null;

  return {
    id: 'instruction-link-not-materialised',
    message: t('harness.instructionLinkNotMaterialised.message', { agents: AGENTS, claude: CLAUDE }),
    fix: t('harness.instructionLinkNotMaterialised.fix'),
  };
}

/** Detect both instruction files holding independent content (no link). */
async function checkDuplicateInstructions(dir: string): Promise<HarnessCheck | null> {
  const claude = await linkState(path.join(dir, CLAUDE));
  const agents = await linkState(path.join(dir, AGENTS));
  if (claude !== 'file' || agents !== 'file') return null;

  return {
    id: 'instruction-files-duplicated',
    message: t('harness.instructionFilesDuplicated.message', { claude: CLAUDE, agents: AGENTS }),
    fix: t('harness.instructionFilesDuplicated.fix'),
  };
}

/** Detect a symlink whose target is missing. */
async function checkDanglingLink(dir: string): Promise<HarnessCheck | null> {
  for (const name of [CLAUDE, AGENTS]) {
    if ((await linkState(path.join(dir, name))) !== 'dangling') continue;
    return {
      id: 'instruction-link-dangling',
      message: t('harness.instructionLinkDangling.message', { name }),
      fix: t('harness.instructionLinkDangling.fix'),
    };
  }
  return null;
}

/** Pull the script path out of a statusLine command string. */
function statuslinePath(command: string): string | null {
  const quoted = /"([^"]+)"/.exec(command);
  if (quoted) return quoted[1]!;
  const tokens = command.trim().split(/\s+/);
  const last = tokens[tokens.length - 1];
  return last && normalise(last).includes(STATUSLINE_MARKER) ? last : null;
}

/** Compare marker strings across Windows and POSIX separators. */
function normalise(command: string): string {
  return command.replace(/\\/g, '/');
}

/**
 * Detect a statusLine pointing at a path that is no longer valid.
 *
 * `weave init` records the helpers directory as an absolute path (Claude Code
 * expands `$VAR` unreliably on Windows), so moving or renaming the project
 * silently breaks the statusline until init runs again.
 */
async function checkStatuslinePath(dir: string): Promise<HarnessCheck | null> {
  const settingsPath = path.join(dir, SETTINGS);
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(await readFile(settingsPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }

  const statusLine = settings['statusLine'];
  if (!statusLine || typeof statusLine !== 'object') return null;
  const command = (statusLine as { command?: unknown }).command;
  // the marker is compared after normalising separators — on Windows the
  // generated command carries backslashes
  if (typeof command !== 'string' || !normalise(command).includes(STATUSLINE_MARKER)) return null;

  const scriptPath = statuslinePath(command);
  if (!scriptPath) {
    return {
      id: 'statusline-path-unresolved',
      message: t('harness.statuslinePathUnresolved.message', { command }),
      fix: t('harness.statuslinePathUnresolved.fix'),
    };
  }

  const expectedPrefix = path.resolve(dir) + path.sep;
  if (!path.resolve(scriptPath).startsWith(expectedPrefix)) {
    return {
      id: 'statusline-path-foreign',
      message: t('harness.statuslinePathForeign.message', { path: scriptPath }),
      fix: t('harness.statuslinePathForeign.fix'),
    };
  }

  if (!(await pathExists(scriptPath))) {
    return {
      id: 'statusline-script-missing',
      message: t('harness.statuslineScriptMissing.message', { path: scriptPath }),
      fix: t('harness.statuslineScriptMissing.fix'),
    };
  }

  return null;
}

/**
 * Run every harness check. Returns only the problems found, in reporting order.
 * Never throws — a check that cannot run is simply not reported.
 */
export async function checkHarness(dir: string): Promise<HarnessCheck[]> {
  const results = await Promise.all([
    checkLinkCheckout(dir),
    checkDuplicateInstructions(dir),
    checkDanglingLink(dir),
    checkStatuslinePath(dir),
  ]);
  return results.filter((c): c is HarnessCheck => c !== null);
}
