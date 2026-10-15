/**
 * Daemon API client. All routes are prefixed with /api — in dev the Vite proxy
 * strips /api and forwards to the daemon; in production the daemon strips /api
 * itself and statically hosts the SPA for everything else.
 */

import type { Harness } from '@weavecode/core/harness';
import type { EnableOverride, ToolScope, ToolStateRow } from '@weavecode/core/tool';
import { HARNESS_ORDER } from './harness-meta';
import { markUnauthorized } from './auth';

/** daemon API 前缀：dev 由 vite 代理剥离，prod 由 daemon 自剥（web 侧只此一处）。 */
export const API_BASE = '/api';
const BASE = API_BASE; // 本文件既有调用点沿用短名

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init?.headers,
    },
  });
  if (res.status === 401) {
    // 会话失效/未登录：置匿名 → App 随即渲染登录页；错误照抛（调用方仍可读文案）。
    markUnauthorized();
    throw new Error(await errorText(res));
  }
  if (!res.ok) throw new Error(await errorText(res));
  return (await res.json()) as T;
}

/** 错误信息取 daemon 的 {error|message} 字段；非 JSON / 无字段回落状态码+原文。 */
async function errorText(res: Response): Promise<string> {
  const body = await res.text();
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error;
    if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
  } catch {
    // 非 JSON 错误体（代理/网络层）→ 保留状态码前缀
  }
  return body ? `${res.status} ${body}` : String(res.status);
}

export interface ProjectRow {
  id: number;
  path: string;
  name: string;
  token: string;
  source: string;
  registeredAt: string;
  lastSeenAt: string | null;
  meta: string | null;
  /** 归档时间（null/undefined = 活跃项目）。 */
  archivedAt?: string | null;
}

/** 会话终端可附加目标（一个窗口内的一个 tab，按最近活跃排序；id 格式归各终端）。 */
export interface TerminalTarget {
  /** 不透明 id（回传给 openSessionTerminal）。 */
  id: string;
  windowId: number;
  tabId: number;
  /** 聚焦 pane 的标题；null → 前端回落窗口/Tab 号文案。 */
  title: string | null;
  /** cwd 命中该项目的 pane 数 / 该 tab 总 pane 数。 */
  matchCount: number;
  paneCount: number;
  active: boolean;
}

/** Structured result of one harness health check (core 返回，文案由 web 词典渲染). */
export interface HarnessCheck {
  id: string;
  params: Record<string, string | boolean>;
  ok: boolean;
}

export type AssetAgent = Harness;

export interface AssetEntry {
  absPath: string;
  relPath: string;
  category: string;
  mtimeMs: number;
  /** Which coding agent's harness surface this asset belongs to. */
  agent?: AssetAgent;
  /** True when the file itself is a symbolic link (its target is watched). */
  isSymlink?: boolean;
  /** 所属仓库 namespace（该文件是哪个仓库铺下来的）：用户自己写的文件不属于任何
   *  仓库，故缺省。服务端判定，web 只渲染。 */
  namespace?: string;
}

export interface AssetChangeEvent {
  projectPath: string;
  projectName: string;
  category: string;
  relPath: string;
  absPath: string;
  kind: 'add' | 'change' | 'unlink';
  agent?: AssetAgent;
  /** True when the file itself is a symbolic link (its target is watched). */
  isSymlink?: boolean;
}

export interface HookEventRow {
  id: number;
  projectId: number;
  source: string;
  eventType: string;
  sessionId: string | null;
  payload: string;
  createdAt: string;
}

/**
 * Mirror of the hook rule model in packages/weave-core/src/types.ts — 保持同步
 * （web 不能 import 含 node:fs 的 workspace 包，服务端 zod 校验兜底）。
 */
export type HookRuleSource =
  | { kind: 'hook-event'; harness: Harness | 'any'; event: string }
  | { kind: 'webhook'; routeId: string }
  /** 读兼容分支：存量规则的 legacy 形，读侧经 normalizeHookRuleSource 归一。 */
  | { kind: 'claude-event'; event: string };

/** mirror of `normalizeHookRuleSource` in packages/weave-core/src/types.ts。 */
export function normalizeHookRuleSource(source: HookRuleSource): HookRuleSource {
  if (source.kind === 'claude-event') {
    return { kind: 'hook-event', harness: 'claude', event: source.event };
  }
  return source;
}

/** mirror of `hookSourceHarness` in packages/weave-core/src/types.ts。 */
export function hookSourceHarness(source: HookRuleSource): Harness | 'any' | null {
  if (source.kind === 'claude-event') return 'claude';
  if (source.kind === 'hook-event') return source.harness;
  return null;
}

/** mirror of `HookRuleFilter` in packages/weave-core/src/types.ts。 */
export interface HookRuleFilter {
  /** 匹配 toolInput 的工具名（PostToolUse/PreToolUse 事件）。 */
  toolNames?: string[];
  /** 匹配 toolInput.file_path 的 glob（posix 分隔符）。 */
  pathGlobs?: string[];
  /** 只在 file_path/cwd 命中「其他已注册项目根」时触发。 */
  crossProjectOnly?: boolean;
}

/** mirror of `HandlerConfig` in packages/weave-core/src/types.ts。 */
export type HandlerConfig =
  | { type: 'log' }
  | { type: 'webhook'; url: string; secret?: string; headers?: Record<string, string> }
  | { type: 'inject'; template: string }
  | { type: 'manual'; template: string }
  | { type: 'plugin'; pluginId: string; handlerType: string; config?: Record<string, unknown> };

/** mirror of `HookRule` in packages/weave-core/src/types.ts。 */
export interface HookRule {
  id: string;
  name: string;
  enabled: boolean;
  /** 数值越大越先匹配。 */
  priority: number;
  /** null = 全局规则（对所有注册项目生效）。 */
  projectId: number | null;
  source: HookRuleSource;
  filter: HookRuleFilter;
  handler: HandlerConfig;
  timeoutMs: number;
  /** 是否落 hook_dispatches（log 默认 false）。 */
  record: boolean;
  /** 来源标记（插件规则显示徽标用；旧服务端缺省视为 user）。 */
  origin?: 'user' | 'plugin' | 'builtin';
  pluginId?: string | null;
}

/** mirror of `LoadedPluginInfo` in packages/weave-server/src/hooks/plugin-loader.ts。 */
export interface HookPlugin {
  id: string;
  name: string;
  version: string;
  dir: string;
  scope: 'builtin' | 'user' | 'project';
  projectId: number | null;
  status: 'active' | 'rejected' | 'disabled';
  error?: string;
  ruleCount: number;
}

/** mirror of `ToolkitPackInfo` in packages/weave-server/src/hooks/toolkit.ts（批 10）。 */
export interface ToolkitPack {
  id: string;
  name: string;
  version: string;
  description?: string;
  scope: string;
  dir: string;
  provenance: 'builtin' | 'market';
  sourceRoot: string;
  /** 所属仓库 namespace（服务端 `marketIdOf(pack.dir)`）：内置 = `weave`、外部
   *  市场 = 该市场 id；不在任何市场下（裸插件/手加目录）缺省 → 前端归「本地」。
   *  一级折叠块据此分组，**不得自己从路径里推**。 */
  namespace?: string;
  /** weave.json manifest 的安装目标 harness（服务端 normalizeTargets 归一）。 */
  targets: Harness[];
  kind: 'skill' | 'hook' | 'mod' | 'rule' | 'surface';
  components: string[];
  ccPack: boolean;
  weavePack: boolean;
  skills: string[];
  enabled: boolean;
  /** 是否已安装（CC/mod = harness 全局安装态；表面包 = 本项目落盘；weave 恒 true）。 */
  installed: boolean;
  /** CC 注册键 `name@<市场>`（仅 CC 落地包有）：@后为所属市场 = 插件的 namespace。 */
  key?: string;
  /** 该键已登记的安装 scope（user = 全局装、project = 项目内装）；未装为空。 */
  scopes?: string[];
  weave?: { status: 'active' | 'rejected' | 'disabled'; ruleCount: number; error?: string };
}

