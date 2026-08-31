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
import { generateSettingsJson, mergeSettingsJson } from './settings-gen.js';
import { generateMcpJson, mergeMcpJson } from './mcp-gen.js';
import {
  generateClaudeMd,
  generateClaudeMdSection,
  mergeClaudeMd,
  type ClaudeMdTemplate,
} from './claudemd-gen.js';
import { generateHookHandler, generateStatusline, generateAutoMemoryHook } from './helpers-gen.js';

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
    logger.dim('Running in non-interactive mode');
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
          logger.warn(`Skipped ${settingsPath}: not valid JSON. Fix or remove it, or use --force.`);
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
            logger.warn(`Skipped ${mcpPath}: not valid JSON. Fix or remove it, or use --force.`);
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
    const helperFiles: [string, string][] = [
      ['hook-handler.cjs', generateHookHandler()],
      ['statusline.cjs', generateStatusline()],
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

  // ---- Step 8: Generate CLAUDE.md ----
  // User file: a fresh one is generated whole; an existing one only ever
  // receives weave's delimited block (appended, or replaced when already
  // present). Content outside the markers is never touched.
  if (components.claudeMd) {
    const template = PRESET_TEMPLATE[preset] ?? 'standard';
    const projectName = path.basename(targetDir);
    const claudeMdPath = path.join(targetDir, 'CLAUDE.md');

    if (force) {
      await writeFile(claudeMdPath, generateClaudeMd({ template, projectName }), 'utf-8');
      created.files.push(claudeMdPath);
    } else {
      const existing = await readTextIfPresent(claudeMdPath);
      if (existing === null) {
        await writeFile(claudeMdPath, generateClaudeMd({ template, projectName }), 'utf-8');
        created.files.push(claudeMdPath);
      } else {
        const section = generateClaudeMdSection({ template, projectName });
        await writeFile(claudeMdPath, mergeClaudeMd(existing, section), 'utf-8');
        merged.push(claudeMdPath);
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
      initVersion: '0.1.0',
      initTimestamp: new Date().toISOString(),
      preset,
      components: { settings: components.settings, skills: components.skills, commands: components.commands, agents: components.agents, helpers: components.helpers, mcp: components.mcp, claudeMd: components.claudeMd },
    };

    const configPath = path.join(weaveDir, 'config.yaml');
    const yamlContent = Object.entries(runtimeConfig)
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join('\n') + '\n';

    const existed = await fileExists(configPath);
    await writeFile(configPath, yamlContent, 'utf-8');
    (existed ? updated : created.files).push(configPath);
  }

  // ---- Step 10: Ensure .weave/ is git-ignored via .git/info/exclude ----
  // .weave/config.yaml is per-machine init metadata (timestamp, preset, etc.),
  // not team-shared source. The ignore entry goes into .git/info/exclude — a
  // machine-local git file — so init never touches the user's .gitignore.
  await ensureGitExclude(targetDir, created);

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
 * Ensure `.weave/` (runtime state) is git-ignored by writing `.git/info/exclude`
 * in the repository containing `targetDir`. Never touches the user's
 * `.gitignore`. Idempotent; a no-op outside a git repository.
 */
async function ensureGitExclude(
  targetDir: string,
  created: { directories: string[]; files: string[] },
): Promise<void> {
  const repoRoot = await findGitRepoRoot(targetDir);
  if (!repoRoot) return;

  const excludePath = path.join(repoRoot, '.git', 'info', 'exclude');
  let existing = '';
  try {
    existing = await readFile(excludePath, 'utf-8');
  } catch {
    // exclude file does not exist yet — created below
  }

  const hasEntry = existing
    .split(/\r?\n/)
    .some((line) => {
      const t = line.trim();
      return t === '.weave' || t === '.weave/';
    });
  if (hasEntry) return;

  const content = existing
    ? existing.replace(/\s+$/, '') + '\n.weave/\n'
    : '.weave/\n';

  await ensureDir(path.dirname(excludePath));
  await writeFile(excludePath, content, 'utf-8');
  created.files.push(excludePath);
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
    logger.warn(`Could not copy templates from ${srcDir}: ${String(err)}`);
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
