import { existsSync } from 'node:fs';
import type { SideQuestionSpec } from '../driver.js';

/** 提问原文上限（宿主把整行当输入框内容收；再长就没法一行提交了）。 */
const MAX_QUESTION_CHARS = 2_000;

/**
 * 单行、无控制字符：CR/LF 会提前提交、ESC 会关面板——这行是要打进 pane 的
 * 输入框内容，混进控制符就成了任意键序。
 */
const QUESTION_SHAPE = /^[^\x00-\x1f\x7f]+$/;

/**
 * 压缩摘要的形状（`<analysis>…</analysis><summary>…</summary>`）：压缩的摘要
 * 子 agent 同样 `skipTranscript`，事件形状与侧问一模一样。不排掉它，压缩正好
 * 落在一次待答窗口里就会被认领成侧问的回答。
 */
const COMPACT_SUMMARY_HEAD = /^<(?:analysis|summary)>/;

/**
 * 后台任务进度播报的形态：宿主给后台子任务的 narration fork 同样 skipTranscript
 * （无转录文件），事件与侧问回答同形状——不加门它先到就抢答（实测一次：真回答
 * 晚 13 秒到、被静默丢弃）。播报恒为单行英文短句、以进行体动词开头，且无 CJK；
 * 真回答是完整内容（长句 / 中文 / 多行），落不进这四条合取。词表来自实机采集，
 * 宿主换文案时靠真回答的完整性兜底。
 */
const PROGRESS_VERBS =
  'exploring|reviewing|inspecting|tracing|checking|locating|reporting|summarizing|examining|reading|searching|scanning|analyzing|investigating|fetching|loading|probing|auditing|mapping|listing|comparing|verifying|testing|extracting|processing|measuring|assessing|evaluating|identifying|confirming|drafting|refactoring|debugging|grepping';
const PROGRESS_NOTE_HEAD = new RegExp(`^[\\p{P}\\s]*(${PROGRESS_VERBS})\\b`, 'iu');
const HAS_CJK = /\p{Script=Han}/u;

const isProgressNote = (text: string): boolean =>
  !text.includes('\n') && text.length <= 80 && !HAS_CJK.test(text) && PROGRESS_NOTE_HEAD.test(text);

const pick = (raw: unknown, key: string): unknown =>
  raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[key] : undefined;

/**
 * Claude 旁路会话面（`/btw`）：往输入行打 `/btw <原文>` 即开一次侧问——不打断
 * 主回合、宿主用一个 `maxTurns:1` 的轻量 fork 作答。
 *
 * 回答只能从采集事件里认：宿主给这类 fork 的查询开着 `skipTranscript`，**既不
 * 留转录、也不发 prompt 事件**。判据 = `SubagentStop` 且 `agent_transcript_path`
 * 在盘上不存在——普通子 agent 与 skill 子 agent 都有转录文件（实测），没有的
 * 只剩 skipTranscript 那批 fork（侧问 / 压缩摘要 / 后台摘要，后两类由上一条
 * 形状闸与「只认待答行」两道挡掉）。
 */
export const CLAUDE_SIDE_QUESTION: SideQuestionSpec = {
  command(question) {
    return `/btw ${question}`;
  },

  validate(question) {
    const text = question.trim();
    if (!text) return { ok: false, error: '问题不能为空' };
    if (text.length > MAX_QUESTION_CHARS) {
      return { ok: false, error: `问题过长（上限 ${MAX_QUESTION_CHARS} 字符）` };
    }
    if (!QUESTION_SHAPE.test(text)) {
      return { ok: false, error: '问题不能含换行或控制字符（会提前提交）' };
    }
    return { ok: true, text };
  },

  answerOf(eventType, payload) {
    if (eventType !== 'SubagentStop') return null;
    const raw = pick(payload, 'raw');
    const transcript = pick(raw, 'agent_transcript_path');
    // 有转录 = 普通子 agent 的收尾报告，不是侧问；键缺失（老版本）= 判不动，一律不认领
    if (typeof transcript !== 'string' || !transcript || existsSync(transcript)) return null;
    const answer = pick(raw, 'last_assistant_message');
    if (typeof answer !== 'string') return null;
    const text = answer.trim();
    return text && !COMPACT_SUMMARY_HEAD.test(text) && !isProgressNote(text) ? text : null;
  },
};
