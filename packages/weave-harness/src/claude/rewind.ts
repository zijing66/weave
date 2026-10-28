import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { RewindSurface, RewindMark } from '../driver.js';

/**
 * 回退（claude）：用户在宿主里 Esc Esc / `/rewind` 把对话退回某条历史消息后，
 * 转录**追加**一组元数据行，其中 `{"type":"last-prompt","leafUuid":"<回退目标>",
 * "rewound":true}` 是回退的锚点——被回退的消息不删（转录 append-only），只从
 * 锚点分叉继续。weave 据此把「锚点之后、下一次开轮之前」的既有气泡标成
 * 「已被回退」（置灰保留展示）。
 *
 * 锚点行自身不带 timestamp（实测 2.1.x：`type/lastPrompt/leafUuid/sessionId`
 * 四键），时刻取**锚点行之前最近一条带 timestamp 的转录行**——rewind 只能
 * 发生在最后活动之后，这个近似就是「回退前最后活动时刻」（上界）。
 */
export const CLAUDE_REWIND: RewindSurface = {
  async sessionRewinds({ transcriptPath }) {
    if (!transcriptPath) return null;
    const out: RewindMark[] = [];
    const rl = createInterface({
      input: createReadStream(transcriptPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    try {
      let lastTs: string | null = null;
      for await (const line of rl) {
        const mark = parseRewindLine(line, lastTs);
        if (mark) out.push(mark);
        const ts = timestampOf(line);
        if (ts) lastTs = ts;
      }
    } catch {
      return null;
    } finally {
      rl.close();
    }
    return out;
  },
};

/** 一行转录的 timestamp（带 timestamp 的行才有；解析失败不算）。 */
function timestampOf(line: string): string | null {
  if (!line.includes('"timestamp"')) return null;
  try {
    const ts = (JSON.parse(line) as { timestamp?: unknown }).timestamp;
    return typeof ts === 'string' ? ts : null;
  } catch {
    return null;
  }
}

/**
 * 一行转录 → 一条回退锚点（全量读与增量监视共用这份文法）。`lastTs` = 该行
 * 之前最近一条带 timestamp 行的时刻（锚点行自己不带，见上）。
 */
export function parseRewindLine(line: string, lastTs: string | null = null): RewindMark | null {
  // 预筛：last-prompt 行才值得 parse（转录动辄几十 MB）
  if (!line.includes('"type":"last-prompt"')) return null;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (entry.type !== 'last-prompt' || entry.rewound !== true) return null;
  if (!lastTs) return null;
  return { at: lastTs, boundaryAt: null };
}