/** mirror of server `ToolkitListResult` / `ToolkitToggleResult`。 */
export interface ToolkitListResult {
  packs: ToolkitPack[];
  legacyCopies: string[];
}

export interface ToolkitToggleResult {
  pack: ToolkitPack;
  warnings: string[];
}

/** 创建/更新规则的请求体（服务端 zod CreateRuleBody / UpdateRuleBody）。 */
export interface HookRuleInput {
  name: string;
  enabled?: boolean;
  priority?: number;
  projectId: number | null;
  source: HookRuleSource;
  filter?: HookRuleFilter;
  handler: HandlerConfig;
  timeoutMs?: number;
  record?: boolean;
}

/** mirror of `HookDispatchStatus` in packages/weave-core/src/types.ts。 */
export type HookDispatchStatus =
  | 'pending'
  | 'injected'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timeout';

/** mirror of `HookDispatchMode` in packages/weave-core/src/types.ts。 */
export type HookDispatchMode = 'auto' | 'manual';

/** mirror of `HookDispatchRow` in packages/weave-server/src/repositories/hook-dispatches.ts。 */
export interface HookDispatch {
  id: number;
  ruleId: string;
  eventId: number | null;
  sessionId: string | null;
  /** 待运行指令文本（指令池中的「物」）。 */
  prompt: string;
  status: HookDispatchStatus;
  mode: HookDispatchMode;
  output: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** mirror of `SessionRow` in packages/weave-server/src/repositories/sessions.ts。 */
export interface SessionRow {
  sessionId: string;
  projectId: number | null;
  /** 已生效的自定义标题。 */
  title: string | null;
  /** dashboard 改名待生效：下次 SessionStart/UserPromptSubmit 时经 hook 下发。 */
  pendingTitle: string | null;
  lastSeenAt: string;
  createdAt: string;
  /** 该会话 hook 事件数（GET /sessions 的 listWithCounts 填充）。 */
  eventCount?: number;
  /** 会话归属 harness（最新事件 source；listWithCounts 填充，其余查询 undefined）。 */
  harness?: Harness | null;
  /** 回合开合服务端基线：最后 UPS 晚于最后 Stop/SessionEnd（listWithCounts 填充）。 */
  turnOpen?: boolean;
  /** 最新一条 hook 事件类型（listWithCounts 填充）——状态总线判「关闭」用。 */
  lastEventType?: string | null;
  /** claude 注册表判活：false=进程确死（判 terminated）；null=查不到登记（codex 等）不猜。 */
  pidAlive?: boolean | null;
  /** 无 prompt 幽灵会话的自动清理时刻（服务端 listWithCounts 派生；null = 正常会话）。
   *  服务端 SessionSweeper 过期即清，行内渲染倒计时 tag。 */
  autoDeleteAt?: string | null;
}

/** mirror of `HARNESS_EVENTS.claude`（core；别名 CLAUDE_HOOK_EVENTS）— 同序。
 *  hooks 规则编辑器的事件选项——按 harness 事件表展开随 hooks 域批做。 */
export const CLAUDE_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'SessionStart',
  'Stop',
  'SubagentStop',
  'Notification',
] as const;

/** mirror of `INJECTABLE_HOOK_EVENTS` — inject 处理器只允许这些事件（服务端 400）。 */
export const INJECTABLE_HOOK_EVENTS = [
  'PostToolUse',
  'UserPromptSubmit',
  'SessionStart',
  'Stop',
  'SubagentStop',
] as const;

/** mirror of `PipeMessage` in packages/weave-server/src/hooks/message-deliverer.ts——
 *  在途视图（GET /sessions/:id/messages = listVisible：promptbox 队列行 ∪ 内存态）。
 *  终态短时驻留：delivered/injected/succeeded 在 settledAt+60s 内可见（展示
 *  via/acked），过后消失；failed/timeout/暂停闸成因（stalled）常驻。
 *  历史在会话自己的转录里，管道不记录发起方。 */
export interface SessionMessageRow {
  /** 管道发号（uuid，全生命周期稳定；序列步 messageId 反查此值）。 */
  id: string;
  /** 目标会话（本视图每行都是投给它的）。 */
  sessionId: string;
  text: string;
  mode: 'prompt' | 'inject' | 'headless' | 'auto';
  /** 实际投递通道（auto 落定后回填；pending = 尚未裁决）。 */
  channel: 'prompt' | 'inject' | 'headless' | null;
  /** prompt 通道的实际落法（socket 直投 / 中继 / 终端 send-text）。 */
  via?: 'socket' | 'relay' | 'terminal' | null;
  status: 'pending' | 'delivering' | 'running' | 'injected' | 'delivered' | 'succeeded' | 'failed' | 'timeout';
  /** 投递回执：目标会话自己的 UserPromptSubmit 与本文匹配上了（真到达）。 */
  acked?: boolean | null;
  /** 终态落定时刻（驻留窗口起点；在途态无值）。 */
  settledAt?: string | null;
  /** 本条 = 该会话队列暂停闸的成因（未回执超窗/投递失败）；重发或回执清除。 */
  stalled?: boolean | null;
  output: string | null;
  error: string | null;
  at: string;
}

/** mirror of MessagingSurface 派生能力矩阵（GET /messaging/capabilities 行）——
 *  web 只渲染不判定：按钮门控、编排域模式选项都从这张表来。 */
export interface MessagingCapability {
  harness: Harness;
  discovery: boolean;
  /** 人工投递唯一通道（层① 原生中继 || 层② 终端 send-text，随 settings 变）。 */
  prompt: boolean;
  inject: boolean;
  headless: boolean;
  watch: boolean;
  unsupportedReasons: Partial<
    Record<'discovery' | 'prompt' | 'inject' | 'headless' | 'watch', string>
  > | null;
}

/** mirror of `WatchOn` in packages/weave-server/src/repositories/session-watches.ts。 */
export type WatchOn = 'idle' | 'turnEnd' | 'messageFailed';

/** mirror of `SessionWatchRow` in packages/weave-server/src/repositories/session-watches.ts。 */
export interface SessionWatchRow {
  id: number;
  /** null = dashboard 订阅（本面板创建的都是 null）。 */
  watcherSessionId: string | null;
  targetSessionId: string;
  /** 触发类型集（订阅时选；缺省 ['idle']）。 */
  onEvents: WatchOn[];
  /** 剩余提醒次数（所有已选类型共用）；null = 持久化。 */
  remaining: number | null;
  notify: string | null;
  /** null = pending；fire 后行不再出现在列表（one-shot）。 */
  firedAt: string | null;
  createdAt: string;
}

/** mirror of `BlockingQuestionOption`（harness 规格拼装：web 只传下标，键序不下发）。
 *  `keys` 是**原子序列**——宿主 TUI 把一次写入的连续字符当粘贴，故每元素独立成键。 */
export interface PendingQuestionOption {
  keys: string[];
  label: string;
  description?: string | null;
  /** 宿主自有尾行「自定义输入」：作答时须带文本（终端会进文本框）。 */
  input?: boolean;
  /** 该行选中后到文本框的走位键（多选要在选项列表里按 ↓ 挪到文本框）。 */
  textFocus?: string[];
  /** 文本框内送文本后的收尾键（回车 / 内联 Submit）。 */
  textTail?: string[];
  /** 宿主自有尾行「结束整个提问去聊天」：无文本，按下即结束提问。 */
  chat?: boolean;
}

