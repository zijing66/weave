import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HARNESS_EVENTS } from '@weavecode/core';
import type { CaptureDeps, CaptureScriptHealth, CaptureState, CaptureSurface } from '../driver.js';
import { generateHookHandler } from '../claude/capture.js';
import { CANONICAL_TO_WIRE } from './event-source.js';
import { codexHome } from './home.js';

/**
 * codex 采集集成（`<CODEX_HOME>/hooks.json` 的 weave 组 + hook-handler 脚本）。
 *
 * codex 0.163 起带 Claude 同形的 hooks 引擎：stdin JSON、字段名与 claude 逐字对齐
 * （`codex-rs/hooks/schema/generated/*.command.input.schema.json`），只是事件词表
 * 少几个、多一个 `Interrupt`。故脚本正文与 claude 共用一份生成器（`OWN_HARNESS`
 * 不同决定它只认自己那份注入规则），本文件只管 codex 的声明落点与信任闸。
 *
 * **信任闸**（codex 独有）：非 builtin / 非 managed 的 handler 必须有
 * `[hooks.state.'<hooks.json>:<event>:<group>:<handler>'] trusted_hash`，否则
 * **静默不执行**。哈希盖住 handler 的声明内容 ⇒ `command` 串必须**恒定**（不含
 * 版本号/时间戳），版本差异全放在脚本内部。这样「Trust all and continue」点过
 * 一次即长期有效，weave 升级不重弹。weave 不自己算这个哈希：那等于替用户签字，
 * 且依赖 codex 内部的 TOML 规范化序列化，算错的表现就是「静默不跑」。
 *
 * 只装 user 档：项目档（`<repo>/.codex/hooks.json`）还额外要求该文件夹被 codex
 * 标成 trusted，多一道用户自解不了的坎。
 */

/**
 * 要订阅的 codex 线名（`HookEventsToml` 的键，`codex-rs/config/src/hook_config.rs:39`）
 * ——由 `HARNESS_EVENTS.codex` 反推，不另抄一份线名表。`PreToolUse` /
 * `PreModelRequest` / `PostModelRequest` 不订阅：量最大且眼下没有消费方。
 */
export const CODEX_HOOK_EVENTS: readonly string[] = HARNESS_EVENTS.codex.map(
  (event) => CANONICAL_TO_WIRE[event] ?? event,
);

/**
 * weave 采集组的判据：命令指向 `<CODEX_HOME>/helpers/hook-handler.cjs`。用相对段
 * 而非绝对路径——`CODEX_HOME` 可被用户搬走，声明文件跟着搬，相对段仍命中。
 */
export const CODEX_HOOK_HANDLER_MARKER = 'helpers/hook-handler.cjs';

/** weave 特性文件的覆写判据（与 cli init 的 WEAVE_HELPER_MARKER 同判据）。 */
const WEAVE_HELPER_MARKER = '@version weave@';

/**
 * hook 窗口：脚本每个分支都是本地文件 I/O、自带 2s 自杀守卫且恒 exit 0，3s 只是兜底。
 * 取 3 而非更大：codex 把 `SessionEnd` / `Interrupt` 的上限压到 3s，写 5 会每次启动
 * 打一条 "clamping … timeout to 3s" 告警。
 */
const HOOK_TIMEOUT_SEC = 3;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function hooksFile(home?: string): string {
  return path.join(codexHome(home), 'hooks.json');
}

function helpersDir(home?: string): string {
  return path.join(codexHome(home), 'helpers');
}

function scriptFile(home?: string): string {
  return path.join(helpersDir(home), 'hook-handler.cjs');
}

/** 一个 group 是 weave 的，当它的任一命令指向 hook-handler 脚本。 */
export function groupIsWeave(group: unknown): boolean {
  if (!isPlainObject(group)) return false;
  const inner = group['hooks'];
  if (!Array.isArray(inner)) return false;
  return inner.some((h) => {
    if (!isPlainObject(h)) return false;
    const windows = h['commandWindows'];
    return (
      (typeof h['command'] === 'string' && toPosix(h['command']).includes(CODEX_HOOK_HANDLER_MARKER)) ||
      (typeof windows === 'string' && toPosix(windows).includes(CODEX_HOOK_HANDLER_MARKER))
    );
  });
}

/**
 * hooks 子图清掉 weave 采集组：用户组不动；事件清空删键；非数组形状属用户，
 * 原样保留。返回清扫后的新子图。
 */
export function sweepWeaveHookEvents(hooks: unknown): Record<string, unknown> {
  if (!isPlainObject(hooks)) return {};
  const out: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      out[event] = groups;
      continue;
    }
    const userGroups = groups.filter((g) => !groupIsWeave(g));
    if (userGroups.length > 0) out[event] = userGroups;
  }
  return out;
}

/**
 * 单事件的 weave 采集组。`command` 串恒定（脚本路径 + 固定超时），这正是
 * trusted_hash 跨 weave 升级保持有效的前提。唯一会变的是路径本身：搬
 * `CODEX_HOME` / 改数据目录后要重装一次。
 */
export function captureHookGroup(event: string, script: string): Array<Record<string, unknown>> {
  const command = `node "${toPosix(script)}"`;
  // 工具事件每轮几十条，同步等它会拖住 agent；PermissionRequest 在审批对话框
  // 弹出前触发（每轮至多几条），async 让它绝不拖慢审批路径。其余事件一轮/
  // 一会话才一条，值得等。
  const background = event === 'PostToolUse' || event === 'PermissionRequest';
  return [
    {
      hooks: [{ type: 'command', command, commandWindows: command, timeout: HOOK_TIMEOUT_SEC, ...(background ? { async: true } : {}) }],
    },
  ];
}

