import path from 'node:path';
import { lstat, readFile, readlink, access } from 'node:fs/promises';

/**
 * Health checks over the state `weave init` produced, as structured results.
 *
 * These catch the failures that are invisible until something downstream
 * misbehaves — a symlink git checked out as a plain file on a machine without
 * `core.symlinks`, an absolute statusline path left over from a moved or
 * renamed checkout. Surfaced by `weave status` and the dashboard.
 *
 * i18n discipline: core 只返回结构（id + 插值原料 + ok），不产生任何显示文案——
 * CLI 与 web 各用自己的词典按 id 渲染 message/fix。
 */

export interface HarnessCheck {
  id: string;
  /** Interpolation material for the render-side dictionary (paths, names…). */
  params: Record<string, string | boolean>;
  /** `false` = problem found; `true` = check ran and passed. */
  ok: boolean;
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
  return {
    id: 'instruction-link-not-materialised',
    params: { agents: AGENTS, claude: CLAUDE },
    ok: content !== CLAUDE,
  };
}

/** Detect both instruction files holding independent content (no link). */
async function checkDuplicateInstructions(dir: string): Promise<HarnessCheck | null> {
  const claude = await linkState(path.join(dir, CLAUDE));
  const agents = await linkState(path.join(dir, AGENTS));
  if (claude === 'absent' || agents === 'absent') return null;

  return {
    id: 'instruction-files-duplicated',
    params: { claude: CLAUDE, agents: AGENTS },
    ok: !(claude === 'file' && agents === 'file'),
  };
}

/**
 * Detect a symlink whose target is missing. Failure semantics mirror the
 * original check exactly: report the first dangling name only (CLAUDE first),
 * so `weave status` output stays byte-identical; healthy links still emit an
 * `ok: true` entry as positive signal for the dashboard.
 */
async function checkDanglingLinks(dir: string): Promise<HarnessCheck[]> {
  const results: HarnessCheck[] = [];
  for (const name of [CLAUDE, AGENTS]) {
    const state = await linkState(path.join(dir, name));
    if (state === 'dangling') {
      results.push({ id: 'instruction-link-dangling', params: { name }, ok: false });
      break;
    }
    if (state === 'link') {
      results.push({ id: 'instruction-link-dangling', params: { name }, ok: true });
    }
  }
  return results;
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
 * silently breaks the statusline until init runs again. Three chained checks —
 * each entry is only evaluated when the previous stage resolved.
 */
async function checkStatuslinePath(dir: string): Promise<HarnessCheck[]> {
  const settingsPath = path.join(dir, SETTINGS);
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(await readFile(settingsPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return [];
  }

  const statusLine = settings['statusLine'];
  if (!statusLine || typeof statusLine !== 'object') return [];
  const command = (statusLine as { command?: unknown }).command;
  // the marker is compared after normalising separators — on Windows the
  // generated command carries backslashes
  if (typeof command !== 'string' || !normalise(command).includes(STATUSLINE_MARKER)) return [];

  const scriptPath = statuslinePath(command);
  if (!scriptPath) {
    return [{ id: 'statusline-path-unresolved', params: { command }, ok: false }];
  }

  const entries: HarnessCheck[] = [
    { id: 'statusline-path-unresolved', params: { command }, ok: true },
  ];

  const expectedPrefix = path.resolve(dir) + path.sep;
  if (!path.resolve(scriptPath).startsWith(expectedPrefix)) {
    entries.push({ id: 'statusline-path-foreign', params: { path: scriptPath }, ok: false });
    return entries;
  }
  entries.push({ id: 'statusline-path-foreign', params: { path: scriptPath }, ok: true });
  entries.push({
    id: 'statusline-script-missing',
    params: { path: scriptPath },
    ok: await pathExists(scriptPath),
  });
  return entries;
}

/**
 * Run every harness check. Returns structured results in reporting order —
 * passing entries carry `ok: true`, checks whose preconditions do not hold are
 * omitted ("a check that cannot run is simply not reported").
 * Never throws.
 */
export async function checkHarness(dir: string): Promise<HarnessCheck[]> {
  const [linkCheckout, duplicate, dangling, statusline] = await Promise.all([
    checkLinkCheckout(dir),
    checkDuplicateInstructions(dir),
    checkDanglingLinks(dir),
    checkStatuslinePath(dir),
  ]);
  return [linkCheckout, duplicate, ...dangling, ...statusline].filter(
    (c): c is HarnessCheck => c !== null,
  );
}