/** mirror of `BlockingQuestion`：待答问题面——问题文案/选项保留原文（终端模态框
 *  里就是这个英文面），UI chrome（角标/标题/按钮）走 i18n。 */
export interface PendingQuestion {
  /** 稳定键（作答路由定位）。 */
  key: string;
  header?: string | null;
  question: string;
  options: PendingQuestionOption[];
  multiSelect: boolean;
  /** 收尾屏（宿主模态框尾部的「提交 / 取消」tab）：不是宿主的第 n 个问题，
   *  是整 call 的落定动作——`questions ≥ 2 || 任一问多选` 才有，恒在面末尾。 */
  submit?: boolean;
}

/** 一问的作答（web 只送下标与文本，键序由服务端按面拼）。 */
export interface AnswerPick {
  questionKey: string;
  /** 选中的选项下标（空 = 未作答）。 */
  options: number[];
  /** 自定义输入行的文本（仅当选中了 `input` 行）。 */
  text?: string;
}

/** mirror of `PendingQuestionEntry`（GET /messaging/questions 行）。 */
export interface PendingQuestionEntry {
  sessionId: string;
  harness: Harness;
  /** question = AskUserQuestion/计划确认；permission = 权限确认。 */
  kind: 'question' | 'permission';
  questions: PendingQuestion[];
  at: string;
}

/** mirror of `SequenceStep` in packages/weave-server/src/repositories/session-sequences.ts。 */
export interface SequenceStep {
  to: string;
  text: string;
  mode: 'prompt' | 'inject' | 'headless' | 'auto';
  /** 步触发后回填的管道发号（缺省 = 尚未触发）。 */
  messageId?: string;
}

