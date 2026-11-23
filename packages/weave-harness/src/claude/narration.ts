import type { NarrationSurface, NarrationText } from '../driver.js';
import { readNewLines, transcriptSize, type LineCursor } from './transcript-cursor.js';

/**
 * 旁白（claude）：模型在一轮里的全部 assistant 正文——hook 域只有 Stop 的
 * `last_assistant_message` 一个文本载体，一轮里多次输出（写工具后又补一段收尾）
 * 只有最后一句能进对话气泡，前面的没有任何事件照会，转录是唯一来源。
 *
 * 只认主链 assistant 条目的 text 分区：
 * - `isSidechain` 条目是子代理的（away 总结等），不是对用户说的话；
 * - thinking 分区是模型的内部推理，不是输出；
 * - 同一条 assistant 消息宿主拆成相邻多行（同 `message.id`），text 分区各自成段
 *   ——按行原样保留（每行一段、时刻取该行 timestamp），拼接语义留给消费方。
 */
/**
 * 按**字节游标**增量累积：转录 append-only，每拍只读新增那截（对话页每次轮边界都
 * 重拉一遍，几十 MB 的转录整份重扫 3s+ 全压在打开对话那一拍）。文件被截断/换掉
 * （size 比游标还小）⇒ 已认出的段一起作废，从头再来。
 */
const cursors = new Map<
  string,
  { cur: LineCursor; segs: NarrationText[]; parser: (line: string) => NarrationText | null }
>();
const CURSOR_MAX = 64;

export const CLAUDE_NARRATION: NarrationSurface = {
  async sessionNarration({ transcriptPath }) {
    if (!transcriptPath) return null;
    const size = transcriptSize(transcriptPath);
    if (size === null) {
      cursors.delete(transcriptPath);
      return null;
    }
    const hit = cursors.get(transcriptPath);
    cursors.delete(transcriptPath);
    const entry = hit ?? { cur: { offset: 0 }, segs: [], parser: turnAwareParser() };
    // 文件比游标还短 = 被换掉了：已认出的段跟着作废，别把旧账接到新文件上。
    if (size < entry.cur.offset) {
      entry.cur.offset = 0;
      entry.segs = [];
      entry.parser = turnAwareParser();
    }
    const lines = readNewLines(transcriptPath, entry.cur, size);
    if (lines === null) return null;
    for (const line of lines) {
      const seg = entry.parser(line);
      if (seg) entry.segs.push(seg);
    }
    if (cursors.size >= CURSOR_MAX) {
      const oldest = cursors.keys().next().value;
      if (oldest !== undefined) cursors.delete(oldest);
    }
    cursors.set(transcriptPath, entry);
    return entry.segs;
  },
  lineParser: parseLine,
};

/** 一条 assistant 转录条目的 text 分区拼接（时刻随行）。null = 没有 text 分区。 */
export function assistantTextOf(entry: Record<string, unknown>): NarrationText | null {
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        !!part &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text)
    .join('')
    .trim();
  if (!text) return null;
  const turnPosition = entry.turnPosition as
    | { promptIndex?: unknown; turnIndex?: unknown }
    | undefined;
  return {
    at: typeof entry.timestamp === 'string' ? entry.timestamp : null,
    text,
    ...(typeof entry.uuid === 'string' ? { uuid: entry.uuid } : {}),
    ...(typeof turnPosition?.promptIndex === 'number' ? { promptIndex: turnPosition.promptIndex } : {}),
    ...(typeof turnPosition?.turnIndex === 'number' ? { turnIndex: turnPosition.turnIndex } : {}),
  };
}

/** 一行转录 → 一段旁白（全量读与增量监视共用这份文法）。 */
function parseLine(line: string): NarrationText | null {
  // 预筛：assistant 条目行才值得 parse（转录动辄几十 MB）
  if (!line.includes('"type":"assistant"')) return null;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (entry.type !== 'assistant' || entry.isSidechain === true) return null;
  return assistantTextOf(entry);
}

/**
 * 状态化行文法：assistant 行**不带** turnPosition（宿主 2.1.319 实测，轮次只在
 * user(human) 行上）——轮归属 = 继承最近一条 human user 行的 turnPosition。带轮次
 * 的解析走这份（全量读与增量监视共用同一实例内的状态）；无状态的 `parseLine` 保
 * 留给只要文本、不关心轮次的消费方。
 */
export function turnAwareParser(): (line: string) => NarrationText | null {
  let lastTurn: { promptIndex?: number; turnIndex?: number } | undefined;
  return (line: string) => {
    if (!line.includes('"type":')) return null;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (entry.type === 'user' && entry.turnOrigin === 'human') {
      const tp = entry.turnPosition as { promptIndex?: unknown; turnIndex?: unknown } | undefined;
      if (typeof tp?.promptIndex === 'number' && typeof tp?.turnIndex === 'number') {
        lastTurn = { promptIndex: tp.promptIndex, turnIndex: tp.turnIndex };
      }
      return null;
    }
    if (entry.type !== 'assistant' || entry.isSidechain === true) return null;
    const seg = assistantTextOf(entry);
    if (!seg) return null;
    return lastTurn ? { ...seg, ...lastTurn } : seg;
  };
}
