/** 消息域：投递管道视图、能力矩阵、阻塞问答、空闲订阅与 Web Push。 */

import type { Harness } from '@weavecode/core/harness';
import { apiFetch } from './client';
import type { UploadFile } from './uploads';

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
  /** 随附文件（上传件引用）；气泡缩略图的兜底源（历史在事件行的 `images` 上）。 */
  attachments?: UploadFile[];
  mode: 'prompt' | 'inject' | 'headless' | 'auto';
  /** 实际投递通道（auto 落定后回填；pending = 尚未裁决）。 */
  channel: 'prompt' | 'inject' | 'headless' | null;
  /** prompt 通道的实际落法（socket 直投 / 中继 / 终端 send-text）。 */
  via?: 'socket' | 'relay' | 'terminal' | null;
  /** 发送人强制走层② 终端（下拉选的通道）；重发沿用。 */
  forceTerminal?: boolean | null;
  status:
    | 'pending'
    | 'delivering'
    | 'running'
    | 'injected'
    | 'delivered'
    | 'succeeded'
    | 'failed'
    | 'timeout';
  /** 投递回执：目标会话自己的 UserPromptSubmit 与本文匹配上了（真到达）。 */
  acked?: boolean | null;
  /** 回执命中的那条开轮事件：对话面按它把投递行挂到对应气泡上（文案对不上也认得出）。 */
  ackedEventId?: number | null;
  /** 终态落定时刻（驻留窗口起点；在途态无值）。 */
  settledAt?: string | null;
  /** 本条 = 该会话队列暂停闸的成因（未回执超窗/投递失败）；重发或回执清除。 */
  stalled?: boolean | null;
  /** 判死而没投出去（会话进程不在、三层全无通路）= `failed` 的成因；web 据此出中文说明。 */
  reason?: 'offline' | null;
  /** 闸自动清除本行的时刻（只给「已发出却没回执」那种成因行）；web 拿它走倒计时。 */
  releaseAt?: string | null;
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
  /** 附件随 prompt 的对齐面收哪些类型（空 = 该 harness 不收附件，附件钮置灰）。 */
  attachKinds: ('image' | 'file')[];
  /** 项目内路径的引用文法（false = 该 harness 没有这种文法，文件钮置灰）。 */
  pathRefs: boolean;
  /** 该文法认不认行区间（false = 选择器只给整文件引用）。 */
  pathRefLines: boolean;
  /** 该文法能引用什么（无 `dir` = 目录行不摆「引用此文件夹」）。 */
  pathRefKinds: ('file' | 'dir')[];
  /** 旁路会话（侧问）通道（false = 该 harness 没有这种机制，入口不渲染）。 */
  sideQuestion: boolean;
  unsupportedReasons: Partial<
    Record<'discovery' | 'prompt' | 'inject' | 'headless' | 'watch' | 'sideQuestion' | 'pathRefs', string>
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
  /** 预览形态右栏原文（该选项被高亮时宿主显示的东西；不含预览的选项 = 宿主占位原文）。 */
  preview?: string | null;
  /** 预览形态：`keys` 只挪高亮，提交另需这一串（没选输入行时由服务端补在键序尾）。 */
  commit?: string[];
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
  /** 宿主预览形态（单选且任一选项带预览）：左右分栏（选项 | 预览）、自定义文本走
   *  `input` 备注行（宿主 `n` 那行）、**没有** Other 行；选项描述在这一形态里不渲染。 */
  previewMode?: boolean;
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
  /** question = AskUserQuestion/计划确认；permission = 权限确认；switch = 模型切换确认。 */
  kind: 'question' | 'permission' | 'switch';
  questions: PendingQuestion[];
  at: string;
}

export const messageApi = {
  /** 会话消息线程（双向：发到该会话的 + 该会话发出的，升序最新 300 条）。 */
  listSessionMessages: (sessionId: string): Promise<SessionMessageRow[]> =>
    apiFetch<{ messages: SessionMessageRow[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/messages`,
    ).then((r) => r.messages),
  /** 投递消息到会话：恒 prompt 通道、无模式入参（直投 → 终端 send-text → 中继
   *  降级 → 未开会话积压队列）；`forceTerminal` 收窄成只剩层② 终端击键——dashboard
   *  的手动对话恒带它（直投/中继不带发送方，宿主也不当用户输入）。层①② 皆无才
   *  409，由 apiFetch 抛 Error（error 字段原文）。 */
  sendSessionMessage: (
    sessionId: string,
    body: {
      text: string;
      attachments?: string[];
      forceTerminal?: boolean;
    },
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
  /** 阻塞提问前模型写下的说明（转录里认的；没在提问 / 没写字 = null）。 */
  sessionPreQuestion: (sessionId: string): Promise<{ at: string; text: string } | null> =>
    apiFetch<{ preQuestion: { at: string; text: string } | null }>(
      `/sessions/${encodeURIComponent(sessionId)}/pre-question`,
    ).then((r) => r.preQuestion),
  /** 旁白：模型在一轮里的全部 assistant 正文（转录里认的；无该面 / 读不到 = null）。 */
  sessionNarration: (sessionId: string): Promise<Array<{ at: string | null; text: string }> | null> =>
    apiFetch<{ supported: boolean; narration: Array<{ at: string | null; text: string }> | null }>(
      `/sessions/${encodeURIComponent(sessionId)}/narration`,
    ).then((r) => r.narration),
  /** 对话回退锚点（宿主 rewind 在转录里留的；无该面 / 读不到 = null）。 */
  sessionRewinds: (sessionId: string): Promise<Array<{ at: string; boundaryAt: string | null }> | null> =>
    apiFetch<{ supported: boolean; rewinds: Array<{ at: string; boundaryAt: string | null }> | null }>(
      `/sessions/${encodeURIComponent(sessionId)}/rewinds`,
    ).then((r) => r.rewinds),
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
};