/** mirror of `SessionSequenceRow`（session_sequences 表行；steps 已解析为数组）。 */
export interface SessionSequenceRow {
  id: number;
  name: string;
  steps: SequenceStep[];
  status: 'running' | 'done' | 'failed' | 'cancelled';
  /** 正在等待完成的步下标；全落 = steps.length。 */
  cursor: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryRow {
  id: number;
  path: string;
  kind: 'skill' | 'mcp' | 'both';
  addedAt: string;
}

/** mirror of server `market/updates.ts` 的检查结果（POST /market/check-updates）。 */
export type MarketUpdateStatus = 'uptodate' | 'update-available' | 'origin-missing' | 'unknown';
export interface MarketUpdateCheck {
  id: number;
  status: MarketUpdateStatus;
  checkedAt: string;
}

/** 资源市场清单行（GET /market）：libraries 行 + resolve 后有效路径 + 清单元数据。 */
export interface MarketItem {
  id: number;
  kind: LibraryRow['kind'];
  addedAt: string;
  /** resolve 后的有效绝对路径。 */
  path: string;
  /** 相对 dataDir 的 posix 形（外部源为 null）。 */
  relPath: string | null;
  /** 市场目录名（managed 资源）。 */
  resourceId: string | null;
  /** 是否收纳在 `<dataDir>/market/` 内。 */
  managed: boolean;
  /** 内置仓（weave 自己随包发布的那一份）：不是导入来的，不可迁入/删除/查更新。 */
  builtin: boolean;
  /** 仓库 namespace = 资源管理里那一级的块名（内置仓 = `weave`）；不在市场内的
   *  legacy 外部源没有仓库可归。web 只渲染，不自己从路径推。 */
  namespace?: string;
  /** 无清单 → legacy 外部/未收纳源（显示「迁入市场」）。 */
  legacy: boolean;
  source: 'git' | 'dir' | 'legacy' | 'builtin';
  origin: string | null;
  importedAt: string | null;
  commit: string | null;
  /** 该目录包含的资产类型计数（与资源管理文件树同词表；0 计数 key 不出现）。 */
  tags: Record<string, number> | null;
}

/** Browse starting point for the directory picker (home, drives, …). */
export interface BrowseRoot {
  path: string;
  kind:
    | 'home'
    | 'desktop'
    | 'downloads'
    | 'documents'
    | 'library-parent'
    | 'drive'
    | 'root';
}

/** One subdirectory of the currently browsed folder. */
export interface BrowseChild {
  name: string;
  path: string;
}

export interface SkillAsset {
  name: string;
  dirPath: string;
  relPath: string;
  /** Parent directory (typically a `skills/` folder) relative to the library root. */
  group: string;
}

export interface McpTemplate {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  sourcePath: string;
  relPath: string;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** MCP 工具行：模型协议 ToolStateRow，服务端 readMcpRows 装配；本路由的行恒带 detail（服务器配置）。 */
export type McpRow = ToolStateRow<McpServerConfig> & { detail: McpServerConfig };

/** Single-file harness assets (command/agent/workflow/rule/output-style). */
export type FileAssetCategory = 'command' | 'agent' | 'workflow' | 'rule' | 'output-style';

export const FILE_ASSET_CATEGORIES: FileAssetCategory[] = [
  'command',
  'agent',
  'workflow',
  'rule',
  'output-style',
];

/** A file template found inside a registered library. */
export interface FileAssetTemplate {
  name: string;
  /** Absolute path of the template file inside the library. */
  filePath: string;
  relPath: string;
  group: string;
  category: FileAssetCategory;
}

/** Mirror of server `install/scanner.ts` MarketPluginAsset（插件包发现于库内）。 */
export interface MarketPluginAsset {
  name: string;
  version: string;
  description?: string;
  /** CC 注册键 `name@<市场>`（仅 CC 落地包有）：@后为所属市场 = 插件的 namespace。 */
  key?: string;
  /** Absolute path to the pack directory (install / enable source). */
  dirPath: string;
  /** Pack dir relative to the library root (posix; 包内 skill 双身份前缀匹配键). */
  relPath: string;
  ccPack: boolean;
  weavePack: boolean;
  kind: 'skill' | 'hook' | 'mod' | 'rule' | 'surface';
  components: ('skill' | 'command' | 'agent' | 'hook' | 'mod' | 'rule')[];
  targets: Harness[];
  /** Pack-internal skills carrying a SKILL.md. */
  skills: string[];
}

export interface InstallBody {
  category: 'skill' | 'mcp' | 'plugin' | FileAssetCategory;
  name: string;
  sourceDir?: string;
  /** Template file (library-relative or absolute) for file assets. */
  sourceFile?: string;
  mcpConfig?: McpServerConfig;
  scope?: 'project' | 'user';
  agent?: AssetAgent;
  /** plugin 类别：无 manifest 包合成最小 plugin.json 用（版本/描述）。 */
  version?: string;
  description?: string;
}

export type AssetScope = 'project' | 'user';

/** Mirror of server `install/capabilities.ts`（安装属性矩阵唯一事实源在服务端）。 */
export type InstallCategory = 'skill' | 'mcp' | FileAssetCategory;

export interface CategoryCapability {
  surfaces: Array<{
    harness: AssetAgent;
    scopes: AssetScope[];
    /** 各 scope 的安装落点显示形（服务端经资产面派生；范围落点提示按此渲染）。 */
    dest?: Partial<Record<AssetScope, string>>;
  }>;
}

export interface InstallCapabilities {
  categories: Record<InstallCategory, CategoryCapability>;
}

export interface SkillUpdate {
  name: string;
  scope: AssetScope;
  outdated: boolean;
  custom: boolean;
  sourceDir?: string;
  libraryId?: number;
  agent?: AssetAgent;
}

export interface FileAssetUpdate {
  name: string;
  category: FileAssetCategory;
  scope: AssetScope;
  outdated: boolean;
  custom: boolean;
  sourceFile?: string;
  libraryId?: number;
}

export interface McpUpdate {
  name: string;
  scope: AssetScope;
  outdated: boolean;
  custom: boolean;
  libraryId?: number;
  /** 'codex' updates target ~/.codex/config.toml (always user scope). */
  agent?: AssetAgent;
}

export interface UpdateReport {
  skills: SkillUpdate[];
  files: FileAssetUpdate[];
  mcp: McpUpdate[];
  available: number;
}

/** Where a global skill was resolved from (grouping key in the global view).
 *  Derived from `Harness` so a new harness's personal/plugin groups slot in. */
export type GlobalSkillSource = `${Harness}-personal` | `${Harness}-plugin`;

/** GlobalSkillSource 的 harness 前缀（claude-personal → claude）——按名表前缀匹配，
 *  不写死两 harness；无匹配返回 null（未知来源，调用方不猜）。 */
export function skillSourceRuntime(source: GlobalSkillSource): Harness | null {
  return HARNESS_ORDER.find((h) => source.startsWith(h)) ?? null;
}

/** A resolved skill directory (absolute path, may be a symlink target). */
export interface GlobalSkillEntry {
  name: string;
  dir: string;
  /** 装面形态（服务端 lstat 判定）：链接 = 全局位置无副本、副本 = 回退复制。
   *  仅陈述事实——CC 自有的 plugins/cache 副本非 weave 可控，别拿它提示用户改设置。 */
  form: 'link' | 'copy';
}

/** A labelled group of global skills sharing a source. Plugin groups carry
 * enable state keyed `plugin@marketplace`; personal groups do not. */
export interface GlobalSkillGroup {
  source: GlobalSkillSource;
  label: string;
  skills: GlobalSkillEntry[];
  pluginKey?: string;
  /** 所属市场 = 仓库 namespace（服务端经 harness 面拆键得来）。前端据此做一级
   *  折叠块，**不得自己 split `@`**；个人组无此字段（归「本地」）。 */
  namespace?: string;
  enabled?: boolean;
}

/** 插件工具行：模型协议 ToolStateRow（install/enable 逐档，effective 服务端解析）。 */
export type PluginRow = ToolStateRow;

export type PluginRuntime = Harness;

export interface ProjectConfig {
  autoSync: boolean;
  lastSyncAt: string | null;
}

/** Which terminal "open in terminal" launches; presets are platform-scoped. */
export type TerminalPreset =
  | 'auto'
  | 'wt'
  | 'powershell'
  | 'cmd'
  | 'terminal'
  | 'iterm'
  | 'gnome'
  | 'konsole'
  | 'wezterm'
  | 'ghostty'
  | 'custom';

export interface TerminalSettings {
  preset: TerminalPreset;
  /** Template for `custom`; `{path}` is replaced with the quoted directory. */
  customCommand: string;
}

/** mirror of packages/weave-server/src/daemon/settings.ts — 保持同步
 * （web 不能 import 含 node:fs 的 workspace 包，服务端 mergeDefaults
 * 白名单会把非法值规范化，漂移可自愈）。 */
export type Locale = 'zh-CN' | 'en';

export interface DaemonSettings {
  terminal: TerminalSettings;
  locale: Locale;
  /** mirror of packages/weave-server/src/daemon/settings.ts — 保持同步。 */
  hooks: { enabled: boolean };
  /** 开机自启 daemon（默认关）。 */
  startup?: { launchOnLogin: boolean };
  /** 监听绑定地址（默认 0.0.0.0）+ 局域网 HTTPS 端口（0 = 关）。 */
  server?: { bindHost: string; tlsPort?: number };
  /**
   * AI 助手（OpenAI 兼容端点）。地址/模型是非密配置；`apiKey` 是**只写**字段
   * （服务端拆存 `<dataDir>/ai.json`，GET/PUT 都不回显），`apiKeySet` 是服务端派生布尔。
   */
  ai?: { baseUrl: string; model: string; apiKey?: string | null; apiKeySet?: boolean };
}

export interface TerminalPresetMeta {
  id: TerminalPreset;
  label: string;
}

/** GET /settings 附带的对外访问地址（服务端 accessUrls 派生，全部 IP × 已开协议）。 */
export interface AccessUrl {
  url: string;
  protocol: 'http' | 'https';
  /** local = 本机回环；lan = 局域网其他设备可达。 */
  scope: 'local' | 'lan';
}

export interface DaemonSettingsBundle {
  settings: DaemonSettings;
  presets: TerminalPresetMeta[];
  platform: string;
  urls?: AccessUrl[];
}

/** user 档采集状态行（GET/PUT /capture；§6-2d 安装即启用，无独立开关位）。 */
export interface CaptureRow {
  harness: Harness;
  /** user settings 采集组已写入（= 全项目事件都被采集）。 */
  installed: boolean;
  /** user 级 helper 脚本就位（installed 而脚本缺 = 半安装，重开开关即修复）。 */
  helperPresent: boolean;
}

export interface ProjectFile {
  path: string;
  content: string;
  size: number;
}

export type StatuslineNamedColor =
  | 'gray'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan';

/**
 * Mirror of `StatuslineColor` in packages/weave-server/src/statusline/config.ts.
 * The web app does not depend on @weavecode/server, so this file is a hand-copied
 * duplicate — keep the two in lockstep (a mismatch breaks `tsc && vite build`).
 * A colour is a named ANSI colour, `ansi256:0-255`, or `#rgb`/`#rrggbb`.
 */
export type StatuslineColor = StatuslineNamedColor | `ansi256:${number}` | `#${string}`;

/** The seven classic ANSI names, in palette order. */
export const NAMED_COLORS: readonly StatuslineNamedColor[] = [
  'gray',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
];

export type SegmentKey =
  | 'project'
  | 'git'
  | 'git_user'
  | 'changes'
  | 'model'
  | 'thinking'
  | 'context'
  | 'tokens'
  | 'cost'
  | 'rate'
  | 'time'
  | 'version'
  | 'output_style'
  | 'session'
  | 'exceeds200k'
  | 'fast_mode'
  | 'vim'
  | 'pr'
  | 'worktree'
  | 'agent';

export interface StatuslineSegment {
  enabled: boolean;
  color: StatuslineColor;
  bold: boolean;
  /** Optional emoji/symbol prefix (e.g. `🤖`, `🌿`, `📁`). Empty when unused. */
  icon: string;
  /** Solid background block colour; `null` for foreground only. */
  backgroundColor: StatuslineColor | null;
  /** Join this segment into the next block (no gap, inherited background). */
  merge: boolean;
  /** Context-bar display mode; ignored by other segments. */
  style?: 'percent' | 'bar' | 'both';
  /** Static prefix, rendered as `<label><labelSeparator><value>`. */
  label?: string;
  /** `{token}` value template; replaces the built-in formatting when set. */
  format?: string;
  /** `tokens` only: session-cumulative or context-window count. */
  metric?: 'session' | 'context';
  /** Which rate-limit window `rate` reports; ignored by other segments. */
  window?: 'five_hour' | 'seven_day' | 'spend';
}

/** Progress-bar appearance; global rather than per-segment. */
export interface StatuslineBar {
  cells: number;
  fill: string;
  empty: string;
}

export type StatuslineAlign = 'left' | 'center' | 'right';
export type StatuslineSource = 'global' | 'custom';

/**
 * Mirror of `WEAVE_VERSION` in packages/weave-server/src/version.ts — the web
 * app stamps the same version into the logo preview as the generator does.
 * Keep in lockstep with that file and the workspace package manifests.
 */
export const WEAVE_VERSION = '0.1.0';

export interface StatuslineConfig {
  separator: string;
  align: StatuslineAlign;
  /** Row-0 logo text, rendered as `<logoText> v<version>`. Not optional. */
  logoText: string;
  logoColor: StatuslineColor;
  /** Nerd-Font glyph set; `undefined` = classic triangle defaults, '' disables a cap. */
  powerline: { enabled: boolean; separator?: string; startCap?: string; endCap?: string };
  /** Ordered rows; each row is the left-to-right segment order of that line. */
  lines: SegmentKey[][];
  /** Seconds between Claude Code re-runs of the script (min 1). */
  refreshInterval: number;
  /** Follow the global template, or keep a project-local config. */
  source: StatuslineSource;
  /** Progress-bar appearance, shared by every segment that draws a bar. */
  bar: StatuslineBar;
  /** Rendered between rows; an empty string (the default) draws nothing. */
  divider: string;
  /** Rendered between a segment's `label` and its value. */
  labelSeparator: string;
  segments: Record<SegmentKey, StatuslineSegment>;
}

/** Mirror of `SEGMENT_TOKENS` in the server's statusline/config.ts. */
export const SEGMENT_TOKENS: Record<SegmentKey, readonly string[]> = {
  project: ['name', 'path'],
  git: ['branch', 'repo'],
  git_user: ['user', 'email'],
  changes: ['added', 'deleted', 'files'],
  model: ['model'],
  thinking: ['level'],
  context: ['bar', 'used', 'total', 'percent', 'remaining'],
  tokens: ['total', 'percent'],
  cost: ['cost', 'duration', 'api_duration', 'lines_added', 'lines_removed'],
  rate: ['percent', 'limit', 'resets'],
  time: ['time'],
  version: ['version'],
  output_style: ['style'],
  session: ['name'],
  exceeds200k: ['over'],
  fast_mode: ['mode'],
  vim: ['mode'],
  pr: ['number', 'state', 'url'],
  worktree: ['name', 'branch'],
  agent: ['name'],
};

/** Mirror of `SEGMENT_DEFAULT_FORMAT` in the server's statusline/config.ts. */
export const SEGMENT_DEFAULT_FORMAT: Record<SegmentKey, string> = {
  project: '{name}',
  git: '{branch}',
  git_user: '{user} <{email}>',
  changes: '{files}',
  model: '{model}',
  thinking: '{level}',
  context: '{percent}% {bar}',
  tokens: '{total}',
  cost: '{cost}',
  rate: '{limit} {percent}%',
  time: '{time}',
  version: '{version}',
  output_style: '{style}',
  session: '{name}',
  exceeds200k: '{over}',
  fast_mode: '{mode}',
  vim: '{mode}',
  pr: '#{number}',
  worktree: '{name}',
  agent: '{name}',
};

/** Mirror of `CONTEXT_STYLE_FORMAT`: legacy `context.style` → template. */
export const CONTEXT_STYLE_FORMAT: Record<'percent' | 'bar' | 'both', string> = {
  percent: '{percent}%',
  bar: '{bar}',
  both: '{percent}% {bar}',
};

export const api = {
  listProjects: (): Promise<ProjectRow[]> =>
    apiFetch<{ projects: ProjectRow[] }>('/projects').then((r) => r.projects),
  /** 归档项目面（仅基础信息；历史会话已在归档时清空）。 */
  listArchivedProjects: (): Promise<ProjectRow[]> =>
    apiFetch<{ projects: ProjectRow[] }>('/projects/archived').then((r) => r.projects),
  /** 归档：清空历史会话 + 管道文件，server 各消费面即刻跳过；项目行只留基础信息。 */
  archiveProject: (
    id: number,
  ): Promise<{
    project: ProjectRow;
    purged: { events: number; dispatches: number; sessions: number };
  }> => apiFetch(`/projects/${id}/archive`, { method: 'POST' }),
  /** 恢复：翻转归档位回活跃（会话历史不回来——归档是删除不是暂停）。 */
  restoreProject: (id: number): Promise<{ project: ProjectRow }> =>
    apiFetch<{ project: ProjectRow }>(`/projects/${id}/restore`, { method: 'POST' }),
  /** 项目列表拖动排序持久化：payload = 完整目标顺序（id 全量列表），幂等。 */
  reorderProjects: (ids: number[]): Promise<ProjectRow[]> =>
    apiFetch<{ projects: ProjectRow[] }>('/projects/order', {
      method: 'PUT',
      body: JSON.stringify({ ids }),
    }).then((r) => r.projects),
  listAssets: (projectPath: string): Promise<AssetEntry[]> =>
    apiFetch<{ projectPath: string; assets: AssetEntry[] }>(
      `/assets?path=${encodeURIComponent(projectPath)}`,
    ).then((r) => r.assets),
  /** Machine-level harness files (~/.claude, ~/.codex) for the global tree. */
  listGlobalFileAssets: (): Promise<AssetEntry[]> =>
    apiFetch<{ assets: AssetEntry[] }>('/global-file-assets').then((r) => r.assets),
  /** 按会话查事件（时间升序，任务视图事件链用）。projectId 仅作鉴权锚点。
   *  `beforeId` 游标翻页：只取比游更早的事件（组头「加载更早」向前翻）。
   *  `types` 非空只取这些事件类型（对话视图只翻开/闭轮事件）。 */
  listSessionHooks: (
    projectId: number,
    sessionId: string,
    limit = 300,
    beforeId?: number,
    types?: readonly string[],
  ): Promise<HookEventRow[]> =>
    apiFetch<{ events: HookEventRow[] }>(
      `/projects/${projectId}/hooks?sessionId=${encodeURIComponent(sessionId)}&limit=${limit}${
        beforeId === undefined ? '' : `&beforeId=${beforeId}`
      }${types?.length ? `&types=${encodeURIComponent(types.join(','))}` : ''}`,
    ).then((r) => r.events),

  // --- hooks rules / dispatches / sessions ---
  /** 不带 projectId 返回全部规则；带 projectId 返回全局 + 该项目的规则。 */
  listHooksRules: (projectId?: number): Promise<HookRule[]> =>
    apiFetch<{ rules: HookRule[] }>(
      `/hooks/rules${projectId === undefined ? '' : `?projectId=${projectId}`}`,
    ).then((r) => r.rules),
  createHookRule: (body: HookRuleInput): Promise<HookRule> =>
    apiFetch<{ rule: HookRule }>('/hooks/rules', {
      method: 'POST',
      body: JSON.stringify(body),
    }).then((r) => r.rule),
  /** 局部更新；未知 id 抛 404 错误。 */
  updateHookRule: (id: string, patch: Partial<HookRuleInput>): Promise<HookRule> =>
    apiFetch<{ rule: HookRule }>(`/hooks/rules/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }).then((r) => r.rule),
  deleteHookRule: (id: string): Promise<void> =>
    apiFetch<{ ok: boolean }>(`/hooks/rules/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }).then(() => undefined),
  /** SPI 扫描的插件列表（内置预设/全局/项目三根）。带 projectId = 该项目 effective 态。 */
  listHookPlugins: (projectId?: number): Promise<HookPlugin[]> =>
    apiFetch<{ plugins: HookPlugin[] }>(
      `/hooks/plugins${projectId === undefined ? '' : `?projectId=${projectId}`}`,
    ).then((r) => r.plugins),
  /** 插件级开关（级联启停其全部规则）；带 projectId = 项目覆盖（不写全局默认）。 */
  toggleHookPlugin: (id: string, enabled: boolean, projectId?: number): Promise<void> =>
    apiFetch<{ ok: boolean }>(`/hooks/plugins/${encodeURIComponent(id)}/toggle`, {
      method: 'POST',
      body: JSON.stringify(projectId === undefined ? { enabled } : { enabled, projectId }),
    }).then(() => undefined),
  /** 安装插件（本地目录 | git URL）→ daemon 复制进全局插件根并立即重扫。 */
  installHookPlugin: (src: string): Promise<{ installed: Array<{ id: string }>; warnings: string[] }> =>
    apiFetch<{ installed: Array<{ id: string }>; warnings: string[] }>('/hooks/plugins', {
      method: 'POST',
      body: JSON.stringify({ src }),
    }),
  /** 卸载插件（删目录，规则随重扫级联移除）。 */
  uninstallHookPlugin: (id: string): Promise<void> =>
    apiFetch<{ ok: boolean }>(`/hooks/plugins/${encodeURIComponent(id)}/uninstall`, {
      method: 'POST',
    }).then(() => undefined),
  /** 手动重新扫描插件根：重登记根 → 重扫 → watcher 重挂（运行期新建的根由此纳管）。 */
  rescanHookPlugins: (): Promise<number> =>
    apiFetch<{ ok: boolean; plugins: number }>('/hooks/plugins/rescan', {
      method: 'POST',
    }).then((r) => r.plugins),
  // ---- 批 10 工具包（toolkit）----
  listToolkit: (projectId: number): Promise<ToolkitListResult> =>
    apiFetch<ToolkitListResult>(`/projects/${projectId}/toolkit`),
  toggleToolkit: (
    projectId: number,
    id: string,
    enabled: boolean,
    source?: string,
  ): Promise<ToolkitToggleResult> =>
    apiFetch<ToolkitToggleResult>(
      `/projects/${projectId}/toolkit/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}${
        source ? `?source=${encodeURIComponent(source)}` : ''
      }`,
      { method: 'POST' },
    ),
  cleanupToolkitLegacyCopies: (projectId: number): Promise<{ removed: string[] }> =>
    apiFetch<{ removed: string[] }>(`/projects/${projectId}/toolkit/legacy-copies/cleanup`, {
      method: 'POST',
    }),
  /** 卸载工具包（与 harness 对齐：CC 插件/mod 走 claude plugin uninstall，表面包清扫文件）。 */
  uninstallToolkit: (
    projectId: number,
    id: string,
    source?: string,
  ): Promise<ToolkitToggleResult> =>
    apiFetch<ToolkitToggleResult>(
      `/projects/${projectId}/toolkit/${encodeURIComponent(id)}/uninstall${
        source ? `?source=${encodeURIComponent(source)}` : ''
      }`,
      { method: 'POST' },
    ),
  listHookDispatches: (q?: {
    ruleId?: string;
    status?: HookDispatchStatus;
    sessionId?: string;
    limit?: number;
  }): Promise<HookDispatch[]> => {
    const params = new URLSearchParams();
    if (q?.ruleId) params.set('ruleId', q.ruleId);
    if (q?.status) params.set('status', q.status);
    if (q?.sessionId) params.set('sessionId', q.sessionId);
    if (q?.limit !== undefined) params.set('limit', String(q.limit));
    const qs = params.toString();
    return apiFetch<{ dispatches: HookDispatch[] }>(
      `/hooks/dispatches${qs ? `?${qs}` : ''}`,
    ).then((r) => r.dispatches);
  },
  /** 把指令池中的一条派发执行到指定会话（另一并行任务实现的路由）。 */
  runHookDispatch: (
    dispatchId: number,
    sessionId: string,
  ): Promise<{ ok: boolean; dispatchId: number }> =>
    apiFetch<{ ok: boolean; dispatchId: number }>(
      `/hooks/dispatches/${dispatchId}/run`,
      { method: 'POST', body: JSON.stringify({ sessionId }) },
    ),
  /** 不带 projectId 返回全部会话（最近活跃在前，最多 200 条）。 */
  listSessions: (projectId?: number): Promise<SessionRow[]> =>
    apiFetch<{ sessions: SessionRow[] }>(
      `/sessions${projectId === undefined ? '' : `?projectId=${projectId}`}`,
    ).then((r) => r.sessions),
  /** dashboard 改名：写 pendingTitle，下次 hook 下发时生效。 */
  renameSession: (sessionId: string, title: string): Promise<SessionRow> =>
    apiFetch<{ session: SessionRow }>(
      `/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'PATCH', body: JSON.stringify({ title }) },
    ).then((r) => r.session),
  /** 在默认终端打开会话（独立进程跑 `claude --resume <id>`，不随 daemon 退出）。
   *  `target` = 多终端弹窗选定的附加目标（`listProjectTerminals` 的 id）；缺省自动选落点。 */
  openSessionTerminal: (
    sessionId: string,
    target?: string,
  ): Promise<{ ok: boolean; command: string }> =>
    apiFetch<{ ok: boolean; command: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/open-terminal`,
      { method: 'POST', body: JSON.stringify(target ? { target } : {}) },
    ),
  /** 在项目**已打开的终端**里起一个新会话（服务端复用该项目目录的既有 pane；
   *  没有已开终端时 409——前置条件由服务端把关，前端置灰只是同一事实的镜像）。 */
  startProjectSession: (projectId: number): Promise<{ ok: boolean; command: string }> =>
    apiFetch<{ ok: boolean; command: string }>(`/projects/${projectId}/new-session`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  /** 会话终端的可附加目标（按最近活跃排序）：只 1 个时不弹窗、直接开。 */
  listProjectTerminals: (projectId: number): Promise<TerminalTarget[]> =>
    apiFetch<{ terminals: TerminalTarget[] }>(`/projects/${projectId}/terminals`).then(
      (r) => r.terminals,
    ),
  /** 删除会话：连带其采集事件与指令池派发（不可撤销）。 */
  deleteSession: (
    sessionId: string,
  ): Promise<{ ok: boolean; events: number; dispatches: number }> =>
    apiFetch<{ ok: boolean; events: number; dispatches: number }>(
      `/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    ),
  /** 会话消息线程（双向：发到该会话的 + 该会话发出的，升序最新 300 条）。 */
  listSessionMessages: (sessionId: string): Promise<SessionMessageRow[]> =>
    apiFetch<{ messages: SessionMessageRow[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/messages`,
    ).then((r) => r.messages),
  /** 投递消息到会话：恒 prompt 通道、全自动无模式入参（原生 SendMessage 中继 →
   *  终端 send-text 降级 → 未开会话积压队列）；层①② 皆无才 409，
   *  由 apiFetch 抛 Error（error 字段原文）。 */
  sendSessionMessage: (
    sessionId: string,
    body: { text: string },
  ): Promise<{ ok: boolean; messageId: string; status: string; message?: SessionMessageRow }> =>
    apiFetch(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** 手动重发（队列暂停闸的解除动作）：只对 prompt 通道 failed / delivered-未回执
   *  开放（其余 409、未知 404 由 apiFetch 抛 Error 原文）。 */
  resendSessionMessage: (
    sessionId: string,
    messageId: string,
  ): Promise<{ ok: boolean; messageId: string; status: string; message?: SessionMessageRow }> =>
    apiFetch(
      `/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/resend`,
      { method: 'POST' },
    ),
  /** 删除一条在途/终态消息行：该行不再出现在会话对话尾巴上（是暂停闸成因时
   *  删即解闸并续排空积压）；在飞（delivering/running）409、未知 404。 */
  dismissSessionMessage: (sessionId: string, messageId: string): Promise<{ ok: boolean }> =>
    apiFetch(`/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/dismiss`, {
      method: 'POST',
    }),
  /** 消息能力矩阵（服务端 MessagingSurface 纯派生，无第二事实源）。 */
  messagingCapabilities: (): Promise<MessagingCapability[]> =>
    apiFetch<{ capabilities: MessagingCapability[] }>('/messaging/capabilities').then(
      (r) => r.capabilities,
    ),
  /** 阻塞问答待答面（AskUserQuestion / 计划确认 / 权限确认的实时状态）。 */
  listQuestions: (): Promise<PendingQuestionEntry[]> =>
    apiFetch<{ questions: PendingQuestionEntry[] }>('/messaging/questions').then(
      (r) => r.questions,
    ),
  /** 远程作答：整 call 一次提交（只传问题键 + 选项下标，键序由服务端 harness
   *  规格拼装并白名单校验）。 */
  answerQuestion: (
    sessionId: string,
    answers: AnswerPick[],
  ): Promise<{ ok: boolean }> =>
    apiFetch(`/sessions/${encodeURIComponent(sessionId)}/answer`, {
      method: 'POST',
      body: JSON.stringify({ answers }),
    }),
  /** 中断：向会话 pane 打一记 ESC（停止正在跑的回合；键序固定死在服务端）。 */
  interruptSession: (sessionId: string): Promise<{ ok: boolean }> =>
    apiFetch(`/sessions/${encodeURIComponent(sessionId)}/interrupt`, { method: 'POST' }),
  /** 空闲订阅面（全部 pending——面板按 watcherSessionId===null 过滤本 dashboard 的）。 */
  listSessionWatches: (): Promise<SessionWatchRow[]> =>
    apiFetch<{ watches: SessionWatchRow[] }>('/messaging/watches').then((r) => r.watches),
  /** 订阅会话提醒；`on` = 触发类型集，`times` = 提醒次数（null = 持久化）。非 2xx 抛 Error。 */
  createSessionWatch: (
    sessionId: string,
    body: {
      watcherSessionId?: string | null;
      notify?: string | null;
      on?: WatchOn[];
      times?: number | null;
    } = {},
  ): Promise<{ ok: boolean; watchId: number; watch: SessionWatchRow }> =>
    apiFetch(`/sessions/${encodeURIComponent(sessionId)}/watch`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** 取消订阅。 */
  deleteSessionWatch: (sessionId: string, watchId: number): Promise<{ ok: boolean }> =>
    apiFetch(`/sessions/${encodeURIComponent(sessionId)}/watch`, {
      method: 'DELETE',
      body: JSON.stringify({ watchId }),
    }),
  /** Web Push：服务端 VAPID 公钥（pushManager.subscribe 的 applicationServerKey）。 */
  pushPublicKey: (): Promise<{ publicKey: string }> =>
    apiFetch<{ publicKey: string }>('/messaging/push/key'),
  /** 注册本浏览器的推送订阅（endpoint 由推送服务分配；同 endpoint 覆写）。 */
  pushSubscribe: (body: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }): Promise<{ ok: boolean }> =>
    apiFetch('/messaging/push/subscribe', { method: 'POST', body: JSON.stringify(body) }),
  /** 撤销推送订阅（设置页开关关向）。 */
  pushUnsubscribe: (endpoint: string): Promise<{ ok: boolean }> =>
    apiFetch('/messaging/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint }),
    }),
  /** 跨会话序列列表（新在前；编排画布用，全项目共用一张表）。 */
  listSessionSequences: (): Promise<SessionSequenceRow[]> =>
    apiFetch<{ sequences: SessionSequenceRow[] }>('/messaging/sequences').then(
      (r) => r.sequences,
    ),
  /** 触发序列（创建即执行步 0）。步数上限 3 = hop 上限、步级前置校验
   *  （404 会话不在 / 409 无通道）由服务端把关，非 2xx 抛 Error（error 字段原文）。 */
  createSequence: (body: {
    name?: string;
    steps: Array<{ to: string; text: string; mode?: 'prompt' | 'inject' | 'headless' | 'auto' }>;
  }): Promise<{ ok: boolean; sequence: SessionSequenceRow }> =>
    apiFetch('/messaging/sequences', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** 取消运行中的序列（非 running → 409 抛 Error）。 */
  cancelSequence: (id: number): Promise<{ ok: boolean }> =>
    apiFetch(`/messaging/sequences/${id}`, { method: 'DELETE' }),

  /** 安装属性矩阵（服务端 install/capabilities.ts 派生；拖拽/点击禁用共用）。 */
  capabilities: (): Promise<InstallCapabilities> =>
    apiFetch<InstallCapabilities>('/capabilities'),

  // --- libraries (asset sources) ---
  listLibraries: (): Promise<LibraryRow[]> =>
    apiFetch<{ libraries: LibraryRow[] }>('/libraries').then((r) => r.libraries),
  addLibrary: (path: string, kind: LibraryRow['kind']): Promise<LibraryRow> =>
    apiFetch<LibraryRow>('/libraries', {
      method: 'POST',
      body: JSON.stringify({ path, kind }),
    }),
  removeLibrary: (id: number): Promise<void> =>
    apiFetch<{ ok: boolean }>(`/libraries/${id}`, { method: 'DELETE' }).then(
      () => undefined,
    ),

  // --- 资源市场（批 9） ---
  listMarket: (): Promise<MarketItem[]> =>
    apiFetch<{ items: MarketItem[] }>('/market').then((r) => r.items),
  /** 本地目录引入（复制进 `<dataDir>/market/`）。 */
  importMarketDir: (path: string): Promise<MarketItem> =>
    apiFetch<{ item: MarketItem }>('/market', {
      method: 'POST',
      body: JSON.stringify({ kind: 'dir', path }),
    }).then((r) => r.item),
  /** git URL 导入（clone 进市场）。 */
  importMarketGit: (url: string): Promise<MarketItem> =>
    apiFetch<{ item: MarketItem }>('/market', {
      method: 'POST',
      body: JSON.stringify({ kind: 'git', url }),
    }).then((r) => r.item),
  /** 删除市场资源（只删市场目录与行，装面副本不级联；warning = 宿主市场注销
   *  失败的次要结果，副本仍已删除）。 */
  removeMarket: (id: number): Promise<{ warning?: string }> =>
    apiFetch<{ ok: boolean; warning?: string }>(`/market/${id}`, { method: 'DELETE' }),
  /** 批量检查市场缓存更新（M4）：比对 origin，只读不落库；缺省全量。 */
  checkMarketUpdates: (ids?: number[]): Promise<MarketUpdateCheck[]> =>
    apiFetch<{ results: MarketUpdateCheck[] }>('/market/check-updates', {
      method: 'POST',
      body: JSON.stringify(ids?.length ? { ids } : {}),
    }).then((r) => r.results),
  /** 刷新市场缓存（一键更新第一步）：dir 重拷 / git 重 clone。 */
  refreshMarketCache: (ids?: number[]): Promise<Array<{ id: number; status: string }>> =>
    apiFetch<{ results: Array<{ id: number; status: string }> }>('/market/refresh', {
      method: 'POST',
      body: JSON.stringify(ids?.length ? { ids } : {}),
    }).then((r) => r.results),
  /** legacy 外部源显式迁入市场（复制 + 改写为相对路径）。 */
  migrateLibrary: (id: number): Promise<MarketItem> =>
    apiFetch<{ item: MarketItem }>(`/libraries/${id}/market-import`, {
      method: 'POST',
    }).then((r) => r.item),
  /** Cross-platform browse roots for the directory picker modal. */
  listFsRoots: (): Promise<BrowseRoot[]> =>
    apiFetch<{ roots: BrowseRoot[] }>('/fs/roots').then((r) => r.roots),
  /** Subdirectories of a folder (lazy-loaded one level per call). */
  listFsChildren: (dirPath: string): Promise<BrowseChild[]> =>
    apiFetch<{ children: BrowseChild[] }>(
      `/fs/children?path=${encodeURIComponent(dirPath)}`,
    ).then((r) => r.children),

  // --- install / uninstall ---
  install: (projectId: number, body: InstallBody): Promise<Response> =>
    fetch(`${BASE}/projects/${projectId}/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  uninstall: (projectId: number, body: InstallBody): Promise<Response> =>
    fetch(`${BASE}/projects/${projectId}/uninstall`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),

  // --- file reader / mcp / statusline ---
  readFile: (projectId: number, relPath: string): Promise<ProjectFile> =>
    apiFetch<ProjectFile>(
      `/projects/${projectId}/file?path=${encodeURIComponent(relPath)}`,
    ),
  /** Read a machine-level harness file (same allowed roots as readFile). */
  readGlobalFile: (relPath: string): Promise<ProjectFile> =>
    apiFetch<ProjectFile>(`/global-file?path=${encodeURIComponent(relPath)}`),
  /** 每行一个 (harness, scope) 面，enable/effective/installScopes 由服务端算好。 */
  listMcp: (projectId: number): Promise<McpRow[]> =>
    apiFetch<{ rows: McpRow[] }>(`/projects/${projectId}/mcp`).then((r) => r.rows),
  getStatusline: (
    projectId: number,
  ): Promise<{ config: StatuslineConfig; script: string; globalConfig: StatuslineConfig }> =>
    apiFetch<{ config: StatuslineConfig; script: string; globalConfig: StatuslineConfig }>(
      `/projects/${projectId}/statusline`,
    ),
  putStatusline: (projectId: number, config: StatuslineConfig): Promise<Response> =>
    fetch(`${BASE}/projects/${projectId}/statusline`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    }),
  /** Shipped factory defaults for the statusline panel's 恢复出厂. */
  getFactoryStatusline: (): Promise<StatuslineConfig> =>
    apiFetch<{ config: StatuslineConfig }>('/statusline/default').then((r) => r.config),
  putGlobalStatusline: (config: StatuslineConfig): Promise<Response> =>
    fetch(`${BASE}/statusline/global`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    }),

  // --- updates / sync / global scope / mcp enable ---
  listUpdates: (projectId: number): Promise<UpdateReport> =>
    apiFetch<UpdateReport>(`/projects/${projectId}/updates`),
  updateAsset: (
    projectId: number,
    body: {
      category: 'skill' | 'mcp' | FileAssetCategory;
      name: string;
      scope: AssetScope;
      agent?: AssetAgent;
    },
  ): Promise<Response> =>
    fetch(`${BASE}/projects/${projectId}/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  syncAll: (projectId: number): Promise<Response> =>
    fetch(`${BASE}/projects/${projectId}/sync-all`, { method: 'POST' }),
  listGlobalSkills: (projectId: number): Promise<GlobalSkillGroup[]> =>
    apiFetch<{ groups: GlobalSkillGroup[] }>(`/projects/${projectId}/skills/global`).then(
      (r) => r.groups,
    ),
  /** List files inside a global skill directory (symlinks followed). The skill
   * is identified by source + name (+ pluginKey for plugins) so the server
   * resolves the dir — the client never supplies an arbitrary path. */
  listGlobalSkillFiles: (
    projectId: number,
    q: { source: GlobalSkillSource; name: string; pluginKey?: string },
  ): Promise<AssetEntry[]> => {
    const params = new URLSearchParams({ source: q.source, name: q.name });
    if (q.pluginKey) params.set('pluginKey', q.pluginKey);
    return apiFetch<{ files: AssetEntry[] }>(
      `/projects/${projectId}/skills/global/files?${params}`,
    ).then((r) => r.files);
  },
  /** Read a file inside a global skill directory (path relative to the skill). */
  readGlobalSkillFile: (
    projectId: number,
    q: { source: GlobalSkillSource; name: string; pluginKey?: string; path: string },
  ): Promise<ProjectFile> => {
    const params = new URLSearchParams({ source: q.source, name: q.name, path: q.path });
    if (q.pluginKey) params.set('pluginKey', q.pluginKey);
    return apiFetch<ProjectFile>(`/projects/${projectId}/skills/global/file?${params}`);
  },
  /** 插件工具行（每键 × 每可装档一行；effective/安装态服务端算好）。 */
  listPluginState: (projectId: number): Promise<PluginRow[]> =>
    apiFetch<{ rows: PluginRow[] }>(`/projects/${projectId}/plugins/state`).then(
      (r) => r.rows,
    ),
  putPluginState: (
    projectId: number,
    runtime: PluginRuntime,
    key: string,
    scope: ToolScope,
    state: EnableOverride,
  ): Promise<{ ok: boolean }> =>
    apiFetch<{ ok: boolean }>(`/projects/${projectId}/plugins/state`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtime, key, scope, state }),
    }),
  /** 卸载 CC 插件包（harness 级，按注册键；市场副本保留）。 */
  uninstallPluginPack: (
    projectId: number,
    body: { runtime: PluginRuntime; key: string },
  ): Promise<{ ok: boolean }> =>
    apiFetch<{ ok: boolean }>(`/projects/${projectId}/plugins/uninstall`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  putMcpEnable: (projectId: number, name: string, state: EnableOverride): Promise<{ ok: boolean }> =>
    apiFetch<{ ok: boolean }>(`/projects/${projectId}/mcp/enable`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, state }),
    }),
  getProjectConfig: (projectId: number): Promise<ProjectConfig> =>
    apiFetch<ProjectConfig>(`/projects/${projectId}/config`),
  /** Structured harness health checks (read-only; 批 8). */
  getHarnessChecks: (projectId: number): Promise<{ checks: HarnessCheck[] }> =>
    apiFetch<{ checks: HarnessCheck[] }>(`/projects/${projectId}/harness-checks`),
  /** Open a project directory in the OS file manager or a terminal. */
  openProject: (
    projectId: number,
    target: 'explorer' | 'terminal',
  ): Promise<{ ok: boolean; target: string; path: string }> =>
    apiFetch<{ ok: boolean; target: string; path: string }>(
      `/projects/${projectId}/open`,
      {
        method: 'POST',
        body: JSON.stringify({ target }),
      },
    ),
  /** Daemon-level settings (terminal preset) plus this platform's options. */
  getDaemonSettings: (): Promise<DaemonSettingsBundle> =>
    apiFetch<DaemonSettingsBundle>('/settings'),
  putDaemonSettings: (settings: DaemonSettings): Promise<DaemonSettings> =>
    apiFetch<DaemonSettings>('/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  /** user 档采集状态行（§6-2d：跨项目事件采集的地基）。 */
  getCapture: (): Promise<CaptureRow[]> =>
    apiFetch<{ rows: CaptureRow[] }>('/capture').then((r) => r.rows),
  putCapture: (harness: Harness, enabled: boolean): Promise<CaptureRow> =>
    apiFetch<CaptureRow>('/capture', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ harness, enabled }),
    }),
  putProjectConfig: (projectId: number, config: ProjectConfig): Promise<Response> =>
    fetch(`${BASE}/projects/${projectId}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    }),
  listLibraryAssets: (
    id: number,
  ): Promise<{
    library: LibraryRow;
    skills: SkillAsset[];
    files: FileAssetTemplate[];
    mcp: McpTemplate[];
    plugins: MarketPluginAsset[];
  }> =>
    apiFetch<{
      library: LibraryRow;
      skills: SkillAsset[];
      files: FileAssetTemplate[];
      mcp: McpTemplate[];
      plugins: MarketPluginAsset[];
    }>(`/libraries/${id}/assets`),

  eventsUrl: (): string => `${API_BASE}/events`,
};
