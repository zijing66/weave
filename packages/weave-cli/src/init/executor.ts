import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
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
  logger,
} from '@weave/core';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — weave-templates is symlinked via pnpm workspaces
import { templateRegistry } from '@weave/templates';
import { generateSettingsJson } from './settings-gen.js';
import { generateMcpJson } from './mcp-gen.js';
import { generateClaudeMd, type ClaudeMdTemplate } from './claudemd-gen.js';
import { generateHookHandler, generateStatusline, generateAutoMemoryHook } from './helpers-gen.js';

/** Map preset → CLAUDE.md template */
const PRESET_TEMPLATE: Record<string, ClaudeMdTemplate> = {
  minimal: 'minimal',
  default: 'standard',
  full: 'full',
};

export async function executeInit(options: InitOptions): Promise<InitResult> {
  const { targetDir, force, interactive, preset } = options;
  const platform: PlatformInfo = detectPlatform();
  const created: { directories: string[]; files: string[] } = { directories: [], files: [] };
  const skipped: string[] = [];
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
  if (components.settings) {
    const settingsContent = JSON.stringify(
      generateSettingsJson({ components, hooks, platform, helpersDir }),
      null,
      2,
    ) + '\n';

    const settingsPath = path.join(claudeDir, 'settings.json');
    const wrote = await writeFileIfAbsent(settingsPath, settingsContent, force);
    if (wrote) {
      created.files.push(settingsPath);
    } else {
      skipped.push(settingsPath);
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
      const mcpContent = JSON.stringify(mcpJson, null, 2) + '\n';
      const mcpPath = path.join(targetDir, '.mcp.json');
      const wrote = await writeFileIfAbsent(mcpPath, mcpContent, force);
      if (wrote) {
        created.files.push(mcpPath);
      } else {
        skipped.push(mcpPath);
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
  if (components.helpers) {
    const helperFiles: [string, string][] = [
      ['hook-handler.cjs', generateHookHandler()],
      ['statusline.cjs', generateStatusline()],
      ['auto-memory-hook.mjs', generateAutoMemoryHook()],
    ];

    for (const [filename, content] of helperFiles) {
      const filePath = path.join(helpersDir, filename);
      const wrote = await writeFileIfAbsent(filePath, content, force);
      if (wrote) {
        created.files.push(filePath);
      } else {
        skipped.push(filePath);
      }
    }
  }

  // ---- Step 8: Generate CLAUDE.md ----
  if (components.claudeMd) {
    const template = PRESET_TEMPLATE[preset] ?? 'standard';
    const projectName = path.basename(targetDir);
    const content = generateClaudeMd({ template, projectName });

    const claudeMdPath = path.join(targetDir, 'CLAUDE.md');
    const wrote = await writeFileIfAbsent(claudeMdPath, content, force);
    if (wrote) {
      created.files.push(claudeMdPath);
    } else {
      skipped.push(claudeMdPath);
    }
  }

  // ---- Step 9: Write runtime config ----
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

    const wrote = await writeFileIfAbsent(configPath, yamlContent, force);
    if (wrote) {
      created.files.push(configPath);
    } else {
      skipped.push(configPath);
    }
  }

  // ---- Step 10: Ensure .gitignore excludes .weave/ ----
  // .weave/config.yaml is per-machine init metadata (timestamp, preset, etc.),
  // not team-shared source — mirroring ruflo, which ignores .claude-flow/.
  await ensureGitIgnore(targetDir, created, skipped);

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
    errors,
    summary,
  };
}

/**
 * Ensure the target project's `.gitignore` excludes `.weave/` (runtime state).
 * Creates the file when missing; appends the entry when present. Unlike
 * `writeFileIfAbsent`, this is an idempotent "ensure contained" operation that
 * does not skip an existing `.gitignore` without `--force`.
 */
async function ensureGitIgnore(
  targetDir: string,
  created: { directories: string[]; files: string[] },
  skipped: string[],
): Promise<void> {
  const gitignorePath = path.join(targetDir, '.gitignore');
  let existing = '';
  try {
    existing = await readFile(gitignorePath, 'utf-8');
  } catch {
    // .gitignore does not exist yet — will be created below
  }

  const hasEntry = existing
    .split(/\r?\n/)
    .some((line) => {
      const t = line.trim();
      return t === '.weave' || t === '.weave/';
    });

  if (hasEntry) {
    skipped.push(gitignorePath);
    return;
  }

  const block = `# weave harness runtime state\n.weave/\n`;
  const content = existing
    ? existing.replace(/\s+$/, '') + `\n${block}`
    : block;

  await writeFile(gitignorePath, content, 'utf-8');
  created.files.push(gitignorePath);
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
