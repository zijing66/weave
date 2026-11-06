import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { UsageSurface, UsageTurn } from '../driver.js';

/**
 * 会话用量（codex）：token 计量在 rollout `event_msg` 条目
 * `payload.type === 'token_count'` 的 `info` 里——`last_token_usage` 是本轮
 * 增量，`total_token_usage` 是会话累计，`model_context_window` 是窗口大小。
 * 上下文占用 = last 项之和（codex 的计量语义就是「上一轮完成后窗口里有
 * 什么」，与 claude 的口径同构）。
 */

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

const num = (o: Record<string, unknown> | undefined, k: string): number =>
  o && typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : 0;

/** 一行 rollout → 一轮用量（不是 token_count / 没有 info 的行 → null）。 */
export function usageOfLine(line: string): UsageTurn | null {
  if (!line.includes('"token_count"')) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const entry = raw as Record<string, unknown>;
  if (entry.type !== 'event_msg') return null;
  const payload = obj(entry.payload);
  if (payload.type !== 'token_count') return null;
  const info = obj(payload.info);
  const last = obj(info.last_token_usage);
  const input = num(last, 'input_tokens');
  const cached = num(last, 'cached_input_tokens');
  const output = num(last, 'output_tokens');
  const reasoning = num(last, 'reasoning_output_tokens');
  if (input + cached + output <= 0) return null;
  return {
    at: typeof entry.timestamp === 'string' ? entry.timestamp : null,
    inputTokens: input - cached,
    outputTokens: output,
    cacheReadInputTokens: cached,
    cacheCreationInputTokens: 0,
    reasoningTokens: reasoning,
    contextTokens: input + output,
  };
}

export const CODEX_USAGE: UsageSurface = {
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
