import path from 'node:path';
import { readFile, writeFile, stat } from 'node:fs/promises';
import {
  type InitOptions,
  type InitResult,
  type PlatformInfo,
  detectPlatform,
  resolveComponents,
  DEFAULT_HOOKS,
  DEFAULT_SKILLS,
  DEFAULT_COMMANDS,
  DEFAULT_AGENTS,
  DEFAULT_MCP,
  ensureDir,
  writeFileIfAbsent,
  fileExists,
  logger,
} from '@weave/core';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — weave-templates is symlinked via pnpm workspaces
import { templateRegistry } from '@weave/templates';
import { WEAVE_VERSION, generateStatuslineScript, readStatuslineConfig } from '@weave/server';
import { generateSettingsJson, mergeSettingsJson } from './settings-gen.js';
import { generateMcpJson, mergeMcpJson } from './mcp-gen.js';
import {
  generateClaudeMd,
  generateClaudeMdSection,
  mergeClaudeMd,
  type ClaudeMdTemplate,
} from './claudemd-gen.js';
import { ensureInstructionLink } from './instruction-link.js';
import { generateHookHandler, generateAutoMemoryHook } from './helpers-gen.js';
import { t } from '../i18n/index.js';

/** Map preset → CLAUDE.md template */
const PRESET_TEMPLATE: Record<string, ClaudeMdTemplate> = {
  minimal: 'minimal',
  default: 'standard',
  full: 'full',
};

/** Marks a generated helper script as weave's own (weave-特性文件可覆写). */
const WEAVE_HELPER_MARKER = '@version weave@';

