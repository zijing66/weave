import path from 'node:path';
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import {
  type InitComponents,
  type HooksConfig,
  type SkillsConfig,
  type CommandsConfig,
  type AgentsConfig,
  type MCPConfig,
  type PlatformInfo,
  DEFAULT_AGENTS,
  DEFAULT_COMMANDS,
  DEFAULT_HOOKS,
  DEFAULT_MCP,
  DEFAULT_SKILLS,
  ensureDir,
  fileExists,
  logger,
  resolveComponents,
  writeFileIfAbsent,
} from '@weavecode/core';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — weave-templates is symlinked via pnpm workspaces
import { templateRegistry } from '@weavecode/templates';
import { generateStatuslineScript, readStatuslineConfig, WEAVE_VERSION } from '@weavecode/server';
import { InitPipeline, generateHookHandler, readUserCapture, type InitContext } from '@weavecode/harness';
import type { SurfaceRecords, SurfacePipeline } from '../types.js';
import { generateSettingsJson, mergeSettingsJson } from '../settings-gen.js';
import { generateMcpJson, mergeMcpJson } from '../mcp-gen.js';
import { generateAutoMemoryHook } from '../helpers-gen.js';
import { registerPluginTemplates, collectPluginMcpServers } from '../plugin-templates.js';
import { t } from '../../i18n/index.js';

/** Marks a generated helper script as weave's own (weave-特性文件可覆写). */
export const WEAVE_HELPER_MARKER = '@version weave@';

/** user 档采集接管时的 hooks 集：全 false 只为触发生成侧的「空即清光」语义。 */
const CAPTURE_TAKEN_OVER: HooksConfig = {
  preToolUse: false,
  postToolUse: false,
  userPromptSubmit: false,
  sessionStart: false,
  stop: false,
  stopFailure: false,
  subagentStop: false,
  subagentStart: false,
  notification: false,
  postToolUseFailure: false,
  permissionRequest: false,
  permissionDenied: false,
  preCompact: false,
  sessionEnd: false,
  preModelSwitch: false,
  timeout: 5000,
  continueOnError: true,
};

// 结果累加器与表面管线契约与 harness 无关，已上提到 init/types.ts；
// 此处 re-export 以保留既有 import 路径。
export type { SurfaceRecords, SurfacePipeline } from '../types.js';

/** Steps 1–7 的共享状态：解析后的选项、表面目录与结果累加器。 */
interface InitStepState {
  targetDir: string;
  force: boolean;
  platform: PlatformInfo;
  components: InitComponents;
  hooks: HooksConfig;
  skills: SkillsConfig;
  commands: CommandsConfig;
  agents: AgentsConfig;
  mcp: MCPConfig;
  claudeDir: string;
  skillsDir: string;
  commandsDir: string;
  agentsDir: string;
  helpersDir: string;
  created: { directories: string[]; files: string[] };
  skipped: string[];
  merged: string[];
  updated: string[];
  removed: string[];
}

/**
 * Claude init 模板：InitPipeline 的 8 个钩子覆写，Step1–7 原代码（原 executor
 * 内联体）按序落位；Step8–11 为中立步，留在 executor（InitOrchestrator）。
 */
export class ClaudeInitTemplate extends InitPipeline implements SurfacePipeline {
  readonly records: SurfaceRecords = {
    created: { directories: [], files: [] },
    skipped: [],
    merged: [],
    updated: [],
    removed: [],
  };
  private readonly st: InitStepState;

  constructor(ctx: InitContext) {
    super(ctx);
    const claudeDir = path.join(ctx.targetDir, '.claude');
    this.st = {
      targetDir: ctx.targetDir,
      force: ctx.force,
      platform: ctx.platform,
      components: resolveComponents(ctx.preset, ctx.components),
      hooks: { ...DEFAULT_HOOKS, ...ctx.hooks },
      skills: { ...DEFAULT_SKILLS, ...ctx.skills },
      commands: { ...DEFAULT_COMMANDS, ...ctx.commands },
      agents: { ...DEFAULT_AGENTS, ...ctx.agents },
      mcp: { ...DEFAULT_MCP, ...ctx.mcp },
      claudeDir,
      skillsDir: path.join(claudeDir, 'skills'),
      commandsDir: path.join(claudeDir, 'commands'),
      agentsDir: path.join(claudeDir, 'agents'),
      helpersDir: path.join(claudeDir, 'helpers'),
      ...this.records,
    };
  }

  protected ensureDirs(): Promise<void> {
    return ensureDirs(this.st);
  }

  protected writeSettings(): Promise<void> {
    return writeSettings(this.st);
  }

  protected writeMcp(): Promise<void> {
    return writeMcp(this.st);
  }

  protected copySkills(): Promise<void> {
    return copySkills(this.st);
  }

  protected copyCommands(): Promise<void> {
    return copyCommands(this.st);
  }

  protected copyAgents(): Promise<void> {
    return copyAgents(this.st);
  }

  protected override injectPluginTemplates(): Promise<void> {
    return injectPluginTemplates(this.st);
  }

  protected writeHelpers(): Promise<void> {
    return writeHelpers(this.st);
  }
}

