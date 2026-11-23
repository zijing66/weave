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
 * ⇒ 旧版本（≤2.1.296）判据两条：`promptIndex` **严格下降**（退回更早的轮），
 * 或**相等但上一轮已收尾**（退回的正是最后一轮——计数退到同一个值）。同轮排队
 * 连发也相等，故必须借「这一轮已经结束」（`turn_duration` / 中断行）把它排除；
 * weave 自己与别的会话注入的消息同样复用轮次计数，按前缀剔除，不参与判据。
 *
 * **2.1.319 起宿主不再重置 promptIndex**（2026-11-22 实测：rewind 后重发的消息
 * 计数照常递增），旧判据失明。新版本的痕迹换成**链 fork**：重发消息的
 * `parentUuid` 回指被退到的那条链行（而不是当时的链尾）——转录依旧零写入，
 * 但下一条 prompt 的链指针暴露了 fork。两个信号互补：旧版链照常接尾、只有计数
 * 降；新版计数照常升、只有链回头。链账同时管轮次表的截断（新格式的 turns
 * 不再按 promptIndex 对位，按链序维护）。
 *
 * 退到的值 p 表示「退完剩 p-1 轮」，故被退掉的区间 = 旧状态第 p 轮起到新消息
 * 之前：`boundaryAt` = 第 p 轮（第一条被退掉的 prompt）的时刻（含），`at` =
 * 新 prompt 的时刻（不含）。气泡时刻落在 [boundaryAt, at) 即被回退。
 */
export function stepRewind(state: RewindState, line: string): void {
  // 排队后被「吸收」的消息不带 turnPosition，宿主面板却照样列出它 ⇒ 单独认。
  if (line.includes('"queued_command"')) {
    const queued = stepQueued(state, line);
    noteChainRow(state, idOf(queued));
    return;
  }
  // 预筛：只有带 turnPosition 的 user 行才值得 parse（转录动辄几十 MB）；
  // 其余行只认「这一轮结束了」的收尾笔（正常收尾 = turn_duration，被打断 = 中断行）。
  if (!line.includes('"turnPosition"')) {
    if (line.includes('"turn_duration"') || line.includes('Request interrupted by user')) {
      state.turnEnded = true;
    }
    // 这条没 parse（省全量 JSON.parse）：链 uuid 用正则取行自身的。自洽闸：行内
    // parentUuid 必须命中且等于当前链尾才入账——链回指（注入）或史前（文件开头）
    // 一律不入，宁漏检 fork 也不让被正文污染的假 uuid 制造假 fork。
    noteChainLine(state, line);
    return;
  }
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (entry.type !== 'user' || entry.isSidechain === true) {
    noteChainRow(state, idOf(entry));
    return;
  }
  if (isSyntheticPrompt(entry)) {
    // 压缩续跑行带着压前那一轮的 p（实测压后的人类 prompt 会复用已用过的 p，
    // turnIndex 也回退）。prevP 留着 ⇒ 下一条人类 prompt 凑齐「相等且上一轮已收尾」，
    // 压缩后的第一条消息被误判成回退重发（2026-11-22 实测 4 次误报）。
    if (isCompactionPrompt(entry)) state.prevP = null;
    state.turnEnded = false;
    noteChainRow(state, idOf(entry));
    return;
  }
  const tp = entry.turnPosition as { promptIndex?: unknown; turnIndex?: unknown } | undefined;
  const p = tp?.promptIndex;
  const ts = entry.timestamp;
  if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || typeof ts !== 'string') {
    noteChainRow(state, idOf(entry));
    return;
  }
  // 系统注入（task_notification / scheduled 等）复用当前轮次计数且不重置它，
  // 但宿主在上一轮收尾后注入时 p 与 prevP 相等 + turnEnded 已置位——恰好凑齐
  // 「相等且上一轮已收尾」的回退判据，把后台任务通知误判成回退重发
  // （2026-11-12 实测：p=69 三连 system 注入被标回退）。真回退重发的消息
  // 是用户亲手发的：turnOrigin 恒 human。系统行既不算回退也不推 prevP。
  if (entry.turnOrigin !== undefined && entry.turnOrigin !== 'human') {
    noteChainRow(state, idOf(entry));
    return;
  }
  const ti = typeof tp?.turnIndex === 'number' ? tp.turnIndex : null;
  // 链 fork 判据（2.1.319+）：human prompt 的 parentUuid 指回已知链行而非链尾 =
  // rewind fork（被退掉的链段 = fork 点到旧链尾）。指不回任何已知链行 = 会话开头
  // 之前的史前（resume / 换文件），不是 fork。
  const parent = typeof entry.parentUuid === 'string' ? entry.parentUuid : null;
  if (parent !== null && parent !== state.tailUuid) {
    const k = state.chain.findIndex((c) => c.uuid === parent);
    if (k >= 0) {
      const cut = state.chain[k]!;
      const first = state.messages[cut.m];
      // 空段（只退掉了跑着的工具段、没退掉用户消息）：区间为空，不灰任何气泡
      state.marks.push({ at: ts, boundaryAt: first ? first.at : ts });
      state.turns = state.turns.slice(0, cut.t);
      state.messages = state.messages.slice(0, cut.m);
      state.forkRewound = true;
      const turn = { at: ts, text: promptTextOf(entry) };
      state.messages.push(turn);
      state.turns.push(turn);
      state.prevP = p;
      state.prevTi = ti;
      state.turnEnded = false;
      noteChainRow(state, idOf(entry));
      return;
    }
  }
  // 严格下降 = 退回到更早的轮；相等且上一轮已收尾 = 退回最后一轮重发（计数不变，
  // 故靠「上一轮已结束」把同轮排队连发排除掉）。真回退重发是**重进同一轮**：
  // turnIndex 不动；宿主在跨轮正常递增时（2026-11-22 实测）可能复用 promptIndex
  // 而 turnIndex 照升（109 > 108）——那种「相等」不是回退，用 ti 闸掉。
  const rewound =
    state.prevP !== null &&
    (p < state.prevP ||
      (p === state.prevP && state.turnEnded && (state.prevTi === null || ti === state.prevTi)));
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
  if (state.forkRewound) state.turns.push(turn);
  else if (state.turns.length === p - 1) state.turns.push(turn);
  else if (state.turns.length < p - 1) state.turns = new Array<Turn | null>(p - 1).fill(null).concat(turn);
  state.prevP = p;
  state.prevTi = ti;
  state.turnEnded = false;
  noteChainRow(state, idOf(entry));
}

