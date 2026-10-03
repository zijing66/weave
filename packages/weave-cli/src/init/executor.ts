import path from 'node:path';
import { readFile, writeFile, stat } from 'node:fs/promises';
import {
  type InitOptions,
  type InitResult,
  type PlatformInfo,
  type Harness,
  detectPlatform,
  resolveComponents,
  DEFAULT_HOOKS,
  HARNESS_DIRS,
  HARNESS_KEYS,
  ensureDir,
  fileExists,
  logger,
} from '@weave/core';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — weave-templates is symlinked via pnpm workspaces
import { templateRegistry } from '@weave/templates';
import { WEAVE_VERSION } from '@weave/server';
import type { InitContext } from '@weave/harness';
import {
  generateClaudeMd,
  generateClaudeMdSection,
  mergeClaudeMd,
  type ClaudeMdTemplate,
} from './claudemd-gen.js';
import { ensureInstructionLink } from './instruction-link.js';
import { buildInitRegistry } from './wiring.js';
import { type ClaudePipeline } from './harnesses/claude.js';
import { createPromptPort, type PromptPort } from './prompt.js';
import { t } from '../i18n/index.js';

/** Map preset → CLAUDE.md template */
const PRESET_TEMPLATE: Record<string, ClaudeMdTemplate> = {
  minimal: 'minimal',
  default: 'standard',
  full: 'full',
};

/** 默认 harness 面：非 TTY / --no-interactive / 未选择时的回落值。 */
const DEFAULT_HARNESSES: Harness[] = ['claude'];

/**
 * 三级选择（图①-b 步 1）：`--harness` flag > 交互 prompt.multiselect() > 默认 `['claude']`。
 * 交互仅在 `interactive` 且 stdin/stdout 均为 TTY 时进行——`createPromptPort`
 * 内部另查一次 TTY（非 TTY 静默取 defaults），注入的假 PromptPort 供测试驱动第二级。
 */
async function selectHarnesses(options: InitOptions, prompt: PromptPort): Promise<Harness[]> {
  if (options.harnesses && options.harnesses.length > 0) return [...options.harnesses];
  if (!options.interactive) return [...DEFAULT_HARNESSES];
  if (!process.stdin.isTTY || !process.stdout.isTTY) return [...DEFAULT_HARNESSES];
  const picked = await prompt.multiselect(HARNESS_KEYS, DEFAULT_HARNESSES);
  return picked.length > 0 ? [...picked] : [...DEFAULT_HARNESSES];
}

/**
 * init 编排器（图① InitOrchestrator，模板方法 executeInit）：
 * 0 prepare（平台 / 组件 / PromptPort）→ 1 selected → 2 逐 harness runSurface
 * （InitPipeline final 骨架 1→2→3→4→5→6→6b→7）→ 8 指令文件 → 9 runtime config
 * → 10 嵌套 gitignore → 11 汇总。表面步骤（1–7）的实现在 init/harnesses/ 下。
 * `prompt` 可注入（测试用假实现驱动多选优先级）。
 */