export async function executeInit(options: InitOptions): Promise<InitResult> {
  const { targetDir, force, interactive, preset } = options;
  const platform: PlatformInfo = detectPlatform();
  const created: { directories: string[]; files: string[] } = { directories: [], files: [] };
  const skipped: string[] = [];
  const merged: string[] = [];
  const updated: string[] = [];
  const errors: string[] = [];

  const components = resolveComponents(preset, options.components);
  const hooks = { ...DEFAULT_HOOKS, ...options.hooks };
  const skills = { ...DEFAULT_SKILLS, ...options.skills };
  const commands = { ...DEFAULT_COMMANDS, ...options.commands };
  const agents = { ...DEFAULT_AGENTS, ...options.agents };
  const mcp = { ...DEFAULT_MCP, ...options.mcp };

  const claudeDir = path.join(targetDir, '.claude');
  const skillsDir = path.join(claudeDir, 'skills');
  const commandsDir = path.join(claudeDir, 'commands');
  const agentsDir = path.join(claudeDir, 'agents');
  const helpersDir = path.join(claudeDir, 'helpers');

  if (!interactive) {
    logger.dim(t('init.nonInteractive'));
  }

  // ---- Step 1: Create directory structure ----
  await ensureDir(claudeDir);
  created.directories.push(claudeDir);

  if (components.skills) {
    await ensureDir(skillsDir);
    created.directories.push(skillsDir);
  }
  if (components.commands) {
    await ensureDir(commandsDir);
    created.directories.push(commandsDir);
  }
  if (components.agents) {
    await ensureDir(agentsDir);
    created.directories.push(agentsDir);
  }
  if (components.helpers) {
    await ensureDir(helpersDir);
    created.directories.push(helpersDir);
  }

  // ---- Step 2: Generate settings.json ----
  // User file: never overwritten without --force. Existing files are merged —
  // weave appends its entries and refreshes its own keys; user content is kept.
  if (components.settings) {
    const generated = generateSettingsJson({ components, hooks, platform, helpersDir });
    const settingsPath = path.join(claudeDir, 'settings.json');

    if (force) {
      await writeFile(settingsPath, JSON.stringify(generated, null, 2) + '\n', 'utf-8');
      created.files.push(settingsPath);
    } else {
      const existing = await readJsonObject(settingsPath);
      if (existing === undefined) {
        if (await fileExists(settingsPath)) {
          // Present but not a parseable object — never touch what we cannot merge into
          skipped.push(settingsPath);
          logger.warn(t('init.skippedInvalidJson', { path: settingsPath }));
        } else {
          await writeFile(settingsPath, JSON.stringify(generated, null, 2) + '\n', 'utf-8');
          created.files.push(settingsPath);
        }
      } else {
        const mergedSettings = mergeSettingsJson(existing, generated);
        await writeFile(settingsPath, JSON.stringify(mergedSettings, null, 2) + '\n', 'utf-8');
        merged.push(settingsPath);
      }
    }
  }

  // ---- Step 3: Generate .mcp.json ----
  if (components.mcp) {
    const mcpJson = generateMcpJson({ platform, includeWeaveServer: mcp.weave });
    const serverCount = Object.keys((mcpJson as { mcpServers: Record<string, unknown> }).mcpServers ?? {}).length;

    // Only write .mcp.json when there's at least one server configured.
    // P0-1: the CLI has no `weave mcp start` command yet, so `mcp.weave` defaults
    // to false — emitting a file that points at a non-existent command would break
    // Claude Code's MCP loader.
    if (serverCount > 0) {
      const mcpPath = path.join(targetDir, '.mcp.json');

      if (force) {
        await writeFile(mcpPath, JSON.stringify(mcpJson, null, 2) + '\n', 'utf-8');
        created.files.push(mcpPath);
      } else {
        const existing = await readJsonObject(mcpPath);
        if (existing === undefined) {
          if (await fileExists(mcpPath)) {
            skipped.push(mcpPath);
            logger.warn(t('init.skippedInvalidJson', { path: mcpPath }));
          } else {
            await writeFile(mcpPath, JSON.stringify(mcpJson, null, 2) + '\n', 'utf-8');
            created.files.push(mcpPath);
          }
        } else {
          const mergedMcp = mergeMcpJson(existing, mcpJson as Record<string, unknown>);
          await writeFile(mcpPath, JSON.stringify(mergedMcp, null, 2) + '\n', 'utf-8');
          merged.push(mcpPath);
        }
      }
    } else {
      skipped.push(path.join(targetDir, '.mcp.json'));
    }
  }

  // ---- Step 4: Copy skills ----
  if (components.skills && skills.core) {
    const srcDir = templateRegistry.getSkillsSourceDir();
    await copyTemplateDir(srcDir, skillsDir, force, created, skipped);
  }

  // ---- Step 5: Copy commands ----
  if (components.commands && commands.core) {
    const srcDir = templateRegistry.getCommandsSourceDir();
    await copyTemplateDir(srcDir, commandsDir, force, created, skipped);
  }

  // ---- Step 6: Copy agents ----
  if (components.agents && agents.core) {
    const srcDir = templateRegistry.getAgentsSourceDir();
    await copyTemplateDir(srcDir, agentsDir, force, created, skipped);
  }

  // ---- Step 7: Generate helpers ----
  // Helper scripts are weave-generated ("do not edit manually"). Files carrying
  // the weave version marker are weave's own and refreshed in place; a file at
  // the same path WITHOUT the marker is user-authored and left untouched.
  if (components.helpers) {
    // The statusline is generated from the project's effective config rather
    // than a placeholder, so `weave init` alone produces a working statusline.
    // (`readStatuslineConfig` resolves the project's `.weave/statusline.json`,
    // falling back to the global template.)
    const statuslineConfig = await readStatuslineConfig(targetDir);
    const helperFiles: [string, string][] = [
      ['hook-handler.cjs', generateHookHandler()],
      ['statusline.cjs', generateStatuslineScript(statuslineConfig)],
      ['auto-memory-hook.mjs', generateAutoMemoryHook()],
    ];

    for (const [filename, content] of helperFiles) {
      const filePath = path.join(helpersDir, filename);
      if (force) {
        await writeFile(filePath, content, 'utf-8');
        created.files.push(filePath);
        continue;
      }

      const existing = await readTextIfPresent(filePath);
      if (existing === null) {
        await writeFile(filePath, content, 'utf-8');
        created.files.push(filePath);
      } else if (existing.includes(WEAVE_HELPER_MARKER)) {
        await writeFile(filePath, content, 'utf-8');
        updated.push(filePath);
      } else {
        skipped.push(filePath);
      }
    }
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
      confirm: (question, detail) => confirmPrompt(question, detail, interactive),
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
  // Both `.claude/` and `.weave/` hold machine-local, regenerable content (a
  // statusline script embedding this machine's absolute paths, init metadata).
  // Each gets a self-ignoring `.gitignore` rather than an entry in the user's
  // root `.gitignore`: the nested file is itself committed, so a teammate who
  // clones inherits the rule without weave ever editing a file the user owns.
  await ensureNestedGitignore(targetDir, claudeDir, created);
  await ensureNestedGitignore(targetDir, path.join(targetDir, '.weave'), created);

  // ---- Aggregate summary ----
  const summary = {
    skillsCount: templateRegistry.getByCategory('skill').length,
    commandsCount: templateRegistry.getByCategory('command').length,
    agentsCount: templateRegistry.getByCategory('agent').length,
    hooksEnabled: [hooks.preToolUse, hooks.postToolUse, hooks.userPromptSubmit, hooks.sessionStart]
      .filter(Boolean).length,
  };

  return {
    success: errors.length === 0,
    platform,
    created,
    skipped,
    merged,
    updated,
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
 * Ask a yes/no question, defaulting to yes.
 *
 * Returns the default without prompting when the run is non-interactive or
 * stdin is not a terminal — `weave init` must stay scriptable, and the default
 * action is always the one the user asked for (replace AGENTS.md with a link).
 */
async function confirmPrompt(question: string, detail: string, interactive: boolean): Promise<boolean> {
  if (!interactive || !process.stdin.isTTY || !process.stdout.isTTY) return true;

  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `\n  ${question}\n  ${detail}\n  ${t('init.proceed')} `,
    );
    return !/^n(o)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
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

/**
 * Read and parse a JSON object file. Returns the object, or undefined when the
 * file is absent, unparseable, or not a JSON object — callers distinguish
 * "absent" (create fresh) from "present but unusable" (skip, never clobber).
 */
async function readJsonObject(filePath: string): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if (isMissingFileError(err)) return undefined;
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // unparseable — caller decides
  }
  return undefined;
}

function isMissingFileError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Copy template files from a source directory into a target directory.
 * Each file is copied individually so existing targets are respected:
 * without `force`, files already present in the target are skipped (P0-2).
 */
async function copyTemplateDir(
  srcDir: string,
  destDir: string,
  force: boolean,
  created: { directories: string[]; files: string[] },
  skipped: string[],
): Promise<void> {
  try {
    const files = await walkDir(srcDir);
    for (const srcFile of files) {
      const rel = path.relative(srcDir, srcFile);
      const destFile = path.join(destDir, rel);
      const content = await readFile(srcFile, 'utf-8');
      const wrote = await writeFileIfAbsent(destFile, content, force);
      if (wrote) {
        created.files.push(destFile);
      } else {
        skipped.push(destFile);
      }
    }
  } catch (err) {
    logger.warn(t('init.copyTemplatesFailed', { srcDir, error: String(err) }));
  }
}

async function walkDir(dir: string): Promise<string[]> {
  const result: string[] = [];
  try {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        result.push(...(await walkDir(full)));
      } else {
        result.push(full);
      }
    }
  } catch {
    // dir might not exist
  }
  return result;
}
