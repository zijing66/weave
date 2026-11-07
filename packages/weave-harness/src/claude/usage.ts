import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { UsageSurface, UsageTurn } from '../driver.js';

/**
 * 会话用量（claude）：token 计量在转录 assistant 条目的 `message.usage` 里
 * （hook 域不记 usage）。一条 assistant 消息拆成相邻多行（同 `message.id`），
 * 每行 usage 是各自 API 调用的增量——按消息聚合（同 id 归一轮），缓存读/写
 * 原样带出。上下文占用 = 该条 usage 四项之和（与 `currentContextTokensAt`
 * 同口径，实测与宿主 SessionStart 的 `context_tokens` 交叉吻合）。
 */

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

const num = (o: Record<string, unknown>, k: string): number =>
  typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : 0;

/** 一行转录 → 一轮用量（不是 assistant / 没有 usage 的行 → null）。 */
export function usageOfLine(line: string): UsageTurn | null {
  if (!line.includes('"usage"')) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const entry = raw as Record<string, unknown>;
  if (entry.type !== 'assistant') return null;
  const usage = obj(obj(entry.message).usage);
  const input = num(usage, 'input_tokens');
  const output = num(usage, 'output_tokens');
  const cacheRead = num(usage, 'cache_read_input_tokens');
  const cacheCreation = num(usage, 'cache_creation_input_tokens');
  if (input + output + cacheRead + cacheCreation <= 0) return null;
  return {
    at: typeof entry.timestamp === 'string' ? entry.timestamp : null,
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
    reasoningTokens: 0,
    contextTokens: input + output + cacheRead + cacheCreation,
  };
}

export const CLAUDE_USAGE: UsageSurface = {
  async sessionUsage({ transcriptPath }) {
    if (!transcriptPath) return null;
    const out: UsageTurn[] = [];
    const rl = createInterface({
      input: createReadStream(transcriptPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of rl) {
        const turn = usageOfLine(line);
        if (turn) out.push(turn);
      }
    } catch {
      return null;
    } finally {
      rl.close();
    }
    return out;
  },
};
