import { isHarness, type Harness } from '@weavecode/core';
import { permissionModeOf, type BlockingPromptSpec, type BlockingQuestion } from '@weavecode/harness';
import type { HookEventRepository } from '../repositories/hook-events.js';
import type { SessionRepository } from '../repositories/sessions.js';
import { blockingPromptFor } from '../surfaces.js';
import type { NormalizedHookPayload } from './types.js';

/**
 * 阻塞式问答跟踪器（内存态状态机）：从 ingest 事件流派生「会话正卡在等输入」
 * 的待答面（AskUserQuestion / 计划确认 / 权限确认），供 dashboard 展示与远程
 * 作答。为什么不走 hookBus 帧：帧域不带 toolName（frameFacts 只提 agent 事实），
 * 挂点必须在 handleIngestedRecords（解析后的 payload 在手）。
 *
 * 置位：PreToolUse(阻塞工具) / Notification(permission_prompt) / 事件弹框
 * （`spec.eventQuestion` 认出来的，如 claude 的「Switch model?」）；
 * 清除：PostToolUse(同名阻塞工具) 与 UserPromptSubmit/Stop（question 态），
 * permission 与 switch 态由任意后续非 Notification 事件清（对话框了结必有下文；
 * switch 的落定笔是 PostModelSwitch——答「No, go back」不发任何事件，留待下文清）。
 * daemon 重启由 seedFromDb 按最近事件窗口重放重建。
 *
 * 例外：卡在阻塞工具里时，该工具自己补发的 permission_prompt 不改写问题面——
 * 实测 claude 对 AskUserQuestion/ExitPlanMode 恒在 PreToolUse 后 ~6s 补发一条
 * permission_prompt（bypassPermissions 模式也发，即纯噪声；可重复发），若照单覆盖，
 * dashboard 会在用户思考的中途把真问题换成合成权限面（选项含义完全不同，答下去发错键序）。
 * 判据 = 该提醒归属 lastPreTool 且 lastPreTool 是阻塞工具：真权限对话框归属的是要批的
 * 那个工具（PreToolUse(PowerShell) → permission_prompt → PostToolUse(PowerShell)），
 * 归属非阻塞工具，照常置位，不会被误吞。
 *
 * 另一条：`bypassPermissions` 模式下 claude 根本不弹权限对话框（实测该模式所有
 * permission_prompt 都是噪声），一律忽略——模式由随事件到达的 raw.permission_mode
 * 逐条 latch（Notification 自带的 payload 不含此键，取最近一条带它的）。
 */

/** 会话当前的待答问题（内存态；事件流派生）。 */
export interface PendingQuestionEntry {
  sessionId: string;
  harness: Harness;
  /** question = 阻塞工具（问答/计划确认）；permission = 权限确认；switch = 模型切换确认。 */
  kind: 'question' | 'permission' | 'switch';
  questions: BlockingQuestion[];
  at: string;
}

/** 状态机输入（handleIngestedRecords 逐条喂给；seedFromDb 重放同形）。 */
export interface QuestionEventInput {
  sessionId: string;
  /** 事件源（harness 名）；未知源忽略。 */
  source: string;
  payload: NormalizedHookPayload | null;
}

export interface QuestionTrackerDeps {
  sessions: Pick<SessionRepository, 'list'>;
  hookEvents: Pick<HookEventRepository, 'listBySession'>;
  /** 能力面访问器（测试注入）；缺省 surfaces.ts 模块级 registry。 */
  surfaceFor?: (harness: Harness) => BlockingPromptSpec | null;
  /** 新挂起待答（无 → 有）时广播（dashboard 提醒）；不传 = 不广播。 */
  onPending?: (entry: PendingQuestionEntry) => void;
  /** 会话「已中断」时刻（ms；判据归 SessionProbe）。见 {@link QuestionTracker.dropIfInterrupted}。 */
  interruptedAt?: (sessionId: string) => number | null;
}

/** seed 重放窗口：最近事件条数（阻塞 Pre→Post 之间事件很少，12 足够覆盖）。 */
const SEED_WINDOW = 12;

