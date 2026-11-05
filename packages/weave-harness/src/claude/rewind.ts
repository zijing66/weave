import type { RewindSurface, RewindMark, RewindPoint } from '../driver.js';
import { readNewLines, transcriptSize, type LineCursor } from './transcript-cursor.js';
import { CLAUDE_REWIND_PICKER } from './rewind-ui.js';

/**
 * 回退（claude）：用户在宿主里 Esc Esc / `/rewind` 把对话退回历史某条消息后，
 * 转录是 append-only 日志——**确认回退本身零写入**（2.1.296 实测：对话框按 1
 * 之后文件一个字节没变），下一次提交也照常接在文件尾（parentUuid 指向前一行，
 * 不写新根、不写 `rewound` 标记、不写 `logicalParentUuid`）。唯一痕迹是宿主
 * 自己的轮次计数：**`turnPosition.promptIndex` 被重置到退完后剩下的轮数 +1**
 * （实测退到第一条后连发三条，三条全是 `promptIndex:1`）。
 *
 * ⇒ 判据两条：`promptIndex` **严格下降**（退回更早的轮），或**相等但上一轮
 * 已收尾**（退回的正是最后一轮——计数退到同一个值）。同轮排队连发也相等，
 * 故必须借「这一轮已经结束」（`turn_duration` / 中断行）把它排除；weave 自己
 * 与别的会话注入的消息同样复用轮次计数，按前缀剔除，不参与判据。
 *
 * 退到的值 p 表示「退完剩 p-1 轮」，故被退掉的区间 = 旧状态第 p 轮起到新消息
 * 之前：`boundaryAt` = 第 p 轮（第一条被退掉的 prompt）的时刻（含），`at` =
 * 新 prompt 的时刻（不含）。气泡时刻落在 [boundaryAt, at) 即被回退。
 */
export function stepRewind(state: RewindState, line: string): void {
  // 排队后被「吸收」的消息不带 turnPosition，宿主面板却照样列出它 ⇒ 单独认。
  if (line.includes('"queued_command"')) {
    stepQueued(state, line);
    return;
  }
  // 预筛：只有带 turnPosition 的 user 行才值得 parse（转录动辄几十 MB）；
  // 其余行只认「这一轮结束了」的收尾笔（正常收尾 = turn_duration，被打断 = 中断行）。
  if (!line.includes('"turnPosition"')) {
    if (line.includes('"turn_duration"') || line.includes('Request interrupted by user')) {
      state.turnEnded = true;
    }
    return;
  }
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (entry.type !== 'user' || entry.isSidechain === true) return;
  if (isSyntheticPrompt(entry)) {
    state.turnEnded = false;
    return;
  }
  const tp = entry.turnPosition as { promptIndex?: unknown } | undefined;
  const p = tp?.promptIndex;
  const ts = entry.timestamp;
  if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || typeof ts !== 'string') return;
  // 严格下降 = 退回到更早的轮；相等且上一轮已收尾 = 退回最后一轮重发（计数不变，
  // 故靠「上一轮已结束」把同轮排队连发排除掉）。
  const rewound = state.prevP !== null && (p < state.prevP || (p === state.prevP && state.turnEnded));
  if (rewound && state.turns.length >= p) {
    const cut = state.turns[p - 1]?.at ?? null;
    state.marks.push({ at: ts, boundaryAt: cut });
    state.turns = state.turns.slice(0, p - 1);
    // 消息表按时间裁（排队消息没有轮次号，只能拿轮边界当时间线）
    const cutAt = cut === null ? Infinity : Date.parse(cut);
    state.messages = state.messages.filter((m) => Date.parse(m.at) < cutAt);
  }
  const turn = { at: ts, text: promptTextOf(entry) };
  state.messages.push(turn);
  if (state.turns.length === p - 1) state.turns.push(turn);
  else if (state.turns.length < p - 1) state.turns = new Array<Turn | null>(p - 1).fill(null).concat(turn);
  state.prevP = p;
  state.turnEnded = false;
}

/** 排队消息（`attachment.queued_command`）：宿主把它当用户消息列进回退面板，但没有轮次号。 */
function stepQueued(state: RewindState, line: string): void {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (entry.type !== 'attachment' || entry.isSidechain === true) return;
  const att = entry.attachment as { type?: unknown; prompt?: unknown } | undefined;
  if (att?.type !== 'queued_command' || typeof att.prompt !== 'string') return;
  const ts = entry.timestamp;
  if (typeof ts !== 'string') return;
  if (isSyntheticText(att.prompt)) return;
  state.messages.push({ at: ts, text: att.prompt });
}

