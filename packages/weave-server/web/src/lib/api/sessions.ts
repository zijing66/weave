/** 会话域：会话行、命令返显、计划、改动汇总、文件选择器与旁路会话。 */

import type { ModelAliasTarget } from '@weavecode/harness';
import type { Harness } from '@weavecode/core/harness';
import { apiFetch } from './client';
import type { SessionTerminal } from './projects';

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
  /** 该会话所在的**可见屏幕**（终端里的一块屏）；null = 反查不到（没分组信息）。 */
  terminal?: SessionTerminal | null;
  /** 已中断时刻（ms）：转录最后一条「请求被用户中断」标记晚于最后一条 hook 事件
   *  ——ESC 打断后多数连 Stop 都不发，这是该状态的唯一来源；null = 没中断。 */
  interruptedAt?: number | null;
  /** 当前模型（转录最后一条真跑过的 `message.model`）：换模型不发 hook 事件，只有
   *  转录照会；null = 不知道（不猜）。 */
  model?: string | null;
  /** 同一个模型的**别名**（`/model` 收的那个）：网关把别名换成自家 ID，转录里只见
   *  真名；null = 认不出（回落显示真名）。 */
  modelAlias?: string | null;
  /** 执行模式（转录最后一条 `permissionMode`）：Shift+Tab 不留痕，故是「最后已知」。 */
  mode?: string | null;
  /** 推理档位（hook 事件自带的 `effort.level`）：状态栏 `thinking` 块，最后已知。 */
  effort?: string | null;
  /** 上下文窗口占用（token 数，转录最后一条 assistant 的 usage 四项之和）：
   *  「上一轮完成时」的最后已知；没跑过一轮 / 没转录 = null。 */
  contextTokens?: number | null;
  /** 自动移除时刻（= lastSeenAt + 无操作保留窗；服务端 listWithCounts 派生，全会话
   *  统一）。服务端 SessionSweeper 过期即清，行内渲染剩余存活倒计时 tag。 */
  autoDeleteAt?: string | null;
  /** 转录还在不在（服务端 SessionProbe 判，与 `--resume` 认的那份文件对齐）：
   *  false = 接不回来了（行内提示、「打开」禁用），null/undefined = 判不动。 */
  transcriptPresent?: boolean | null;
  /** 「在终端打开」是否可用（服务端按 harness 的 resume 槽派生，web 不自带白名单）。 */
  canOpenTerminal?: boolean;
  /** 还没等到用户 prompt（1 小时快速过期档）：编排的会话选择器按它排除。 */
  promptless?: boolean;
}

/** GET /sessions 载荷：会话行 + 各 harness 的模型别名表（别名 → 真名）。 */
export interface SessionListResult {
  sessions: SessionRow[];
  modelCatalog: Record<string, ModelAliasTarget[]>;
}

/** `/` 提示里的一条命令（mirror of harness `HarnessCommand`）。 */
export interface HarnessCommandRow {
  /** 不含前导 `/`；插件/skill 带 `<plugin>:<skill>` 形态。 */
  name: string;
  description: string;
  argsHint?: string;
  source: 'builtin' | 'command' | 'skill' | 'plugin';
  /** 触发符（缺省 `/`）：codex 的 skill 是 `$name`。 */
  sigil?: '/' | '$';
}

/** 转录里的一条命令执行（返显；内建命令没有 hook 事件）。 */
export interface CommandExecutionRow {
  name: string;
  args: string;
  at: string;
  output?: string;
}

/** 计划模式交出的计划正文（最近一次 ExitPlanMode）：对话面当一条气泡摆出来批阅。 */
export interface SessionPlan {
  /** 提交那次工具调用的事件 id（气泡按它插进对话流）。 */
  eventId: number;
  at: string;
  text: string;
}

/** 一处改动（`before` → `after`）：宿主只给片段（Edit 的 old/new）就只摆片段。 */
export interface SessionEditHunk {
  before: string;
  after: string;
  at: string | null;
  /** 单处超长被服务端裁了尾巴 → 标「已截断」，不假装是全份。 */
  clamped?: true;
}

/** 按文件汇总的会话改动（GET /sessions/:id/edits）。`files` 为 null = 没有这份面 /
 *  读不到转录，`reason` 说明是哪一种（前端据此出「为什么这里什么都没有」）。 */
