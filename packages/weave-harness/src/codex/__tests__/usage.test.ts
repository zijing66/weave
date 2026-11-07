import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_USAGE } from '../usage.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weave-codex-usage-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (lines: unknown[]): string => {
  const path = join(dir, 'rollout.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
  return path;
};

const tokenCount = (info: Record<string, unknown>, ts?: string) => ({
  ...(ts ? { timestamp: ts } : {}),
  ordinal: 1,
  type: 'event_msg',
  payload: { type: 'token_count', info },
});

const info = (last: Record<string, number>) => ({
  total_token_usage: { input_tokens: 999, cached_input_tokens: 0, output_tokens: 999, reasoning_output_tokens: 0, total_tokens: 1998 },
  last_token_usage: last,
  last_usage_includes_reasoning: false,
  model_context_window: 950000,
});

describe('CODEX_USAGE.sessionUsage', () => {
  it('token_count 条目逐条成轮：last 是本轮、cached 拆进 cacheRead、contextTokens = input+output', async () => {
    const path = write([
      tokenCount(
        info({ input_tokens: 45033, cached_input_tokens: 16640, cache_write_input_tokens: 0, output_tokens: 208, reasoning_output_tokens: 0 }),
        '2026-11-05T17:17:19.322Z',
      ),
      tokenCount(
        info({ input_tokens: 45576, cached_input_tokens: 43520, cache_write_input_tokens: 0, output_tokens: 299, reasoning_output_tokens: 0 }),
        '2026-11-05T17:17:22.694Z',
      ),
    ]);
    const turns = await CODEX_USAGE.sessionUsage({ sessionId: 's', transcriptPath: path });
    expect(turns).toHaveLength(2);
    expect(turns![0]).toEqual({
      at: '2026-11-05T17:17:19.322Z',
      inputTokens: 45033 - 16640,
      outputTokens: 208,
      cacheReadInputTokens: 16640,
      cacheCreationInputTokens: 0,
      reasoningTokens: 0,
      contextTokens: 45033 + 208,
    });
    expect(turns![1]!.inputTokens).toBe(45576 - 43520);
  });

  it('reasoning_output_tokens 原样带出', async () => {
    const path = write([
      tokenCount(info({ input_tokens: 100, cached_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 926 })),
    ]);
    const turns = await CODEX_USAGE.sessionUsage({ sessionId: 's', transcriptPath: path });
    expect(turns![0]!.reasoningTokens).toBe(926);
  });

  it('非 event_msg / 非 token_count 的行跳过', async () => {
    const path = write([
      { type: 'response_item', payload: { type: 'message', content: [] } },
      { type: 'event_msg', payload: { type: 'AgentMessage', message: 'hi' } },
      tokenCount(info({ input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 })),
    ]);
    const turns = await CODEX_USAGE.sessionUsage({ sessionId: 's', transcriptPath: path });
    expect(turns).toHaveLength(1);
  });

  it('last 全零（只有 rate_limits 的空壳条目）不算', async () => {
    const path = write([
      tokenCount({ total_token_usage: null, last_token_usage: null, last_usage_includes_reasoning: false, model_context_window: 950000 }),
    ]);
    const turns = await CODEX_USAGE.sessionUsage({ sessionId: 's', transcriptPath: path });
    expect(turns).toEqual([]);
  });

  it('rollout 不存在 / 路径 null → null（不猜）', async () => {
    expect(await CODEX_USAGE.sessionUsage({ sessionId: 's', transcriptPath: null })).toBeNull();
    expect(
      await CODEX_USAGE.sessionUsage({ sessionId: 's', transcriptPath: join(dir, 'nope.jsonl') }),
    ).toBeNull();
  });
});