export class QuestionTracker {
  /** sessionId → 待答面。 */
  private readonly pending = new Map<string, PendingQuestionEntry>();
  /** 权限确认的上下文（最近一次 PreToolUse）：Notification 不带工具面，从这补。 */
  private readonly lastPreTool = new Map<string, { toolName: string; toolInput: unknown }>();
  /** 会话当前权限模式（最近一条带 raw.permission_mode 的事件）。 */
  private readonly permissionMode = new Map<string, string>();
  /** seedFromDb 重放期间不广播（重建不是新发生）。 */
  private seeding = false;

  constructor(private readonly deps: QuestionTrackerDeps) {}

  private specOf(source: string): BlockingPromptSpec | null {
    if (!isHarness(source)) return null;
    return this.deps.surfaceFor?.(source) ?? blockingPromptFor(source);
  }

  /**
   * ingest 主路径（也供 seed 重放）：一个事件推进状态机。事件按到达序喂入
   * （ingest 的插入序 = 事件序），批内顺序由调用方保证。
   */
  onEvent(input: QuestionEventInput): void {
    const payload = input.payload;
    if (!payload) return;
    const spec = this.specOf(input.source);
    if (!spec) return;
    const sessionId = input.sessionId;
    const toolName = typeof payload.toolName === 'string' ? payload.toolName : null;
    const mode = permissionModeOf(payload.raw);
    if (mode) this.permissionMode.set(sessionId, mode);

    if (payload.eventType === 'PreToolUse') {
      if (toolName) {
        this.lastPreTool.set(sessionId, { toolName, toolInput: payload.toolInput });
      }
      if (toolName && spec.blockingTools.includes(toolName)) {
        const prev = this.pending.get(sessionId);
        const entry: PendingQuestionEntry = {
          sessionId,
          harness: this.harnessOf(input.source),
          kind: 'question',
          questions: spec.parseQuestions(toolName, payload.toolInput),
          at: new Date().toISOString(),
        };
        this.pending.set(sessionId, entry);
        // 只播「无 → 有」（同一会话连续挂起不重复打扰）；重放重建不算新发生。
        if (!this.seeding && prev?.kind !== 'question') this.deps.onPending?.(entry);
      }
      return;
    }
    if (payload.eventType === 'Notification') {
      if (
        spec.permissionNotificationType &&
        notificationTypeOf(payload.raw) === spec.permissionNotificationType
      ) {
        // 静默模式（名单归 harness 规格，如 claude 的 bypassPermissions）不弹对话框。
        const mode = this.permissionMode.get(sessionId);
        if (mode != null && spec.silentPermissionModes.includes(mode)) return;
        // 阻塞工具自己等输入期间补发的噪声提醒：问题面已在，别覆盖（见类注释）。
        // 判据两条件同时成立才压——只压「正卡在阻塞工具里、且这条提醒就是该工具自己」的
        // 情形；真权限对话框（lastPreTool = 待批工具）照常置位，不会被误吞。
        const last = this.lastPreTool.get(sessionId);
        if (
          this.pending.get(sessionId)?.kind === 'question' &&
          last != null &&
          spec.blockingTools.includes(last.toolName)
        ) {
          return;
        }
        const ctx = this.lastPreTool.get(sessionId) ?? { toolName: null, toolInput: null };
        this.pending.set(sessionId, {
          sessionId,
          harness: this.harnessOf(input.source),
          kind: 'permission',
          questions: [
            spec.permissionQuestion({
              ...ctx,
              message: messageOf(payload.raw),
              permissionMode: mode ?? null,
            }),
          ],
          at: new Date().toISOString(),
        });
      }
      return; // 其他 Notification（idle 等）不动状态
    }
    // 事件弹框（如 claude 的「Switch model?」、codex 的审批框）：问题面与「弹不弹」
    // 的判据都归 harness 规格——它说 null 就是不弹，这里绝不猜（幽灵问题会把键序
    // 打进输入框）。载荷传归一化视图（toolName/toolInput 在顶层；raw 的同名键已被
    // compactRaw 折叠成引用）。
    const face = spec.eventQuestion(payload.eventType, {
      raw: payload.raw,
      toolName,
      toolInput: payload.toolInput,
    });
    if (face) {
      const prev = this.pending.get(sessionId);
      const entry: PendingQuestionEntry = {
        sessionId,
        harness: this.harnessOf(input.source),
        kind: 'switch',
        questions: [face],
        at: new Date().toISOString(),
      };
      this.pending.set(sessionId, entry);
      if (!this.seeding && prev?.kind !== 'switch') this.deps.onPending?.(entry);
      return;
    }
    // 其余事件：待答面落定的信号。permission / switch 态任何动静都说明对话框已了结
    // （switch 的落定笔 = PostModelSwitch；答「No, go back」宿主不发事件，留待下文清）；
    // question 态只认阻塞工具的 PostToolUse（答完）或用户接管（UPS/Stop）。
    const entry = this.pending.get(sessionId);
    if (!entry) return;
    if (entry.kind !== 'question') {
      this.pending.delete(sessionId);
      this.lastPreTool.delete(sessionId);
      return;
    }
    const cleared =
      (payload.eventType === 'PostToolUse' &&
        toolName != null &&
        spec.blockingTools.includes(toolName)) ||
      payload.eventType === 'UserPromptSubmit' ||
      payload.eventType === 'Stop';
    if (cleared) {
      this.pending.delete(sessionId);
      this.lastPreTool.delete(sessionId);
    }
  }

