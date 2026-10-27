import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_NARRATION } from '../narration.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weave-codex-narr-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (lines: unknown[]): string => {
  const path = join(dir, 'sess.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
  return path;
};

const agentMsg = (text: string, ts?: string) => ({
  type: 'event_msg',
  ...(ts ? { timestamp: ts } : {}),
  payload: { type: 'AgentMessage', message: text },
});

describe('CODEX_NARRATION.sessionNarration', () => {
  it('event_msg/AgentMessage 按时间序全给', async () => {
    const path = write([
      agentMsg('第一段', '2026-10-27T08:00:00.000Z'),
      agentMsg('第二段', '2026-10-27T08:00:05.000Z'),
    ]);
    const sets = await CODEX_NARRATION.sessionNarration({ sessionId: 's', transcriptPath: path });
    expect(sets).toEqual([
      { at: '2026-10-27T08:00:00.000Z', text: '第一段' },
      { at: '2026-10-27T08:00:05.000Z', text: '第二段' },
    ]);
  });

  it('UserMessage（用户侧）与其他 event_msg 不进旁白', async () => {
    const path = write([
      { type: 'event_msg', payload: { type: 'UserMessage', message: '用户的话' } },
      { type: 'event_msg', payload: { type: 'TokenCount', info: {} } },
      agentMsg('模型的话'),
    ]);
    const sets = await CODEX_NARRATION.sessionNarration({ sessionId: 's', transcriptPath: path });
    expect(sets).toEqual([{ at: null, text: '模型的话' }]);
  });

  it('转录不存在 / 路径 null → null（不猜）', async () => {
    expect(await CODEX_NARRATION.sessionNarration({ sessionId: 's', transcriptPath: null })).toBeNull();
    expect(
      await CODEX_NARRATION.sessionNarration({ sessionId: 's', transcriptPath: join(dir, 'missing.jsonl') }),
    ).toBeNull();
  });
});
