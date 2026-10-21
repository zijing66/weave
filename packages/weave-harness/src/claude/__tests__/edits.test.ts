import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_EDITS } from '../edits.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weave-edits-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (lines: unknown[]): string => {
  const path = join(dir, 'sess.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
  return path;
};

const use = (id: string, name: string, input: unknown, ts?: string) => ({
  type: 'assistant',
  ...(ts ? { timestamp: ts } : {}),
  message: { content: [{ type: 'tool_use', id, name, input }] },
});

describe('CLAUDE_EDITS.sessionEdits', () => {
  it('Edit 的 old/new 与 Write 的整份 content 都按时间序给出（写入记空 before）', async () => {
    const path = write([
      use('t1', 'Write', { file_path: 'a.ts', content: 'one\n' }, '2026-10-21T01:00:00.000Z'),
      use('t2', 'Edit', { file_path: 'a.ts', old_string: 'one', new_string: 'two' }, '2026-10-21T01:01:00.000Z'),
      use('t3', 'Read', { file_path: 'a.ts' }),
    ]);
    expect(await CLAUDE_EDITS.sessionEdits({ sessionId: 's', transcriptPath: path })).toEqual([
      { path: 'a.ts', hunk: { before: '', after: 'one\n' }, at: '2026-10-21T01:00:00.000Z' },
      { path: 'a.ts', hunk: { before: 'one', after: 'two' }, at: '2026-10-21T01:01:00.000Z' },
    ]);
  });

  it('MultiEdit 摊平成多条；没有改文件内容的调用一律不算', async () => {
    const path = write([
      use('m1', 'MultiEdit', {
        file_path: 'b.ts',
        edits: [
          { old_string: 'x', new_string: 'y' },
          { old_string: 'z', new_string: 'w' },
        ],
      }),
      use('m2', 'Bash', { command: 'rm -rf /' }),
      use('m3', 'NotebookEdit', { notebook_path: 'n.ipynb', new_source: 'print(1)' }),
    ]);
    const edits = await CLAUDE_EDITS.sessionEdits({ sessionId: 's', transcriptPath: path });
    expect(edits?.map((e) => e.hunk)).toEqual([
      { before: 'x', after: 'y' },
      { before: 'z', after: 'w' },
    ]);
  });

  it('同一工具调用被重放（中断/重开）只算一次', async () => {
    const call = use('t1', 'Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' });
    const path = write([call, call]);
    const edits = await CLAUDE_EDITS.sessionEdits({ sessionId: 's', transcriptPath: path });
    expect(edits).toHaveLength(1);
  });

  it('没有路径 / 路径不存在 → null（不猜）', async () => {
    expect(await CLAUDE_EDITS.sessionEdits({ sessionId: 's', transcriptPath: null })).toBeNull();
    expect(
      await CLAUDE_EDITS.sessionEdits({ sessionId: 's', transcriptPath: join(dir, 'nope.jsonl') }),
    ).toBeNull();
  });
});
