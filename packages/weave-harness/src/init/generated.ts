import path from 'node:path';
import type {
  Harness,
  HooksConfig,
  InitComponents,
  MCPConfig,
  PlatformInfo,
} from '@weavecode/core';
import { generateHookHandler, readUserCapture } from '../claude/capture.js';
import { generateAutoMemoryHook } from '../claude/helpers-gen.js';
import { generateMcpJson, mergeMcpJson } from '../claude/mcp-gen.js';
import { generateSettingsJson, mergeSettingsJson } from '../claude/settings-gen.js';

/** weave 特性文件的覆写判据：内容带它 = weave 自己的生成物，可覆写刷新。 */
export const WEAVE_CONTENT_MARKER = '@version weave@';

/**
 * init 生成物的期望态。**落点（`relPath`）与内容都是 harness 知识**——server 只
 * 比对与落盘，不自拼路径、不自造内容。
 */
export interface InitGeneratedFile {
  /** 项目根相对路径（posix 分隔）。 */
  relPath: string;
  /**
   * 整文件类的覆写判据：盘上内容含它 = weave 生成物，可整文件刷新；不含 =
   * 用户手写的同名文件，永不碰。缺省 = merge 类（见 `merge`）。
   */
  weaveMarker?: string;
  /** weave 自有内容：整文件类的全文，或 merge 类要并进用户文件的片段。 */
  content: string;
  /**
   * merge 类：把 `content` 并进盘上原文，返回应写回的全文；null = 盘上不可
   * 合并（JSON 坏了之类）→ 保持不动。缺省 = 整文件覆盖。
   */
  merge?(onDisk: string, content: string): string | null;
}

/** 生成期望态所需的项目上下文（与 init 落盘同一套输入）。 */
export interface InitFileContext {
  projectPath: string;
  version: string;
  platform: PlatformInfo;
  components: InitComponents;
  hooks: HooksConfig;
  mcp: MCPConfig;
}

/** user 档采集接管时的 hooks 集：全 false 只为触发生成侧的「空即清光」语义。 */
const CAPTURE_TAKEN_OVER: HooksConfig = {
  preToolUse: false,
  postToolUse: false,
  userPromptSubmit: false,
  sessionStart: false,
  stop: false,
  subagentStop: false,
  notification: false,
  preCompact: false,
  sessionEnd: false,
  preModelSwitch: false,
  timeout: 5000,
  continueOnError: true,
};

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function serializeJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2) + '\n';
}

function mergeJsonEntry(
  merge: (existing: Record<string, unknown>, generated: Record<string, unknown>) => Record<string, unknown>,
): (onDisk: string, content: string) => string | null {
  return (onDisk, content) => {
    const existing = parseJsonObject(onDisk);
    const generated = parseJsonObject(content);
    if (existing === null || generated === null) return null;
    return serializeJson(merge(existing, generated));
  };
}

async function claudeInitFiles(ctx: InitFileContext): Promise<InitGeneratedFile[]> {
  const helpersDir = path.join(ctx.projectPath, '.claude', 'helpers');
  const userCapture = await readUserCapture({ home: ctx.platform.homeDir });
  const hooks = userCapture.installed ? CAPTURE_TAKEN_OVER : ctx.hooks;

  const out: InitGeneratedFile[] = [];

  if (ctx.components.helpers) {
    out.push(
      {
        relPath: '.claude/helpers/hook-handler.cjs',
        weaveMarker: WEAVE_CONTENT_MARKER,
        content: generateHookHandler(ctx.version),
      },
      {
        relPath: '.claude/helpers/auto-memory-hook.mjs',
        weaveMarker: WEAVE_CONTENT_MARKER,
        content: generateAutoMemoryHook(ctx.version),
      },
    );
  }

  if (ctx.components.settings) {
    out.push({
      relPath: '.claude/settings.json',
      content: serializeJson(
        generateSettingsJson({
          components: ctx.components,
          hooks,
          platform: ctx.platform,
          helpersDir,
        }),
      ),
      merge: mergeJsonEntry(mergeSettingsJson),
    });
  }

  // init 只在至少有一个 server 时才落 .mcp.json（weave server 默认关）——
  // 同一口径：没得写就不入清单，免得自动同步凭空造出文件。
  if (ctx.components.mcp && ctx.mcp.weave) {
    out.push({
      relPath: '.mcp.json',
      content: serializeJson(
        generateMcpJson({ platform: ctx.platform, includeWeaveServer: true }),
      ),
      merge: mergeJsonEntry(mergeMcpJson),
    });
  }

  return out;
}

/** 每个 harness 的 init 生成物清单——**加 harness = 这里加一行**。 */
const HARNESS_INIT_FILES: Record<Harness, (ctx: InitFileContext) => Promise<InitGeneratedFile[]>> = {
  claude: claudeInitFiles,
  // codex 的 init 只物化模板（writeFileIfAbsent），没有可漂移的生成文件。
  codex: async () => [],
};

/**
 * 取某 harness 在该项目下的 init 生成物期望态。daemon 的 init 文件漂移检测与
 * 自动同步走这里——与 `weave init` 落盘同一套生成器，不存在第二份期望态。
 */
export function generateInitFiles(
  harness: Harness,
  ctx: InitFileContext,
): Promise<InitGeneratedFile[]> {
  return HARNESS_INIT_FILES[harness](ctx);
}