/** hooks.json 里是否已有 weave 采集组（installed 判据）。 */
export function captureGroupsPresent(file: unknown): boolean {
  if (!isPlainObject(file)) return false;
  const hooks = file['hooks'];
  if (!isPlainObject(hooks)) return false;
  return Object.values(hooks).some((groups) => Array.isArray(groups) && groups.some(groupIsWeave));
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** 读 hooks.json；缺文件返回 {}；存在但不可解析/非对象抛错（无法合并进去就不碰）。 */
async function readHooksFile(file: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`codex hooks file is not parseable JSON: ${file}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`codex hooks file is not a JSON object: ${file}`);
  return parsed;
}

async function writeHooksFile(file: string, doc: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(doc, null, 2) + '\n', 'utf-8');
}

export async function readUserCapture(deps: CaptureDeps = {}): Promise<CaptureState> {
  const home = deps.home;
  const doc = await readHooksFile(hooksFile(home)).catch(() => ({}));
  return {
    installed: captureGroupsPresent(doc),
    helperPresent: await pathExists(scriptFile(home)),
  };
}

/**
 * 生效采集脚本的健康（诊断面只读）。codex 没有项目档分支（项目 hooks 要文件夹
 * 信任，weave 不装），故 source 只有 user / none 两态。`reportsInbox` 恒 false：
 * codex 侧没有会话 inbox 凭据这个概念（层①-a 投递是 claude 专属）。
 */
export async function readScriptHealth(
  deps: CaptureDeps & { projectPath?: string } = {},
): Promise<CaptureScriptHealth> {
  const home = deps.home;
  const file = scriptFile(home);
  const installed = (await readUserCapture({ home })).installed;
  let content: string | null = null;
  try {
    content = await readFile(file, 'utf-8');
  } catch {
    content = null;
  }
  return {
    source: installed ? 'user' : 'none',
    present: content !== null,
    weaveOwned: content !== null && content.includes(WEAVE_HELPER_MARKER),
    generatedVersion: content?.match(/@version weave@(\S+)/)?.[1] ?? null,
    reportsInbox: false,
    reportsPaneEnv: content !== null && content.includes('terminalEnv()'),
  };
}

/**
 * user 档采集安装（幂等）：`<CODEX_HOME>/helpers/hook-handler.cjs` + `hooks.json`
 * 的 weave 组（weave 组清扫后并入，用户自己的 hooks 与 description 永不动）。
 */
export async function installUserCapture(deps: CaptureDeps & { version: string }): Promise<void> {
  const home = deps.home;
  const helpers = helpersDir(home);
  await mkdir(helpers, { recursive: true });
  const script = scriptFile(home);
  await writeFile(script, generateHookHandler(deps.version, 'codex'), 'utf-8');

  const file = hooksFile(home);
  const doc = await readHooksFile(file);
  const hooks = sweepWeaveHookEvents(doc['hooks']);
  for (const event of CODEX_HOOK_EVENTS) {
    const prev = hooks[event];
    hooks[event] = Array.isArray(prev)
      ? [...prev, ...captureHookGroup(event, script)]
      : captureHookGroup(event, script);
  }
  doc['hooks'] = hooks;
  if (typeof doc['description'] !== 'string') doc['description'] = 'weave hooks (generated — do not edit)';
  await writeHooksFile(file, doc);
}

/**
 * user 档采集停用（幂等）：清扫 hooks.json 的 weave 组 + 删脚本（带 weave 标记
 * 才删）。清完只剩空 hooks 与 weave 自己写的 description 时整份删掉——那是
 * weave 建的文件，留着只会让 codex 每次多读一个空声明。
 */
export async function uninstallUserCapture(deps: CaptureDeps = {}): Promise<void> {
  const home = deps.home;
  const file = hooksFile(home);
  const doc = await readHooksFile(file).catch(() => null);
  if (doc) {
    const swept = sweepWeaveHookEvents(doc['hooks']);
    if (Object.keys(swept).length === 0) delete doc['hooks'];
    else doc['hooks'] = swept;
    const onlyDefaults =
      doc['hooks'] === undefined &&
      (doc['description'] === undefined || doc['description'] === 'weave hooks (generated — do not edit)');
    if (onlyDefaults) {
      await unlink(file).catch(() => {});
    } else {
      await writeHooksFile(file, doc);
    }
  }
  const script = scriptFile(home);
  try {
    const content = await readFile(script, 'utf-8');
    if (content.includes(WEAVE_HELPER_MARKER)) await unlink(script);
  } catch {
    // 缺文件即已达目的；无标记（用户文件）/读失败都不动
  }
}

/** 项目档去重：user 档接管时清扫该项目 `.codex/hooks.json` 的 weave 组。 */
export async function stripProjectCapture(projectPath: string): Promise<void> {
  const file = path.join(projectPath, '.codex', 'hooks.json');
  const doc = await readHooksFile(file).catch(() => null);
  if (!doc) return;
  const swept = sweepWeaveHookEvents(doc['hooks']);
  if (Object.keys(swept).length === 0) delete doc['hooks'];
  else doc['hooks'] = swept;
  await writeHooksFile(file, doc);
}

export const CODEX_CAPTURE: CaptureSurface = {
  harness: 'codex',
  readUserCapture: (deps) => readUserCapture(deps),
  installUserCapture: (deps) => installUserCapture(deps),
  uninstallUserCapture: (deps) => uninstallUserCapture(deps),
  stripProjectCapture,
  scriptHealth: (deps) => readScriptHealth(deps),
};