/** 一条 prompt 的正文（字符串或 text block 拼接；面板只认这些）。 */
function promptTextOf(entry: Record<string, unknown>): string {
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) =>
      (b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text) : '',
    )
    .join('');
}

/**
 * 不是用户发的轮：压缩续跑 / 摘要，以及 weave 自己或别的会话注入的消息——它们
 * 复用当前轮次计数（实测同一轮里能连着落十几条），不参与判据。
 */
const SYNTHETIC_PREFIX =
  /^(This session is being continued from a previous conversation|\[weave message\]|Another Claude session sent a message|\[Cross-session idle notice\]|\[Cross-session message\]|<task-notification>|<command-|<bash-|<local-command|Check background task)/;

function isSyntheticPrompt(entry: Record<string, unknown>): boolean {
  if (entry.isCompactSummary === true) return true;
  return isSyntheticText(promptTextOf(entry));
}

function isSyntheticText(text: string): boolean {
  return SYNTHETIC_PREFIX.test(text);
}

interface Turn {
  /** 该条消息的转录时刻。 */
  at: string;
  /** 该条消息的正文（回退面板的列表内容从这来，不读屏）。 */
  text: string;
}

export interface RewindState {
  /** 当前分支的各轮首条（null = 计数跳档后补的空位，表示这段历史不可知）。 */
  turns: Array<Turn | null>;
  /**
   * 当前分支的**每条**用户消息（含排队后被吸收的），顺序即宿主面板的顺序。
   * 面板按消息列、不按轮列，故 points 取这份而不是 `turns`。
   */
  messages: Turn[];
  /** 上一条 prompt 的 promptIndex（同一轮连发时不变）。 */
  prevP: number | null;
  /** 上一条 prompt 之后这一轮是否已收尾（相等计数靠它区分「回退重发」与「同轮排队连发」）。 */
  turnEnded: boolean;
  marks: RewindMark[];
}

/**
 * 按**字节游标**增量累积：轮次表与 marks 跟着游标一起存。
 * 文件被截断/换掉 ⇒ 状态一并作废，从头再来。
 */
const cursors = new Map<string, { cur: LineCursor } & RewindState>();
const CURSOR_MAX = 64;

/** 把游标推到文件尾（回退标记与回退点共用这一份状态）。null = 这一刻读不到。 */
function syncCursor(transcriptPath: string | null): RewindState | null {
  if (!transcriptPath) return null;
  const size = transcriptSize(transcriptPath);
  if (size === null) {
    cursors.delete(transcriptPath);
    return null;
  }
  const hit = cursors.get(transcriptPath);
  cursors.delete(transcriptPath);
  const entry = hit ?? {
    cur: { offset: 0 },
    turns: [],
    messages: [],
    prevP: null,
    turnEnded: false,
    marks: [],
  };
  if (size < entry.cur.offset) {
    entry.cur.offset = 0;
    entry.turns = [];
    entry.messages = [];
    entry.prevP = null;
    entry.turnEnded = false;
    entry.marks = [];
  }
  const lines = readNewLines(transcriptPath, entry.cur, size);
  if (lines === null) return null;
  for (const line of lines) stepRewind(entry, line);
  if (cursors.size >= CURSOR_MAX) {
    const oldest = cursors.keys().next().value;
    if (oldest !== undefined) cursors.delete(oldest);
  }
  cursors.set(transcriptPath, entry);
  return entry;
}

export const CLAUDE_REWIND: RewindSurface = {
  async sessionRewinds({ transcriptPath }) {
    return syncCursor(transcriptPath)?.marks ?? null;
  },
  async sessionRewindPoints({ transcriptPath }): Promise<RewindPoint[] | null> {
    const state = syncCursor(transcriptPath);
    if (!state) return null;
    // 有补位空档 = 这段历史的轮次不可知，整份不可信（调用方回落读屏）
    if (state.turns.some((t) => t === null)) return null;
    return state.messages.map((m, i) => ({ index: i, text: m.text, at: m.at }));
  },
  picker: CLAUDE_REWIND_PICKER,
};