// ---- Step 1–7 步进函数（原 executor 内联代码平移，行为逐行等价）----

async function ensureDirs(st: InitStepState): Promise<void> {
  // ---- Step 1: Create directory structure ----
  await ensureDir(st.claudeDir);
  st.created.directories.push(st.claudeDir);

  if (st.components.skills) {
    await ensureDir(st.skillsDir);
    st.created.directories.push(st.skillsDir);
  }
  if (st.components.commands) {
    await ensureDir(st.commandsDir);
    st.created.directories.push(st.commandsDir);
  }
  if (st.components.agents) {
    await ensureDir(st.agentsDir);
    st.created.directories.push(st.agentsDir);
  }
  if (st.components.helpers) {
    await ensureDir(st.helpersDir);
    st.created.directories.push(st.helpersDir);
  }
}

async function writeSettings(st: InitStepState): Promise<void> {
  // ---- Step 2: Generate settings.json ----
  // User file: never overwritten without --force. Existing files are merged —
  // weave appends its entries and refreshes its own keys; user content is kept.
  if (st.components.settings) {
    // user 档采集接管时不再落项目档 hooks（同一事件 user+project 双注册 =
    // 双采集）；仍传全 false 生成：merge 靠「hooks 键存在」把项目里的旧
    // weave 组整体清掉（空即清光）。
    const userCapture = await readUserCapture({ home: st.platform.homeDir });
    const hooks = userCapture.installed ? CAPTURE_TAKEN_OVER : st.hooks;
    if (userCapture.installed) logger.dim(t('init.userCaptureActive'));

    const generated = generateSettingsJson({
      components: st.components,
      hooks,
      platform: st.platform,
      helpersDir: st.helpersDir,
    });
    const settingsPath = path.join(st.claudeDir, 'settings.json');

    if (st.force) {
      await writeFile(settingsPath, JSON.stringify(generated, null, 2) + '\n', 'utf-8');
      st.created.files.push(settingsPath);
    } else {
      const existing = await readJsonObject(settingsPath);
      if (existing === undefined) {
        if (await fileExists(settingsPath)) {
          // Present but not a parseable object — never touch what we cannot merge into
          st.skipped.push(settingsPath);
          logger.warn(t('init.skippedInvalidJson', { path: settingsPath }));
        } else {
          await writeFile(settingsPath, JSON.stringify(generated, null, 2) + '\n', 'utf-8');
          st.created.files.push(settingsPath);
        }
      } else {
        const mergedSettings = mergeSettingsJson(existing, generated);
        await writeFile(settingsPath, JSON.stringify(mergedSettings, null, 2) + '\n', 'utf-8');
        st.merged.push(settingsPath);
      }
    }
  }
}

async function writeMcp(st: InitStepState): Promise<void> {
  // ---- Step 3: Generate .mcp.json ----
  if (st.components.mcp) {
    const mcpJson = generateMcpJson({ platform: st.platform, includeWeaveServer: st.mcp.weave });
    // 扩展点④：插件 manifest.mcpServers 合并（与核心/插件间同名 → namespace 化）
    const coreServers = Object.keys((mcpJson as { mcpServers: Record<string, unknown> }).mcpServers);
    const pluginMcp = await collectPluginMcpServers(st.targetDir, undefined, coreServers);
    const servers = (mcpJson as { mcpServers: Record<string, unknown> }).mcpServers;
    for (const [name, config] of Object.entries(pluginMcp.servers)) servers[name] = config;
    for (const r of pluginMcp.renamed) logger.warn(t('init.pluginMcpRenamed', { renamed: r }));
    const serverCount = Object.keys(servers).length;

    // Only write .mcp.json when there's at least one server configured.
    // P0-1: the CLI has no `weave mcp start` command yet, so `mcp.weave` defaults
    // to false — emitting a file that points at a non-existent command would break
    // Claude Code's MCP loader.
    if (serverCount > 0) {
      const mcpPath = path.join(st.targetDir, '.mcp.json');

      if (st.force) {
        await writeFile(mcpPath, JSON.stringify(mcpJson, null, 2) + '\n', 'utf-8');
        st.created.files.push(mcpPath);
      } else {
        const existing = await readJsonObject(mcpPath);
        if (existing === undefined) {
          if (await fileExists(mcpPath)) {
            st.skipped.push(mcpPath);
            logger.warn(t('init.skippedInvalidJson', { path: mcpPath }));
          } else {
            await writeFile(mcpPath, JSON.stringify(mcpJson, null, 2) + '\n', 'utf-8');
            st.created.files.push(mcpPath);
          }
        } else {
          const mergedMcp = mergeMcpJson(existing, mcpJson as Record<string, unknown>);
          await writeFile(mcpPath, JSON.stringify(mergedMcp, null, 2) + '\n', 'utf-8');
          st.merged.push(mcpPath);
        }
      }
    } else {
      // 无可写 server → 不生成 .mcp.json；仅当文件已存在才计入「跳过已有文件」，
      // 否则不存在的文件会被误报为「已有文件 + 使用 --force 覆盖」（force 也救不了）。
      if (await fileExists(path.join(st.targetDir, '.mcp.json'))) {
        st.skipped.push(path.join(st.targetDir, '.mcp.json'));
      }
    }
  }
}