  /** daemon 重启重建：每会话重放最近事件窗口，末态即当前待答面。 */
  seedFromDb(): void {
    this.seeding = true;
    try {
      for (const session of this.deps.sessions.list()) {
        for (const row of this.deps.hookEvents.listBySession(session.sessionId, SEED_WINDOW)) {
          let payload: NormalizedHookPayload | null = null;
          try {
            payload = JSON.parse(row.payload) as NormalizedHookPayload;
          } catch {
            payload = null;
          }
          this.onEvent({ sessionId: session.sessionId, source: row.source, payload });
        }
      }
    } finally {
      this.seeding = false;
    }
  }

  /** 待答面快照（新在前；GET /messaging/questions）。 */
  snapshot(): PendingQuestionEntry[] {
    return [...this.pending.values()]
      .filter((entry) => !this.dropIfInterrupted(entry))
      .sort((a, b) => (a.at < b.at ? 1 : -1));
  }

  /** 某会话的待答面（作答路由校验用）；无 = null。 */
  get(sessionId: string): PendingQuestionEntry | null {
    const entry = this.pending.get(sessionId);
    if (!entry) return null;
    return this.dropIfInterrupted(entry) ? null : entry;
  }

  /**
   * 已中断 ⇒ 待答面失据（**读时惰性判、顺手摘掉**，不另起定时器）。
   *
   * 用户在宿主里手动了结那个对话框（ESC / 选掉）之后，宿主既不发 PostToolUse 也不发
   * Stop（实测 45 次打断里 41 次连 Stop 都没有）——状态机收不到任何清除信号，而问题
   * 在终端里早已了结；继续摆着它，用户一点作答就是把键序打进已关的模态框、漏进输入框。
   * 判据只问一句 SessionProbe（标记晚于最后一条事件才算中断，之后任何事件都盖过它，
   * 故「中断」成立时那条问题一定早于标记）。摘掉而非只过滤：留着会在下一条事件把中断
   * 态盖掉之后重新冒出来。
   */
  private dropIfInterrupted(entry: PendingQuestionEntry): boolean {
    if (this.deps.interruptedAt?.(entry.sessionId) == null) return false;
    this.pending.delete(entry.sessionId);
    return true;
  }

  /**
   * 作答已发（乐观落位，防重复作答——键序若打进已关的模态框会漏进输入框）。
   * 整 call 一次提交（含 Submit 步），故整条摘除；PostToolUse 到达照常再清一次。
   */
  markAnswered(sessionId: string): void {
    this.pending.delete(sessionId);
  }

  /** 会话删除级联。 */
  forgetSession(sessionId: string): void {
    this.pending.delete(sessionId);
    this.lastPreTool.delete(sessionId);
    this.permissionMode.delete(sessionId);
  }

  private harnessOf(source: string): Harness {
    return source as Harness; // specOf 已验 isHarness
  }
}

/** Notification 的正文字段（raw.message）；缺键 / 空白 = null。 */
function messageOf(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const message = (raw as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() ? message : null;
}

/** Notification 的分类键（raw.notification_type）；非 Notification/缺键 = null。 */
function notificationTypeOf(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const type = (raw as { notification_type?: unknown }).notification_type;
  return typeof type === 'string' && type ? type : null;
}
