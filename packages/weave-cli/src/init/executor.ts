import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import {
  type InitOptions,
  type InitResult,
  type PlatformInfo,
  type Harness,
  detectPlatform,
  resolveComponents,
  DEFAULT_HOOKS,
  DEFAULT_MCP,
  HARNESS_DIRS,
  HARNESS_KEYS,
  ensureDir,
  fileExists,
  logger,
} from '@weavecode/core';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — weave-templates is symlinked via pnpm workspaces
import { templateRegistry } from '@weavecode/templates';
import { WEAVE_VERSION } from '@weavecode/server';
import type { InitContext } from '@weavecode/harness';
import type { ClaudeMdTemplate } from './claudemd-gen.js';
import { writeInstructionFiles } from './instruction-files.js';
import { buildInitRegistry } from './wiring.js';
import { type SurfacePipeline } from './types.js';
import { createPromptPort, type PromptPort } from './prompt.js';
import { commitInitOutputs, defaultGitExec, findGitRepoRoot } from './git-commit.js';
import { ensureGitExcludes } from './git-exclude.js';
import { ensureHarnessInstalled, prewriteTrust } from './provision.js';
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
 * 0 prepare（平台 / 组件 / PromptPort）→ 1 selected → 1.5/1.6 环境备置（安装
 * 检测 + 信任预写）→ 2 逐 harness runSurface（InitPipeline final 骨架
 * 1→2→3→4→5→6→6b→7）→ 8 指令文件 → 9 runtime config → 10 嵌套 gitignore
 * → 11 询问 commit init 生成物 → 12 汇总。表面步骤（1–7）的实现在
 * init/harnesses/ 下。`prompt` 可注入（测试用假实现驱动多选优先级）。
 */
