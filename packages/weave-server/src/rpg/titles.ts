import { type WeaveTitleType } from '@weavecode/core';

/**
 * 自动化命名铁则（G6，RPG 稿 §八）唯一拼装点：weave 自动起的会话 title 恒走
 * `[weave] <类型>·<主体>·<语境>`——类型词表 = core `WEAVE_TITLE_TYPES`（新自动
 * 化入口加类型先加词表行，然后从这里拼）。全自动化入口禁止散拼 `[weave]` 字符串。
 *
 * 身份牌不是枷锁：title 只在起手/认领那一拍写；用户手动重命名后 weave 不再覆盖
 * （认领是一次性事实——pending 消费完不再写，手动改名落在其后）。
 */
export function weaveTitle(input: { type: WeaveTitleType; subject: string; cue: string }): string {
  const cue = input.cue.trim();
  return `[weave] ${input.type}·${input.subject}${cue ? `·${cue}` : ''}`;
}
