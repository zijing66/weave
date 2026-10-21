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

/** 稳定窗：认领后行仍可被更高分候选替换的时长（实测真回答晚播报 13 秒到）。 */
export const SIDE_SETTLE_WINDOW_MS = 30_000;

export interface SideQuestionDeps {
  repo: SideQuestionRepository;
  bus?: HookEventBus;
  /** 能力面访问器（测试注入）；缺省 surfaces.ts 模块级 registry。 */
  surfaceFor?: (harness: Harness) => MessagingSurface;
  now?: () => number;
  /** 稳定窗落定后的收尾动作（关宿主 btw 面板 = 一记 ESC）。缺省 = 无。 */
  settle?: (row: SideQuestionRow) => void;
}

/** 一条入库事件（认领的输入面；payload = 解析后的归一化载荷）。 */
export interface SideQuestionEvent {
  sessionId: string;
  source: string;
  eventType: string;
  payload: unknown;
  eventId: number;
}

const HAS_HAN = /\p{Script=Han}/u;

/** 字符 bigram 集合（CJK 逐字、拉丁按相邻对）：短文本相似度的常规口径。 */
function bigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, '');
  const grams = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i++) grams.add(normalized.slice(i, i + 2));
  return grams;
}

/** Dice 系数：2·|Q∩A| / (|Q|+|A|)；任一侧为空 = 0。 */
function dice(question: string, candidate: string): number {
  const a = bigrams(question);
  const b = bigrams(candidate);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/**
 * 候选可信度（0–4，纯机械、可单测）：语种一致 +2、展开长度 +1、与问句
 * bigram 重叠 +1。相似度只当加分不当否决——好回答常换说法，播报也可能沾上
 * 问句词；否决交给 harness 判据（进度播报形态门已在 `answerOf`）。
 */
export function answerScore(question: string, candidate: string): number {
  let score = 0;
  if (HAS_HAN.test(question) === HAS_HAN.test(candidate)) score += 2;
  if (candidate.length >= 120) score += 1;
  if (dice(question, candidate) >= 0.15) score += 1;
  return score;
}

/** 稳定窗计时器（会话 → 行）：窗闭落定 + 收尾；被替换即重置。 */
const settleTimers = new Map<number, ReturnType<typeof setTimeout>>();

function scheduleSettle(deps: SideQuestionDeps, row: SideQuestionRow, now: number): void {
  const existing = settleTimers.get(row.id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(
    () => {
      settleTimers.delete(row.id);
      const fresh = deps.repo.getById(row.id);
      // 窗闭时行已被删（purge 级联）或又被人动过就不收尾；落定动作只此一处。
      if (fresh?.status === 'answered' && fresh.answerEventId === row.answerEventId) {
        deps.settle?.(fresh);
      }
    },
    Math.max(0, now + SIDE_SETTLE_WINDOW_MS - (deps.now?.() ?? Date.now())),
  );
  timer.unref?.();
}

/**
 * 采集事件 → 认领一条旁路回答。**判据归 harness 能力面**
 * （`SideQuestionSpec.answerOf`）：宿主的事件名、以及「哪类子 agent 没转录」
 * 都是 harness 知识，server 不认，也不猜。
 *
 * 认领即答（UI 立刻显示），但行在稳定窗内仍可被**更高分**候选替换
 * （严格大于，平分保持现任——先到者赢，保证稳定）：宿主的后台进度播报与真
 * 回答事件形状逐字节相同，播报恒先到，只靠 harness 形状门挡不住换文案的将来。
 * 窗闭落定才执行收尾（关 btw 面板那记 ESC）——误认领不再多打一记。
 */
export function claimSideAnswer(
  deps: SideQuestionDeps,
  input: SideQuestionEvent,
): SideQuestionRow | null {
  if (!isHarness(input.source)) return null;
  const surface = deps.surfaceFor?.(input.source) ?? messagingSurfaceFor(input.source);
  const answer = surface.sideQuestion?.answerOf(input.eventType, input.payload);
  if (!answer) return null;
  const now = deps.now?.() ?? Date.now();
  const since = new Date(now - SIDE_ANSWER_WINDOW_MS).toISOString();
  const row = deps.repo.claim(input.sessionId, answer, input.eventId, since);
  if (row) {
    emitAnswered(deps, row);
    scheduleSettle(deps, row, now);
    return row;
  }
  // 没有 pending 行：看稳定窗内有没有可替换的已答行（同会话、分数严格更高）。
  const settledAfter = new Date(now - SIDE_SETTLE_WINDOW_MS).toISOString();
  const incumbent = deps.repo
    .list(input.sessionId, { limit: 5 })
    .find((r) => r.status === 'answered' && (r.answeredAt ?? '') >= settledAfter);
  if (!incumbent || incumbent.answer == null) return null;
  if (answerScore(incumbent.question, answer) <= answerScore(incumbent.question, incumbent.answer)) {
    return null;
  }
  const replaced = deps.repo.supersede(incumbent.id, answer, input.eventId, settledAfter);
  if (!replaced) return null;
  emitAnswered(deps, replaced);
  scheduleSettle(deps, replaced, now);
  return replaced;
}

function emitAnswered(deps: SideQuestionDeps, row: SideQuestionRow): void {
  deps.bus?.emit({
    kind: 'sideQuestion.answered',
    sessionId: row.sessionId,
    sideQuestionId: row.id,
    at: row.answeredAt ?? new Date().toISOString(),
  });
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