export async function executeInit(
  options: InitOptions,
  promptOverride?: PromptPort,
): Promise<InitResult> {
  const { targetDir, interactive, preset } = options;

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
  const mcp = { ...DEFAULT_MCP, ...options.mcp };
  const prompt = promptOverride ?? createPromptPort(interactive);

  if (!interactive) {
    logger.dim(t('init.nonInteractive'));
  }

  // ---- Step 1: selected —— flag > 交互多选 > 默认 ['claude'] ----
  const selected = await selectHarnesses(options, prompt);

  // ---- Step 1.5/1.6: 环境备置（安装检测 + 信任预写）——失败降级为 warn，不阻断 ----
  try {
    await ensureHarnessInstalled(selected, prompt);
  } catch (err) {
    logger.warn((err as Error).message);
  }
  try {
    await prewriteTrust(selected, targetDir);
  } catch (err) {
    logger.warn((err as Error).message);
  }

  // ---- Step 2: 逐 harness 跑 InitPipeline final 骨架 ----
  const ctx: InitContext = { ...options, platform };
  const registry = buildInitRegistry();
  for (const h of selected) {
    const pipeline = new (registry.initFor(h)!)(ctx) as SurfacePipeline;
    await pipeline.runSurface();
    const rec = pipeline.records;
    created.directories.push(...rec.created.directories);
    created.files.push(...rec.created.files);
    skipped.push(...rec.skipped);
    merged.push(...rec.merged);
    updated.push(...rec.updated);
    removed.push(...rec.removed);
  }

  // ---- Step 8: Instruction files (local-first) ----
  // weave 的托管块尽量落「本机文件」（CLAUDE.local.md / AGENTS.override.md，
  // 已登记 .git/info/exclude）：claude 追加语义恒走 local；codex 仅当根目录
  // 没有自己的 AGENTS.md 时才写 override（同目录 override 会压掉 AGENTS.md，
  // 见 HARNESS_LOCAL_INSTRUCTION_FILES 注释）。既有共享文件只收标记块，块外
  // 内容不动。存量链接（AGENTS.md -> CLAUDE.md）穿透写入维持现状。
  if (components.claudeMd || components.agentsMd) {
    const template = PRESET_TEMPLATE[preset] ?? 'standard';
    const instruction = await writeInstructionFiles(targetDir, {
      claude: components.claudeMd && selected.includes('claude'),
      codex: components.agentsMd && selected.includes('codex'),
      template,
      projectName: path.basename(targetDir),
    });
    created.files.push(...instruction.created);
    merged.push(...instruction.merged);
    for (const note of instruction.notes) logger.dim(note);
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
      // 采集/MCP 开关（含 --hooks/--mcp 覆盖结果）一并落档：daemon 的 init 文件
      // 漂移检测据此重建期望态，不再有第二份默认值可猜。
      hooks,
      mcp,
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

  // ---- Step 10.5: 本机私有指令文件（CLAUDE.local.md / AGENTS.override.md）与
  // .weave/token 登记 `.git/info/exclude`——先于提交询问，git status 才不把它们
  // 列进待提交清单（细节见 git-exclude.ts）----
  await ensureGitExcludes(targetDir);

  // ---- Step 10.6: git rerere 默认开（项目级配置、双 harness 共享）----
  await ensureRerereEnabled(targetDir);

  // ---- Step 11: 询问是否提交 init 生成物（嵌套 gitignore 已落盘，add 才能
  // 把 harness 目录裁剪到只剩 gitignore 文件本身）——细节与九闸见 git-commit.ts ----
  await commitInitOutputs({ targetDir, interactive, selected, prompt });

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
      hooks.stopFailure,
      hooks.subagentStop,
      hooks.subagentStart,
      hooks.notification,
      hooks.postToolUseFailure,
      hooks.permissionRequest,
      hooks.permissionDenied,
      hooks.preCompact,
      hooks.sessionEnd,
      hooks.preModelSwitch,
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
export const NESTED_GITIGNORE = `# weave — generated; do not commit
*
!.gitignore
`;

/**
 * Write a self-ignoring `.gitignore` into a weave-generated directory.
 *
 * The user's own root `.gitignore` is never touched (`.git/info/exclude` is not
 * used either — it is machine-local, so a teammate cloning the repo would not
 * inherit the rule). A file that already exists — the constant or a version the
 * user edited (e.g. a narrow `!plugins/` exception to track project plugin
 * sources) — is left alone: weave never clobbers a `.gitignore`. Idempotent; a
 * no-op outside a git repository, matching the previous behaviour for projects
 * weave is run in before `git init`.
 */
async function ensureNestedGitignore(
  targetDir: string,
  dir: string,
  created: { directories: string[]; files: string[] },
): Promise<void> {
  if (!(await findGitRepoRoot(targetDir))) return;

  const file = path.join(dir, '.gitignore');
  if ((await readTextIfPresent(file)) !== null) return;

  await ensureDir(dir);
  await writeFile(file, NESTED_GITIGNORE, 'utf-8');
  created.files.push(file);
}

/**
 * Enable `git rerere` in the project's repo config (design 6.5-1: rerere
 * remembers resolved conflict hunks and replays them — L1 mechanical layer).
 * Only for git repos (the temp .git check is conservative: a `.git` file as in
 * worktrees also counts since `git config` resolves it); idempotent — already
 * enabled means a no-op. Failures degrade to a dim note and never break init.
 */
export async function ensureRerereEnabled(targetDir: string): Promise<void> {
  const repoRoot = await findGitRepoRoot(targetDir);
  if (!repoRoot) return;

  try {
    const check = await defaultGitExec('git', ['config', '--local', 'rerere.enabled'], {
      cwd: repoRoot,
    });
    if (check.code === 0 && check.stdout.trim() === 'true') return;
    const res = await defaultGitExec('git', ['config', '--local', 'rerere.enabled', 'true'], {
      cwd: repoRoot,
    });
    if (res.code !== 0) throw new Error(res.stderr.trim() || 'git config failed');
    if (check.code !== 0) logger.dim(t('init.rerere.enabled'));
  } catch (err) {
    logger.warn(t('init.rerere.failed', { error: (err as Error).message }));
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