export async function executeInit(
  options: InitOptions,
  promptOverride?: PromptPort,
): Promise<InitResult> {
  const { targetDir, force, interactive, preset } = options;

  // ---- Step 0: prepare（平台 / 组件 / PromptPort / 结果累加器）----
  const platform: PlatformInfo = detectPlatform();
  const created: { directories: string[]; files: string[] } = { directories: [], files: [] };
  const skipped: string[] = [];
  const merged: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  const errors: string[] = [];

  const components = resolveComponents(preset, options.components);
  const hooks = { ...DEFAULT_HOOKS, ...options.hooks };
  const prompt = promptOverride ?? createPromptPort(interactive);

  if (!interactive) {
    logger.dim(t('init.nonInteractive'));
  }

  // ---- Step 1: selected —— flag > 交互多选 > 默认 ['claude'] ----
  const selected = await selectHarnesses(options, prompt);

  // ---- Step 2: 逐 harness 跑 InitPipeline final 骨架 ----
  const ctx: InitContext = { ...options, platform };
  const registry = buildInitRegistry();
  for (const h of selected) {
    const pipeline = new (registry.initFor(h)!)(ctx) as ClaudePipeline;
    await pipeline.runSurface();
    const rec = pipeline.records;
    created.directories.push(...rec.created.directories);
    created.files.push(...rec.created.files);
    skipped.push(...rec.skipped);
    merged.push(...rec.merged);
    updated.push(...rec.updated);
    removed.push(...rec.removed);
  }

  // ---- Step 8: Instruction file (CLAUDE.md / AGENTS.md) ----
  // The two names mean the same thing to different agents (Claude Code reads
  // CLAUDE.md, Codex reads AGENTS.md), so weave keeps ONE file and links the
  // other name to it rather than writing both and letting them drift.
  //
  // Policy for the real file (user file: append-only): a fresh one is generated
  // whole; an existing one only ever receives weave's delimited block (appended,
  // or replaced when already present). Content outside the markers is untouched.
  if (components.claudeMd || components.agentsMd) {
    const link = await ensureInstructionLink(targetDir, {
      force,
      interactive,
      confirm: (question, detail) => prompt.confirm(question, detail),
    });
    if (link.backedUpTo) {
      logger.dim(t('init.backedUp', { path: link.backedUpTo }));
      created.files.push(link.backedUpTo);
    }

    const template = PRESET_TEMPLATE[preset] ?? 'standard';
    const projectName = path.basename(targetDir);
    const instructionPath = path.join(targetDir, link.realFile);
    const fresh = generateClaudeMd({ template, projectName });

    if (force) {
      await writeFile(instructionPath, fresh, 'utf-8');
      created.files.push(instructionPath);
    } else {
      const existing = await readTextIfPresent(instructionPath);
      if (existing === null) {
        await writeFile(instructionPath, fresh, 'utf-8');
        created.files.push(instructionPath);
      } else {
        const section = generateClaudeMdSection({ template, projectName });
        await writeFile(instructionPath, mergeClaudeMd(existing, section), 'utf-8');
        merged.push(instructionPath);
      }
    }
  }

  // ---- Step 9: Write runtime config ----
  // .weave/ is weave's own state: always rewritten so re-init refreshes the
  // timestamp/preset. (weave-特性文件可以覆写)
  {
    const weaveDir = path.join(targetDir, '.weave');
    await ensureDir(weaveDir);
    created.directories.push(weaveDir);

    const runtimeConfig = {
      initVersion: WEAVE_VERSION,
      initTimestamp: new Date().toISOString(),
      preset,
      harnesses: selected,
      components: { settings: components.settings, skills: components.skills, commands: components.commands, agents: components.agents, helpers: components.helpers, mcp: components.mcp, claudeMd: components.claudeMd, agentsMd: components.agentsMd },
    };

    const configPath = path.join(weaveDir, 'config.yaml');
    const yamlContent = Object.entries(runtimeConfig)
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join('\n') + '\n';

    const existed = await fileExists(configPath);
    await writeFile(configPath, yamlContent, 'utf-8');
    (existed ? updated : created.files).push(configPath);
  }

  // ---- Step 10: Keep weave's generated dirs out of version control ----
  // `.claude/`（或 codex 选择时的 `.codex/`）与 `.weave/` hold machine-local,
  // regenerable content (a statusline script embedding this machine's absolute
  // paths, init metadata). Each gets a self-ignoring `.gitignore` rather than an
  // entry in the user's root `.gitignore`: the nested file is itself committed,
  // so a teammate who clones inherits the rule without weave ever editing a
  // file the user owns.
  for (const h of selected) {
    await ensureNestedGitignore(targetDir, path.join(targetDir, HARNESS_DIRS[h].projectDir), created);
  }
  await ensureNestedGitignore(targetDir, path.join(targetDir, '.weave'), created);

  // ---- Aggregate summary ----
  const summary = {
    skillsCount: templateRegistry.getByCategory('skill').length,
    commandsCount: templateRegistry.getByCategory('command').length,
    agentsCount: templateRegistry.getByCategory('agent').length,
    hooksEnabled: [
      hooks.preToolUse,
      hooks.postToolUse,
      hooks.userPromptSubmit,
      hooks.sessionStart,
      hooks.stop,
      hooks.subagentStop,
      hooks.notification,
    ]
      .filter(Boolean).length,
  };

  return {
    success: errors.length === 0,
    platform,
    created,
    skipped,
    merged,
    updated,
    removed,
    errors,
    summary,
  };
}

/**
 * Self-ignoring `.gitignore` contents written into each weave-generated dir.
 *
 * `*` ignores everything beside the file itself; the `!` line keeps this file
 * tracked so the rule travels with the repository.
 */
const NESTED_GITIGNORE = `# weave — generated; do not commit
*
!.gitignore
`;

/**
 * Write a self-ignoring `.gitignore` into a weave-generated directory.
 *
 * The user's own root `.gitignore` is never touched (`.git/info/exclude` is not
 * used either — it is machine-local, so a teammate cloning the repo would not
 * inherit the rule). Idempotent; a no-op outside a git repository, matching the
 * previous behaviour for projects weave is run in before `git init`.
 */
async function ensureNestedGitignore(
  targetDir: string,
  dir: string,
  created: { directories: string[]; files: string[] },
): Promise<void> {
  if (!(await findGitRepoRoot(targetDir))) return;

  const file = path.join(dir, '.gitignore');
  const existing = await readTextIfPresent(file);
  if (existing === NESTED_GITIGNORE) return;

  await ensureDir(dir);
  await writeFile(file, NESTED_GITIGNORE, 'utf-8');
  created.files.push(file);
}

/**
 * Walk up from `startDir` to find the enclosing git repository root (a
 * directory containing `.git`). Returns null when outside a repository, or
 * when `.git` is a file (worktree/submodule) — weave does not resolve gitdirs
 * and leaves those alone.
 */
async function findGitRepoRoot(startDir: string): Promise<string | null> {
  let dir = path.resolve(startDir);
  for (;;) {
    try {
      const st = await stat(path.join(dir, '.git'));
      return st.isDirectory() ? dir : null;
    } catch {
      // no .git here — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Read a file's text, or null when absent. Any other error propagates. */
async function readTextIfPresent(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (err) {
    if (isMissingFileError(err)) return null;
    throw err;
  }
}

function isMissingFileError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
