import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { NarrationSurface, NarrationText } from '../driver.js';

/**
 * 旁白（codex）：模型在一轮里的全部 assistant 正文——hook 域只有 Stop 的
 * `last_assistant_message` 一个文本载体，中间输出只在 rollout 里。
 *
 * rollout 的 assistant 输出 = `event_msg` 条目 `payload.type ===
 * 'AgentMessage'` 的 `payload.message`（与 images 面同一条目族；`UserMessage`
 * 是用户侧、`AgentMessage` 是模型侧）。文本原样保留，时刻取条目 timestamp。
 */
export const CODEX_NARRATION: NarrationSurface = {
  async sessionNarration({ transcriptPath }) {
    if (!transcriptPath) return null;
    const out: NarrationText[] = [];
    const rl = createInterface({
      input: createReadStream(transcriptPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of rl) {
        // 预筛：AgentMessage 行才值得 parse（rollout 动辄几十 MB）
        if (!line.includes('"AgentMessage"')) continue;
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (entry.type !== 'event_msg') continue;
        const payload = entry.payload as Record<string, unknown> | undefined;
        if (payload?.type !== 'AgentMessage') continue;
        const text = typeof payload.message === 'string' ? payload.message : '';
        if (!text.trim()) continue;
        out.push({
          at: typeof entry.timestamp === 'string' ? entry.timestamp : null,
          text,
        });
      }
    } catch {
      return null;
    } finally {
      rl.close();
    }
    return out;
  },
};
