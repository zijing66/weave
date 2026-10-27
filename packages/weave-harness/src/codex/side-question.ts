import type { SideQuestionScreenSpec, SideQuestionSpec } from '../driver.js';

/** 提问原文上限（整行要打进侧边面板的输入框）。 */
const MAX_QUESTION_CHARS = 2_000;

/**
 * 单行、无控制字符：CR/LF 会提前提交、ESC/ctrl+c 会关面板——这行是要打进
 * pane 的输入框内容，混进控制符就成了任意键序。
 */
const QUESTION_SHAPE = /^[^\x00-\x1f\x7f]+$/;

/** 侧边面板开着的指纹（底条右侧，实测 0.164）。 */
const PANEL_OPEN_MARK = 'Side from main thread';

/** 回合跑动中的状态行（`• Working (3s • esc to interrupt)`）。 */
const WORKING_MARK = /•\s+Working\s*\(/;

/** 回合收尾行（`Worked for 7s • 14:31`）——回答块的下边界。 */
const WORKED_MARK = /^\s*Worked for\s+/;

/** 宿主附在回答块下的提示行（`└ Tip: …`）——不是回答正文。 */
const TIP_LINE = /^\s*└\s+Tip:/;

/** 输入行前缀（`› 问句` / `› Ask a follow-up question` 占位）。 */
const PROMPT_PREFIX = '› ';

/**
 * 从屏幕文本里取出「我们那条问句」之后的回答块。
 *
 * 屏幕文法（0.164 实测，多轮同屏累积）：
 * ```
 * › what is 2+2?          ← 问句行（PROMPT_PREFIX）
 * • 2+2 = 4               ← 回答块（• 前缀，可多行）
 *   └ Tip: …              ← 附加行（非正文）
 *   Worked for 7s • 14:31 ← 收尾行（下边界）
 * › Ask a follow-up …     ← 输入框占位
 * ```
 * 以 `before` 快照里没有的问句行锚定（用户手发的旧侧问不认），取它到
 * `Worked for` 行之间的 `•` 块。
 */
function answerBlockOf(question: string, before: string, now: string): string | null {
  const wanted = PROMPT_PREFIX + question;
  const lines = now.split('\n');
  // 锚点：问句行在 before 里没有（旧屏里同文案的问句行不算——重问同一句时
  // 取最后一条匹配，天然指向新一轮）
  let anchor = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line === wanted && !beforeIncludes(before, wanted)) {
      anchor = i;
      break;
    }
    if (line === wanted) {
      anchor = i;
      break;
    }
  }
  if (anchor < 0) return null;
  const out: string[] = [];
  for (let i = anchor + 1; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (!line) continue;
    if (WORKED_MARK.test(line)) break;
    if (WORKING_MARK.test(line)) return null; // 还在跑
    if (TIP_LINE.test(raw)) continue;
    if (line.startsWith(PROMPT_PREFIX.trim())) break; // 撞上输入框 = 回答块结束
    if (line.startsWith('•')) {
      out.push(line.replace(/^•\s*/, ''));
      continue;
    }
    // 块内的续行（长回答折行）原样收
    if (out.length > 0) out.push(line);
  }
  return out.length > 0 ? out.join('\n') : null;
}

/** before 快照里有没有这行（有 = 旧内容，不作锚点优先级提升）。 */
function beforeIncludes(before: string, line: string): boolean {
  return before.split('\n').some((l) => l.trim() === line);
}

/**
 * Codex 旁路会话面（`/side`，0.164 实测）：主线程发过消息后，`/side` 开侧边
 * 面板（父线程的 fork——继承历史作参考、子 agent 禁用、非变异探索为主），
 * 问句在面板输入框里提交，回答**只在屏幕上**（ephemeral：零落盘、零 hook
 * 事件、关面板即丢）。
 *
 * 回答只能读屏取：锚定我们发出的问句行，取它到 `Worked for` 收尾行之间的
 * `•` 块。收尾（关面板）前必须确认面板还开着——用户中途 ctrl+c 关掉后，
 * 再打 ctrl+c 会落进主线程语境（忙 = 中断确认菜单、闲 = 退出 TUI）。
 */
export const CODEX_SIDE_QUESTION: SideQuestionSpec = {
  command(question) {
    return question;
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

  // 零落盘零事件：事件认领路径（answerOf）对 codex 恒判不出——读屏通道是唯一信源
  answerOf() {
    return null;
  },

  prerequisite: '主线程至少发过一条消息后才能开侧边会话（宿主限制）',

  screen: {
    openKeys: '/side',
    submitKey: '\r',
    closeKey: '\x03',

    panelOpen(screen) {
      return screen.includes(PANEL_OPEN_MARK);
    },

    extractAnswer(question, before, now) {
      if (WORKING_MARK.test(now)) return { answer: null, done: false };
      const block = answerBlockOf(question, before, now);
      return { answer: block, done: true };
    },
  } satisfies SideQuestionScreenSpec,
};
