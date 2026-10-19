import { isHarness, type Harness } from '@weavecode/core';
import type { MessagingSurface } from '@weavecode/harness';
import { messagingSurfaceFor } from '../surfaces.js';
import type { SideQuestionRepository, SideQuestionRow } from '../repositories/side-questions.js';
import type { HookEventBus } from './bus.js';

/**
 * 旁路会话域（claude = `/btw`）的 server 侧协调：send 归 `MessageDeliverer`
 * （终端文本通道），认领归这里。
 *
 * 为什么必须自己记：宿主的侧问查询开着 `skipTranscript`——问题与回答都**不落
 * 任何文件**（面板历史只在宿主内存里），故问句只有 weave 自己发出去时才知道。
 * 回答倒是会以采集事件回来，但事件会按保留策略清掉，而这条问答是用户的历史。
 */

/** 回答窗口：超过这个时间还没认领到回答就落 timeout（宿主面板可能被 Esc 关掉、
 *  主回合可能已经收尾）——同一窗口也用作认领下界，迟到的回答不认领旧行。 */
export const SIDE_ANSWER_WINDOW_MS = 10 * 60_000;

export interface SideQuestionDeps {
  repo: SideQuestionRepository;
  bus?: HookEventBus;
  /** 能力面访问器（测试注入）；缺省 surfaces.ts 模块级 registry。 */
  surfaceFor?: (harness: Harness) => MessagingSurface;
  now?: () => number;
}

/** 一条入库事件（认领的输入面；payload = 解析后的归一化载荷）。 */
export interface SideQuestionEvent {
  sessionId: string;
  source: string;
  eventType: string;
  payload: unknown;
  eventId: number;
}

/**
 * 采集事件 → 认领一条旁路回答。**判据归 harness 能力面**
 * （`SideQuestionSpec.answerOf`）：宿主的事件名、以及「哪类子 agent 没转录」
 * 都是 harness 知识，server 不认，也不猜。
 */
export function claimSideAnswer(
  deps: SideQuestionDeps,
  input: SideQuestionEvent,
): SideQuestionRow | null {
  if (!isHarness(input.source)) return null;
  const surface = deps.surfaceFor?.(input.source) ?? messagingSurfaceFor(input.source);
  const answer = surface.sideQuestion?.answerOf(input.eventType, input.payload);
  if (!answer) return null;
  const since = new Date((deps.now?.() ?? Date.now()) - SIDE_ANSWER_WINDOW_MS).toISOString();
  const row = deps.repo.claim(input.sessionId, answer, input.eventId, since);
  if (!row) return null;
  deps.bus?.emit({
    kind: 'sideQuestion.answered',
    sessionId: row.sessionId,
    sideQuestionId: row.id,
    at: row.answeredAt ?? new Date().toISOString(),
  });
  return row;
}

/** 历史列表（游标向前翻页）：先把超窗的 pending 落定，再读——不另起定时器。 */
export function readSideQuestions(
  deps: SideQuestionDeps,
  sessionId: string,
  opts: { beforeId?: number; limit: number },
): SideQuestionRow[] {
  deps.repo.expirePending(
    new Date((deps.now?.() ?? Date.now()) - SIDE_ANSWER_WINDOW_MS).toISOString(),
  );
  return deps.repo.list(sessionId, opts);
}
