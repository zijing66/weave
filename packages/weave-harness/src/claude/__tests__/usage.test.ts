import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_USAGE, usageOfLine } from '../usage.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weave-usage-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (lines: unknown[]): string => {
  const path = join(dir, 'sess.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
  return path;
};

const usage = (over: Record<string, number> = {}) => ({
  input_tokens: 100,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 20,
  ...over,
});

const assistantEntry = (u: Record<string, number>, ts?: string, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  ...(ts ? { timestamp: ts } : {}),
  message: { id: 'msg_1', content: [{ type: 'text', text: 'hi' }], usage: u },
  ...extra,
});

describe('CLAUDE_USAGE.sessionUsage', () => {
  it('assistant 条目的 usage 逐条成轮，四项之和进 contextTokens', async () => {
    const path = write([
      assistantEntry(usage({ input_tokens: 10, output_tokens: 5 }), '2026-11-05T01:00:00.000Z'),
      assistantEntry(
        usage({ input_tokens: 1000, cache_read_input_tokens: 400, cache_creation_input_tokens: 60, output_tokens: 40 }),
        '2026-11-05T01:01:00.000Z',
      ),
    ]);
    const turns = await CLAUDE_USAGE.sessionUsage({ sessionId: 's', transcriptPath: path });
    expect(turns).toHaveLength(2);
    expect(turns![0]).toEqual({
      at: '2026-11-05T01:00:00.000Z',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningTokens: 0,
      contextTokens: 15,
    });
    expect(turns![1]!.contextTokens).toBe(1500);
    expect(turns![1]!.cacheReadInputTokens).toBe(400);
  });

  it('user / 无 usage 的行（合成条目）跳过', async () => {
    const path = write([
      { type: 'user', message: { role: 'user', content: 'hello' } },
      assistantEntry(usage()),
    ]);
    const turns = await CLAUDE_USAGE.sessionUsage({ sessionId: 's', transcriptPath: path });
    expect(turns).toHaveLength(1);
  });

  it('usage 全零的行不算（空壳计量）', async () => {
    const path = write([assistantEntry(usage({ input_tokens: 0, output_tokens: 0 }))]);
    const turns = await CLAUDE_USAGE.sessionUsage({ sessionId: 's', transcriptPath: path });
    expect(turns).toEqual([]);
  });

  it('timestamp 缺失 → at=null 原样带出', async () => {
    const path = write([assistantEntry(usage())]);
    const turns = await CLAUDE_USAGE.sessionUsage({ sessionId: 's', transcriptPath: path });
    expect(turns![0]!.at).toBeNull();
  });

  it('sidechain（子代理）条目同样带 usage——用量是会话整体的，一并计入', async () => {
    const path = write([
      assistantEntry(usage(), '2026-11-05T01:00:00.000Z'),
      assistantEntry(usage({ input_tokens: 50 }), '2026-11-05T01:00:05.000Z', { isSidechain: true }),
    ]);
    const turns = await CLAUDE_USAGE.sessionUsage({ sessionId: 's', transcriptPath: path });
    expect(turns).toHaveLength(2);
  });

  it('转录不存在 / 路径 null → null（不猜）', async () => {
    expect(await CLAUDE_USAGE.sessionUsage({ sessionId: 's', transcriptPath: null })).toBeNull();
    expect(
      await CLAUDE_USAGE.sessionUsage({ sessionId: 's', transcriptPath: join(dir, 'nope.jsonl') }),
    ).toBeNull();
  });
});

describe('usageOfLine（行文法，与增量监视同口径的备用面）', () => {
  it('坏 JSON 行安全返回 null', () => {
    expect(usageOfLine('not json')).toBeNull();
  });
});