async function copySkills(st: InitStepState): Promise<void> {
  // ---- Step 4: Copy skills ----
  if (st.components.skills && st.skills.core) {
    const srcDir = templateRegistry.getSkillsSourceDir();
    await copyTemplateDir(srcDir, st.skillsDir, st.force, st.created, st.skipped);
  }
}

async function copyCommands(st: InitStepState): Promise<void> {
  // ---- Step 5: Copy commands ----
  if (st.components.commands && st.commands.core) {
    const srcDir = templateRegistry.getCommandsSourceDir();
    await copyTemplateDir(srcDir, st.commandsDir, st.force, st.created, st.skipped);
  }
}

async function copyAgents(st: InitStepState): Promise<void> {
  // ---- Step 6: Copy agents ----
  if (st.components.agents && st.agents.core) {
    const srcDir = templateRegistry.getAgentsSourceDir();
    await copyTemplateDir(srcDir, st.agentsDir, st.force, st.created, st.skipped);
  }
}

/** Step 6b（virtual 覆写点）：插件模板注入（扩展点③）。 */
async function injectPluginTemplates(st: InitStepState): Promise<void> {
  // ---- Step 6b: 插件模板注入（扩展点③）----
  // 扫描插件根目录 manifest.templates 并复制（name 冲突内置优先；与核心模板
  // 同用 writeFileIfAbsent 的 force/skipped 语义）。组件开关只管核心模板——
  // 插件模板是插件自己的交付物，被识别即 opt-in，不受 components 门控。
  try {
    const { registered: pluginTemplates } = await registerPluginTemplates(st.targetDir);
    for (const entry of pluginTemplates) {
      const src = templateRegistry.resolvePath(entry);
      if (entry.category === 'skill') {
        await copyTemplateDir(
          src,
          path.join(st.skillsDir, path.basename(src)),
          st.force,
          st.created,
          st.skipped,
        );
        continue;
      }
      const destDir = entry.category === 'command' ? st.commandsDir : st.agentsDir;
      const destFile = path.join(destDir, path.basename(src));
      try {
        const content = await readFile(src, 'utf-8');
        if (await writeFileIfAbsent(destFile, content, st.force)) st.created.files.push(destFile);
        else st.skipped.push(destFile);
      } catch (err) {
        logger.warn(t('init.copyTemplatesFailed', { srcDir: src, error: String(err) }));
      }
    }
  } catch (err) {
    logger.warn(t('init.copyTemplatesFailed', { srcDir: 'plugins', error: String(err) }));
  }
}

async function writeHelpers(st: InitStepState): Promise<void> {
  // ---- Step 7: Generate helpers ----
  // Helper scripts are weave-generated ("do not edit manually"). Files carrying
  // the weave version marker are weave's own and refreshed in place; a file at
  // the same path WITHOUT the marker is user-authored and left untouched.
  if (st.components.helpers) {
    // The statusline is generated from the project's effective config rather
    // than a placeholder, so `weave init` alone produces a working statusline.
    // (`readStatuslineConfig` resolves the project's `.weave/statusline.json`,
    // falling back to the global template.)
    const statuslineConfig = await readStatuslineConfig(st.targetDir);
    const helperFiles: [string, string][] = [
      ['hook-handler.cjs', generateHookHandler(WEAVE_VERSION)],
      ['statusline.cjs', generateStatuslineScript(statuslineConfig)],
      ['auto-memory-hook.mjs', generateAutoMemoryHook()],
    ];

    for (const [filename, content] of helperFiles) {
      const filePath = path.join(st.helpersDir, filename);
      if (st.force) {
        await writeFile(filePath, content, 'utf-8');
        st.created.files.push(filePath);
        continue;
      }

      const existing = await readTextIfPresent(filePath);
      if (existing === null) {
        await writeFile(filePath, content, 'utf-8');
        st.created.files.push(filePath);
      } else if (existing.includes(WEAVE_HELPER_MARKER)) {
        await writeFile(filePath, content, 'utf-8');
        st.updated.push(filePath);
      } else {
        st.skipped.push(filePath);
      }
    }

    // 标记清扫：helpers 目录里「内容带 weave 版本戳但不在本次生成清单」的文件
    // 是旧版/改名遗留的生成物——按标记识别后移除；无标记的用户文件永不碰。
    const keep = new Set(helperFiles.map(([filename]) => filename));
    try {
      for (const entry of await readdir(st.helpersDir, { withFileTypes: true })) {
        if (!entry.isFile() || keep.has(entry.name)) continue;
        const legacyPath = path.join(st.helpersDir, entry.name);
        const content = await readTextIfPresent(legacyPath);
        if (content !== null && content.includes(WEAVE_HELPER_MARKER)) {
          await unlink(legacyPath);
          st.removed.push(legacyPath);
        }
      }
    } catch {
      // helpers 目录读取失败（不存在/权限）不阻断 init
    }
  }
}

// ---- 文件工具（原 executor 私有函数平移；executor 侧另持同构小工具）----

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