/** 链账上限：更早的 fork 目标认不出（findIndex -1）就当没有——几千轮外的回退属极端。
 *  超长会话 2 万链行的 uuid 账 ≈ 几 MB，够用且不失控。 */
const CHAIN_MAX = 20_000;

const UUID_RE = /"uuid":"([0-9a-fA-F-]{36})"/;
const PARENT_RE = /"parentUuid":"([0-9a-fA-F-]{36})"/;

/** 已 parse 行的链记账：记下该链行的 uuid 与「走到它时」的轮次/消息表计数——
 *  fork 时拿它把两张表截回 fork 点。 */
function noteChainRow(state: RewindState, uuid: string | null): void {
  if (!uuid) return;
  state.chain.push({ uuid, t: state.turns.length, m: state.messages.length });
  if (state.chain.length > CHAIN_MAX) state.chain.splice(0, state.chain.length - CHAIN_MAX);
  state.tailUuid = uuid;
}

/** 已 parse 行取自身 uuid（从行对象取，不碰正文——粘贴的 JSON 可能带同形串）。 */
function idOf(entry: Record<string, unknown> | null): string | null {
  return entry && typeof entry.uuid === 'string' ? entry.uuid : null;
}

/** 未 parse 行的链记账（正则）：parentUuid 命中且等于当前链尾才入（见 stepRewind）。 */
function noteChainLine(state: RewindState, line: string): void {
  if (!line.includes('"uuid"')) return;
  const parent = PARENT_RE.exec(line)?.[1] ?? null;
  if (parent === null || parent !== state.tailUuid) return;
  noteChainRow(state, UUID_RE.exec(line)?.[1] ?? null);
}

/** 排队消息（`attachment.queued_command`）：宿主把它当用户消息列进回退面板，但没有轮次号。
 *  回传行对象（链记账用；不合规行回 null）。 */
function stepQueued(state: RewindState, line: string): Record<string, unknown> | null {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (entry.type !== 'attachment' || entry.isSidechain === true) return entry;
  const att = entry.attachment as { type?: unknown; prompt?: unknown } | undefined;
  if (att?.type !== 'queued_command' || typeof att.prompt !== 'string') return entry;
  const ts = entry.timestamp;
  if (typeof ts !== 'string') return entry;
  if (isSyntheticText(att.prompt)) return entry;
  state.messages.push({ at: ts, text: att.prompt });
  return entry;
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

const CONTINUATION_PREFIX = /^This session is being continued from a previous conversation/;

function isSyntheticPrompt(entry: Record<string, unknown>): boolean {
  if (entry.isCompactSummary === true) return true;
  return isSyntheticText(promptTextOf(entry));
}

/** 压缩续跑行（宿主借此把轮次计数退到压前那一轮）。 */
function isCompactionPrompt(entry: Record<string, unknown>): boolean {
  if (entry.isCompactSummary === true) return true;
  return CONTINUATION_PREFIX.test(promptTextOf(entry));
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
  /** 上一条 prompt 的 turnIndex（「相等」判据的伴生闸：真重发 turnIndex 不动）。 */
  prevTi: number | null;
  /** 上一条 prompt 之后这一轮是否已收尾（相等计数靠它区分「回退重发」与「同轮排队连发」）。 */
  turnEnded: boolean;
  /** 链账：每个链行的 uuid 与走到它时的轮次/消息表计数（fork 截断用，2.1.319+ 判据）。 */
  chain: Array<{ uuid: string; t: number; m: number }>;
  /** 链尾 uuid（fork 判据：parentUuid 指回更早的已知链行而非它）。 */
  tailUuid: string | null;
  /** 已见过链 fork（新格式 rewind）：此后轮次表按链序维护，不再按 promptIndex 对位。 */
  forkRewound: boolean;
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
    prevTi: null,
    turnEnded: false,
    chain: [],
    tailUuid: null,
    forkRewound: false,
    marks: [],
  };
  if (size < entry.cur.offset) {
    entry.cur.offset = 0;
    entry.turns = [];
    entry.messages = [];
    entry.prevP = null;
    entry.prevTi = null;
    entry.turnEnded = false;
    entry.chain = [];
    entry.tailUuid = null;
    entry.forkRewound = false;
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
