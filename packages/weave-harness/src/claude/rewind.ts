import type { RewindSurface, RewindMark } from '../driver.js';
import { readNewLines, transcriptSize, type LineCursor } from './transcript-cursor.js';

/**
 * 回退（claude）：用户在宿主里 Esc Esc / `/rewind` 把对话退回某条历史消息后，
 * 被回退的消息不删（转录 append-only），上下文从**新链根**分叉继续——下一次
 * 提交时宿主写一条 `parentUuid:null` 的 user 行（会话开头那条之外的新根）。
 * 实测 2.1.296（2026-10-29）：rewind 确认后转录零写入，痕迹只在下一次提交时
 * 出现；`rewound:true` 锚点行与 `explicit` last-prompt 行都不是可靠信号
 * （前者该版本不写，后者普通轮也写）。斜杠命令展开（`<command-message>` 开头）
 * 每次执行也立新根，同样不算 rewind。weave 据此把「新链根之前」的既有气泡
 * 标成「已被回退」（置灰保留展示）。
 *
 * 锚点时刻 = 新链根自身的 timestamp（比旧文法的「前一行近似」更准）。
 */
/**
 * 按**字节游标**增量累积（同 narration）：`seenRoot` 是跨行状态，跟着游标一起存。
 * 文件被截断/换掉 ⇒ 锚点与状态一并作废，从头再来。
 */
const cursors = new Map<
  string,
  { cur: LineCursor; marks: RewindMark[]; seenRoot: boolean }
>();
const CURSOR_MAX = 64;

export const CLAUDE_REWIND: RewindSurface = {
  async sessionRewinds({ transcriptPath }) {
    if (!transcriptPath) return null;
    const size = transcriptSize(transcriptPath);
    if (size === null) {
      cursors.delete(transcriptPath);
      return null;
    }
    const hit = cursors.get(transcriptPath);
    cursors.delete(transcriptPath);
    const entry = hit ?? { cur: { offset: 0 }, marks: [], seenRoot: false };
    if (size < entry.cur.offset) {
      entry.cur.offset = 0;
      entry.marks = [];
      entry.seenRoot = false;
    }
    const lines = readNewLines(transcriptPath, entry.cur, size);
    if (lines === null) return null;
    for (const line of lines) {
      if (!line.includes('"type":"user"')) continue;
      const mark = parseRewindLine(line, entry.seenRoot);
      if (mark) entry.marks.push(mark);
      try {
        if (isChainRoot(JSON.parse(line) as Record<string, unknown>)) entry.seenRoot = true;
      } catch {}
    }
    if (cursors.size >= CURSOR_MAX) {
      const oldest = cursors.keys().next().value;
      if (oldest !== undefined) cursors.delete(oldest);
    }
    cursors.set(transcriptPath, entry);
    return entry.marks;
  },
};

/**
 * 一行转录 → 一条回退锚点（全量读与增量监视共用这份文法）。`seenRoot` =
 * 此前是否已见过链根——会话开头第一条 user 与斜杠命令展开（`<command-message>`
 * 开头，实测每次执行都立新根）都算，rewind 后的普通消息是**下一个**根。
 */
export function parseRewindLine(line: string, seenRoot: boolean): RewindMark | null {
  // 预筛：user 行才值得 parse（转录动辄几十 MB）
  if (!line.includes('"type":"user"')) return null;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!isChainRoot(entry)) return null;
  if (!seenRoot) return null;
  const ts = entry.timestamp;
  if (typeof ts !== 'string') return null;
  return { at: ts, boundaryAt: null };
}

/** 这行是不是链根（parentUuid:null 的非侧链 user 行；会话开头与命令展开都算）。 */
function isChainRoot(entry: Record<string, unknown>): boolean {
  if (entry.type !== 'user' || entry.parentUuid !== null || entry.isSidechain === true) return false;
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  return !(typeof content === 'string' && content.startsWith('<command-message>'));
}
