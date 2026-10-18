import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_HOOKS,
  DEFAULT_MCP,
  HARNESS_KEYS,
  detectPlatform,
  isHarness,
  resolveComponents,
  type Harness,
  type HooksConfig,
  type InitComponents,
  type MCPConfig,
  type PlatformInfo,
  type Preset,
} from '@weavecode/core';
import {
  WEAVE_CONTENT_MARKER,
  generateInitFiles,
  type InitFileContext,
  type InitGeneratedFile,
} from '@weavecode/harness';
import { gitClassify, type SyncClass } from './git-classify.js';
import { generateStatuslineScript } from '../statusline/generator.js';
import { readStatuslineConfig, statuslineScriptRelPath } from '../statusline/manager.js';
import { WEAVE_VERSION } from '../version.js';

/**
 * init 生成物的漂移检测与自动落盘——`weave init` 写过的文件里，**不进 git 的**
 * 由同步域自动刷新（自愈），**会进 git 的**只报不写、dashboard 提醒用户去终端
 * 跑 `weave init`（保留「生成 + commit」流程）。
 *
 * 期望态不在此处拼：落点与内容全经 harness 的 `generateInitFiles`（与 init 落盘
 * 同一套生成器），statusline 那条走 statusline 模块自己的生成器与落点。本模块只
 * 做「盘上 vs 期望」的比对与按 git 归类分流。
 */

export interface InitFileUpdate {
  /** 项目根相对路径（posix）。 */
  relPath: string;
  targetPath: string;
  /** 盘上缺失或内容与期望不同。 */
  outdated: boolean;
  /** `auto` = 可代写自愈；`manual` = 会进 git，只报不写；null = 没漂移，未归类。 */
  syncClass: SyncClass | null;
  /** 期望全文；null = 判不出来（盘上不可合并等）→ 不写。 */
  expectedContent: string | null;
}

/** `.weave/config.yaml` 的解析结果（手写 k:v 行，对象值是 JSON 一行）。 */
interface InitRuntime {
  initVersion: string | null;
  preset: Preset;
  harnesses: Harness[];
  components: InitComponents;
  hooks: HooksConfig;
  mcp: MCPConfig;
}