export interface SessionEdits {
  files: Array<{ path: string; hunks: SessionEditHunk[] }> | null;
  hunks: number;
  truncated: boolean;
  reason?: 'unsupported' | 'unreadable';
}

/** mirror of `RecognizedRef` in packages/weave-harness/src/driver.ts：一段现成文本里
 *  的一段引用。`start`/`end` 是它在原文里的字符区间，`ref` 是服务端归一后的表达式。 */
export interface RecognizedRef {
  start: number;
  end: number;
  ref: string;
  path: string;
  kind: 'file' | 'dir';
  lines?: { start: number; end: number };
}

/** 旁路会话（claude = /btw）的一条历史：问句由 weave 发出去时记下，回答由采集
 *  事件认领。`status` pending = 已打进会话等回答、answered = 认领到、timeout = 超窗。 */
export interface SideQuestionRow {
  id: number;
  sessionId: string;
  projectId: number | null;
  question: string;
  answer: string | null;
  answerEventId: number | null;
  status: 'pending' | 'answered' | 'timeout';
  askedAt: string;
  answeredAt: string | null;
}

export const sessionApi = {
  /** 不带 projectId 返回全部会话（最近活跃在前，最多 200 条）。 */
  listSessions: (projectId?: number): Promise<SessionListResult> =>
    apiFetch<SessionListResult>(
      `/sessions${projectId === undefined ? '' : `?projectId=${projectId}`}`,
    ),
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
  /** 关掉会话所在的 pane（退出会话：宿主随 pane 一起退出，会话行与对话照常保留，
   *  之后仍可用 --resume 接回）。找不到 pane / 终端没这个通道 → 409 中文修法。 */
  closeSessionPane: (sessionId: string): Promise<{ ok: boolean; sessionId: string }> =>
    apiFetch<{ ok: boolean; sessionId: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/close-pane`,
      { method: 'POST' },
    ),
  /** 删除会话：连带其采集事件与指令池派发（不可撤销）。 */
  deleteSession: (
    sessionId: string,
  ): Promise<{ ok: boolean; events: number; dispatches: number }> =>
    apiFetch<{ ok: boolean; events: number; dispatches: number }>(
      `/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    ),
  /** 聊天窗口 `/` 的命令候选（发现规则归 harness；supported=false = 没有命令面）。 */
  listSessionCommands: (sessionId: string): Promise<{ supported: boolean; commands: HarnessCommandRow[] }> =>
    apiFetch(`/sessions/${encodeURIComponent(sessionId)}/commands`),
  /** 命令执行的返显（内建命令不发 hook 事件，只有转录记着）。`executions: null` =
   *  该 harness 不记命令执行（前端如实说明）。 */
  listCommandExecutions: (
    sessionId: string,
  ): Promise<{ supported: boolean; executions: CommandExecutionRow[] | null }> =>
    apiFetch(`/sessions/${encodeURIComponent(sessionId)}/command-executions`),
  /** 最近一次计划模式交出的计划正文（无计划 / 正文已不可得 = null）。 */
  sessionPlan: (sessionId: string): Promise<SessionPlan | null> =>
    apiFetch<{ plan: SessionPlan | null }>(
      `/sessions/${encodeURIComponent(sessionId)}/plan`,
    ).then((r) => r.plan),
  /** 会话的改动汇总（按文件聚合；diff 由前端算）。没有该 harness 的提取面 / 读不到
   *  转录时 `files` 为 null。`range` = 按轮取数的窗口（语义 (since, until]，服务端
   *  判）；缺省 = 整段会话。 */
  sessionEdits: (sessionId: string, range?: { since?: string | null; until?: string | null }): Promise<SessionEdits> => {
    const qs = [
      range?.since ? `since=${encodeURIComponent(range.since)}` : '',
      range?.until ? `until=${encodeURIComponent(range.until)}` : '',
    ]
      .filter(Boolean)
      .join('&');
    return apiFetch<SessionEdits>(`/sessions/${encodeURIComponent(sessionId)}/edits${qs ? `?${qs}` : ''}`);
  },
  /** 反向认引用：一段现成文本（粘贴 / 取回队列）里哪些片段是引用、换成什么胶囊。
   *  文法归 harness、存在性归索引，前端拿到的已经是「区间 + 表达式」。 */
  recognizeRefs: (sessionId: string, text: string): Promise<RecognizedRef[]> =>
    apiFetch<{ refs: RecognizedRef[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/refs/recognize`,
      { method: 'POST', body: JSON.stringify({ text }) },
    ).then((r) => r.refs),
  /** 引用表达式：带行区间时由服务端按 harness 文法现算（`#L` 这类记号前端不拼）。 */
  sessionFileRef: (
    sessionId: string,
    opts: { path: string; kind?: 'file' | 'dir'; start?: number; end?: number },
  ): Promise<{ ref: string }> => {
    const params = new URLSearchParams({ path: opts.path });
    if (opts.kind) params.set('kind', opts.kind);
    if (opts.start != null) params.set('start', String(opts.start));
    if (opts.end != null) params.set('end', String(opts.end));
    return apiFetch<{ ref: string }>(`/sessions/${encodeURIComponent(sessionId)}/ref?${params.toString()}`);
  },
  /** 中断：向会话 pane 打一记 ESC（停止正在跑的回合；键序固定死在服务端）。 */
  /** 停止会话：`interrupted` 是宿主到底停没停（转录里有没有新标记）——null = 判不了。 */
  interruptSession: (sessionId: string): Promise<{ ok: boolean; interrupted?: boolean | null }> =>
    apiFetch(`/sessions/${encodeURIComponent(sessionId)}/interrupt`, { method: 'POST' }),
  /** 执行模式切换：一记 Shift+Tab，宿主自己算下一个模式（键序固定死在服务端）。 */
  cycleSessionMode: (sessionId: string): Promise<{ ok: boolean }> =>
    apiFetch(`/sessions/${encodeURIComponent(sessionId)}/mode`, { method: 'POST' }),
  /** 手动提交：一记回车，提交宿主输入框里现成的内容（键序固定死在服务端）。 */
  pressSessionEnter: (sessionId: string): Promise<{ ok: boolean }> =>
    apiFetch(`/sessions/${encodeURIComponent(sessionId)}/enter`, { method: 'POST' }),
  /** 手动硬中断：一记 Ctrl+C（不落转录标记，只报送出；键序固定死在服务端）。 */
  pressSessionCtrlC: (sessionId: string): Promise<{ ok: boolean }> =>
    apiFetch(`/sessions/${encodeURIComponent(sessionId)}/ctrl-c`, { method: 'POST' }),
  /** 模型切换：宿主自己的 `/model <名>`（会话级、不落盘）。名字用户自填，服务端只验形态。 */
  setSessionModel: (sessionId: string, model: string): Promise<{ ok: boolean }> =>
    apiFetch(`/sessions/${encodeURIComponent(sessionId)}/model`, {
      method: 'POST',
      body: JSON.stringify({ model }),
    }),
  /** 思考强度调整：宿主自己的 `/effort <档位>`；档位过 core 表词表白名单（服务端判）。 */
  setSessionEffort: (sessionId: string, level: string): Promise<{ ok: boolean }> =>
    apiFetch(`/sessions/${encodeURIComponent(sessionId)}/effort`, {
      method: 'POST',
      body: JSON.stringify({ level }),
    }),
  /** 旁路会话（claude = /btw）：问句经层② 终端打进会话 pane，服务端落一条历史行。 */
  askSideQuestion: (
    sessionId: string,
    question: string,
  ): Promise<{ ok: boolean; sideQuestion: SideQuestionRow }> =>
    apiFetch(`/sessions/${encodeURIComponent(sessionId)}/side-question`, {
      method: 'POST',
      body: JSON.stringify({ question }),
    }),
  /** 旁路历史（倒序游标翻页；`beforeId` = 上一页最早那条的 id）。 */
  listSideQuestions: (
    sessionId: string,
    opts: { beforeId?: number; limit?: number } = {},
  ): Promise<SideQuestionRow[]> => {
    const params = new URLSearchParams();
    if (opts.beforeId != null) params.set('beforeId', String(opts.beforeId));
    if (opts.limit != null) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return apiFetch<{ sideQuestions: SideQuestionRow[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/side-questions${qs ? `?${qs}` : ''}`,
    ).then((r) => r.sideQuestions);
  },
};
