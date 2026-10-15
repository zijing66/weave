import { isHarness, type Harness } from '@weavecode/core';
import type { BlockingPromptSpec, BlockingQuestion } from '@weavecode/harness';
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
 * 置位：PreToolUse(阻塞工具) / Notification(permission_prompt)；
 * 清除：PostToolUse(同名阻塞工具) 与 UserPromptSubmit/Stop（question 态），
 * permission 态由任意后续非 Notification 事件清（对话框了结必有下文）。
 * daemon 重启由 seedFromDb 按最近事件窗口重放重建。
 */

/** 会话当前的待答问题（内存态；事件流派生）。 */
export interface PendingQuestionEntry {
  sessionId: string;
  harness: Harness;
  /** question = 阻塞工具（问答/计划确认）；permission = 权限确认对话框。 */
  kind: 'question' | 'permission';
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
}

/** seed 重放窗口：最近事件条数（阻塞 Pre→Post 之间事件很少，12 足够覆盖）。 */
const SEED_WINDOW = 12;

export class QuestionTracker {
  /** sessionId → 待答面。 */
  private readonly pending = new Map<string, PendingQuestionEntry>();
  /** 权限确认的上下文（最近一次 PreToolUse）：Notification 不带工具面，从这补。 */
  private readonly lastPreTool = new Map<string, { toolName: string; toolInput: unknown }>();

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

    if (payload.eventType === 'PreToolUse') {
      if (toolName) {
        this.lastPreTool.set(sessionId, { toolName, toolInput: payload.toolInput });
      }
      if (toolName && spec.blockingTools.includes(toolName)) {
        this.pending.set(sessionId, {
          sessionId,
          harness: this.harnessOf(input.source),
          kind: 'question',
          questions: spec.parseQuestions(toolName, payload.toolInput),
          at: new Date().toISOString(),
        });
      }
      return;
    }
    if (payload.eventType === 'Notification') {
      if (
        spec.permissionNotificationType &&
        notificationTypeOf(payload.raw) === spec.permissionNotificationType
      ) {
        const ctx = this.lastPreTool.get(sessionId) ?? { toolName: null, toolInput: null };
        this.pending.set(sessionId, {
          sessionId,
          harness: this.harnessOf(input.source),
          kind: 'permission',
          questions: [spec.permissionQuestion(ctx)],
          at: new Date().toISOString(),
        });
      }
      return; // 其他 Notification（idle 等）不动状态
    }
    // 其余事件：待答面落定的信号。permission 态任何动静都说明对话框已了结；
    // question 态只认阻塞工具的 PostToolUse（答完）或用户接管（UPS/Stop）。
    const entry = this.pending.get(sessionId);
    if (!entry) return;
    if (entry.kind === 'permission') {
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
  }

  /** 待答面快照（新在前；GET /messaging/questions）。 */
  snapshot(): PendingQuestionEntry[] {
    return [...this.pending.values()].sort((a, b) => (a.at < b.at ? 1 : -1));
  }

  /** 某会话的待答面（作答路由校验用）；无 = null。 */
  get(sessionId: string): PendingQuestionEntry | null {
    return this.pending.get(sessionId) ?? null;
  }

  /**
   * 作答已发（乐观落位，防重复作答——键序若打进已关的模态框会漏进输入框）；
   * 多问题面只摘答的那问，PostToolUse 到达时照常整条清除。
   */
  markAnswered(sessionId: string, questionKey: string): void {
    const entry = this.pending.get(sessionId);
    if (!entry) return;
    const rest = entry.questions.filter((q) => q.key !== questionKey);
    if (rest.length === 0) this.pending.delete(sessionId);
    else this.pending.set(sessionId, { ...entry, questions: rest });
  }

  /** 会话删除级联。 */
  forgetSession(sessionId: string): void {
    this.pending.delete(sessionId);
    this.lastPreTool.delete(sessionId);
  }

  private harnessOf(source: string): Harness {
    return source as Harness; // specOf 已验 isHarness
  }
}

/** Notification 的分类键（raw.notification_type）；非 Notification/缺键 = null。 */
function notificationTypeOf(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const type = (raw as { notification_type?: unknown }).notification_type;
  return typeof type === 'string' && type ? type : null;
}
