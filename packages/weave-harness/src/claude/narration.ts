import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { NarrationSurface, NarrationText } from '../driver.js';

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
export const CLAUDE_NARRATION: NarrationSurface = {
  async sessionNarration({ transcriptPath }) {
    if (!transcriptPath) return null;
    const out: NarrationText[] = [];
    const rl = createInterface({
      input: createReadStream(transcriptPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of rl) {
        const seg = parseLine(line);
        if (seg) out.push(seg);
      }
    } catch {
      return null;
    } finally {
      rl.close();
    }
    return out;
  },
  lineParser: parseLine,
};

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
  return {
    at: typeof entry.timestamp === 'string' ? entry.timestamp : null,
    text,
  };
}
