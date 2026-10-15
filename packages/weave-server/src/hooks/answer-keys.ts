import type { BlockingQuestion } from '@weavecode/harness';

/**
 * 阻塞问答的作答拼装：整 call 一次提交——面顺序（= 宿主 tab 顺序）逐问把选项
 * 键序接成**原子序列**，由 deliverer 逐个打进 pane。
 *
 * 键序形态全归 harness 规格（选项 keys / textFocus / textTail），这里只做三件
 * 结构判断（都是实机口径）：
 * - 未作答的问题要补一记 Tab 走过去——宿主允许空作答，但不走开的话下一个问题的
 *   数字会落在上一个 tab 上；
 * - 多选勾选不推进焦点（单选数字自带推进、输入行尾键自带推进），故多选答完也要 Tab；
 * - `chat` 行与收尾屏（Submit）结束整 call，后面的键不能再打（会落进聊天输入框）。
 */

/** 一问的作答（web 只送下标与文本，键序由服务端按面拼）。 */
export interface AnswerPick {
  questionKey: string;
  /** 选中的选项下标（面顺序，空 = 未作答）。 */
  options: number[];
  /** 自定义输入行的文本（仅当选中了 `input` 行）。 */
  text?: string;
}

export type ComposeResult = { ok: true; atoms: string[] } | { ok: false; error: string };

/** Tab = 下一个 tab（跳过未作答的问题 / 多选勾完走下一个 tab）。 */
const TAB = '\t';

export function composeAnswerAtoms(
  questions: readonly BlockingQuestion[],
  picks: readonly AnswerPick[],
): ComposeResult {
  if (questions.every((q) => q.options.length === 0)) {
    return { ok: false, error: 'Question face has no answerable options' };
  }
  const byKey = new Map(picks.map((p) => [p.questionKey, p]));
  for (const key of byKey.keys()) {
    if (!questions.some((q) => q.key === key)) {
      return { ok: false, error: `Unknown question: ${key}` };
    }
  }
  const atoms: string[] = [];
  for (const q of questions) {
    const pick = byKey.get(q.key);
    const chosen = (pick?.options ?? []).map((i) => q.options[i]);
    if (chosen.some((o) => !o)) return { ok: false, error: `Invalid option index: ${q.key}` };
    if (q.submit && chosen.length !== 1) {
      return { ok: false, error: 'Submit choice required to finish the call' };
    }
    if (!q.multiSelect && chosen.length > 1) {
      return { ok: false, error: `Single-select question got ${chosen.length} options: ${q.key}` };
    }
    const text = pick?.text?.trim() ?? '';
    const input = chosen.find((o) => o.input);
    if (input && !text) return { ok: false, error: `Text required for this option: ${q.key}` };
    for (const option of chosen) atoms.push(...option!.keys);
    if (input) atoms.push(...(input.textFocus ?? []), text, ...(input.textTail ?? ['\r']));
    // chat 行结束整个提问、收尾屏落定整 call —— 后面的键都会落进聊天输入框。
    if (q.submit || chosen.some((o) => o.chat)) break;
    // 输入行的尾键自带推进（回车 / 内联 Submit）；多选勾选与空作答没有，要手动走。
    if (!input && (q.multiSelect || chosen.length === 0)) atoms.push(TAB);
  }
  return { ok: true, atoms };
}