function parseConfigYaml(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = JSON.parse(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 落档的 `hooks` 是权威集：init 每次都写全集，缺键 = 那批事件还没被 init 带进来
 * （新采集事件一律等重跑 `weave init`），不拿默认值顶回去——否则 `--hooks none`
 * 裁空的项目会在升级后悄悄长出新事件组。字段整个缺席才回落 DEFAULT_*（旧项目的
 * 「未裁剪」态，正是未加 `--hooks` 时 init 的取值）。
 */
function mergeHooks(raw: unknown): HooksConfig {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_HOOKS;
  const stored = raw as Partial<HooksConfig>;
  const unsetOff = Object.fromEntries(
    (Object.keys(DEFAULT_HOOKS) as (keyof HooksConfig)[])
      .filter((k) => typeof DEFAULT_HOOKS[k] === 'boolean' && !(k in stored))
      .map((k) => [k, false]),
  ) as Partial<HooksConfig>;
  return { ...DEFAULT_HOOKS, ...unsetOff, ...stored };
}

/**
 * 读 init 落档的运行时配置。旧项目没有 `hooks`/`mcp`/`components` 字段——
 * 回落 DEFAULT_*（正是未加 `--hooks`/`--mcp` 时 init 的取值）。
 */
export async function readInitRuntime(projectPath: string): Promise<InitRuntime> {
  let raw: string;
  try {
    raw = await readFile(path.join(projectPath, '.weave', 'config.yaml'), 'utf-8');
  } catch {
    raw = '';
  }
  const parsed = parseConfigYaml(raw);
  const preset = parsed['preset'];
  const components = parsed['components'];
  const hooks = parsed['hooks'];
  const mcp = parsed['mcp'];
  const harnesses = parsed['harnesses'];

  return {
    initVersion: typeof parsed['initVersion'] === 'string' ? parsed['initVersion'] : null,
    preset: preset === 'minimal' || preset === 'full' || preset === 'default' ? preset : 'default',
    harnesses: Array.isArray(harnesses) ? harnesses.filter(isHarness) : [],
    components: resolveComponents(
      preset === 'minimal' || preset === 'full' || preset === 'default' ? preset : 'default',
      typeof components === 'object' && components !== null
        ? (components as Partial<InitComponents>)
        : undefined,
    ),
    hooks: mergeHooks(hooks),
    mcp: { ...DEFAULT_MCP, ...(typeof mcp === 'object' && mcp !== null ? mcp : {}) },
  };
}

function platform(): PlatformInfo {
  return detectPlatform();
}

function contextFor(projectPath: string, runtime: InitRuntime): InitFileContext {
  return {
    projectPath,
    version: WEAVE_VERSION,
    platform: platform(),
    components: runtime.components,
    hooks: runtime.hooks,
    mcp: runtime.mcp,
  };
}

/**
 * statusline 那条不归 harness：生成器与落点都在 statusline 模块（它按项目的
 * 生效配置渲染，配置源见 manager 的 global/custom 二分）。
 */
async function statuslineEntry(projectPath: string, runtime: InitRuntime): Promise<InitGeneratedFile[]> {
  if (!runtime.components.helpers) return [];
  const config = await readStatuslineConfig(projectPath);
  return [
    {
      relPath: statuslineScriptRelPath(),
      weaveMarker: WEAVE_CONTENT_MARKER,
      content: generateStatuslineScript(config),
    },
  ];
}

/** 盘上原文；缺失 = null。 */
async function readDisk(targetPath: string): Promise<string | null> {
  try {
    return await readFile(targetPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * 一条生成物的期望全文。
 *
 * 整文件类（带 `weaveMarker`）：盘上是用户手写的同名文件（不含标记）→ 返回
 * null，永不碰；否则期望 = 生成内容。
 * merge 类：期望 = 把 weave 片段并进盘上原文；盘上不可解析 → null。
 */
function expectedFor(entry: InitGeneratedFile, onDisk: string | null): string | null {
  if (entry.merge) {
    if (onDisk === null) return entry.content;
    return entry.merge(onDisk, entry.content);
  }
  if (onDisk !== null && !onDisk.includes(entry.weaveMarker ?? WEAVE_CONTENT_MARKER)) {
    return null; // 用户手写：不是 drift，是「不归 weave 管」
  }
  return entry.content;
}

/** init 跑过没：`.weave/config.yaml` 在不在。没有就谈不上「生成物漂移」。 */
async function inited(projectPath: string): Promise<boolean> {
  try {
    await readFile(path.join(projectPath, '.weave', 'config.yaml'), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/** 一个项目的 init 生成物漂移清单（含全部条目，`outdated` 标注是否需同步）。 */
export async function detectInitFileUpdates(projectPath: string): Promise<InitFileUpdate[]> {
  if (!(await inited(projectPath))) return [];
  const runtime = await readInitRuntime(projectPath);
  const ctx = contextFor(projectPath, runtime);
  const harnesses: Harness[] =
    runtime.harnesses.length > 0 ? runtime.harnesses : [HARNESS_KEYS[0]!];

  const entries: InitGeneratedFile[] = [
    ...(await statuslineEntry(projectPath, runtime)),
  ];
  for (const h of harnesses) {
    entries.push(...(await generateInitFiles(h, ctx)));
  }

  const out: InitFileUpdate[] = [];
  for (const entry of entries) {
    const targetPath = path.join(projectPath, ...entry.relPath.split('/'));
    const onDisk = await readDisk(targetPath);
    const expectedContent = expectedFor(entry, onDisk);
    out.push({
      relPath: entry.relPath,
      targetPath,
      outdated: expectedContent !== null && expectedContent !== onDisk,
      syncClass: null,
      expectedContent,
    });
  }

  // 只对真漂移的条目问 git：syncClass 的下游（available / needsInit / applyInitFile）
  // 一律先按 outdated 过滤，没漂移的行读到 null 也无从影响判断；而这些行本来每个也
  // 要一趟 git 子进程（实测每项目 ~150ms）。稳态（全项目无漂移）下这条把 60s 同步
  // 扫的 git 子进程从「项目数 × 2」降到 0。
  const drifted = out.filter((u) => u.outdated);
  const classify = await gitClassify(projectPath, drifted.map((u) => u.relPath));
  for (const u of drifted) u.syncClass = classify.classOf(u.relPath);
  return out;
}

/**
 * 落一条生成物——**只写 `auto` 归类的**（不进 git）；会进 git 的写下去会改掉用户
 * 正要 commit 的文件，一律拒绝。返回是否真的写了。
 */
export async function applyInitFile(update: InitFileUpdate): Promise<boolean> {
  if (update.syncClass !== 'auto') return false;
  if (!update.outdated || update.expectedContent === null) return false;
  await mkdir(path.dirname(update.targetPath), { recursive: true });
  await writeFile(update.targetPath, update.expectedContent, 'utf-8');
  return true;
}

/** 会进 git、因此只能提醒用户跑 `weave init` 的漂移条目。 */
export function needsInit(updates: readonly InitFileUpdate[]): boolean {
  return updates.some((u) => u.syncClass === 'manual' && u.outdated);
}
