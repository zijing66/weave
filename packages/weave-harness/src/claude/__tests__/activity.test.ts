import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_ACTIVITY } from '../activity.js';
import { frameFacts } from '../event-source.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weave-activity-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const assistantEntry = (text: string, ts: string) => ({
  type: 'assistant',
  timestamp: ts,
  isSidechain: true,
  message: { id: `m-${ts}`, content: [{ type: 'text', text }] },
});

describe('CLAUDE_ACTIVITY.sessionActivity', () => {
  it('扫 subagents 目录：agent-<id>.jsonl + meta 给 agentType/description/startedAt', async () => {
    // 真实布局：<slug>/<会话id>.jsonl + <slug>/<会话id>/subagents/
    const subagents = join(dir, 'sess', 'subagents');
    mkdirSync(subagents, { recursive: true });
    const transcript = join(subagents, 'agent-abc123.jsonl');
    writeFileSync(transcript, JSON.stringify(assistantEntry('hello', '2026-11-04T10:00:00.000Z')));
    writeFileSync(
      join(subagents, 'agent-abc123.meta.json'),
      JSON.stringify({ agentType: 'Explore', description: 'scan repo' }),
    );
    writeFileSync(join(subagents, 'not-an-agent.jsonl'), '');

    const snap = await CLAUDE_ACTIVITY.sessionActivity({
      sessionId: 'no-tasks-here',
      transcriptPath: join(dir, 'sess.jsonl'),
    });
    expect(snap?.agents).toHaveLength(1);
    expect(snap?.agents[0]).toMatchObject({
      agentId: 'abc123',
      agentType: 'Explore',
      description: 'scan repo',
      status: 'running',
      startedAt: '2026-11-04T10:00:00.000Z',
    });
  });

  it('meta 缺失时仍出行（只给 id），目录不存在时 agents 为空', async () => {
    const subagents = join(dir, 'sess', 'subagents');
    mkdirSync(subagents, { recursive: true });
    writeFileSync(join(subagents, 'agent-xyz.jsonl'), JSON.stringify(assistantEntry('a', '2026-11-04T10:00:00.000Z')));

    const snap = await CLAUDE_ACTIVITY.sessionActivity({
      sessionId: 'x',
      transcriptPath: join(dir, 'sess.jsonl'),
    });
    expect(snap?.agents[0]).toMatchObject({ agentId: 'xyz', status: 'running' });
    expect(snap?.agents[0]?.agentType).toBeUndefined();

    const none = await CLAUDE_ACTIVITY.sessionActivity({ sessionId: 'x', transcriptPath: null });
    expect(none?.agents).toEqual([]);
    // tasks 目录不存在 → null（清空的清单不展示，也不从事件账重建）
    expect(none?.tasks).toBeNull();
  });
});

describe('CLAUDE_ACTIVITY.agentTranscript', () => {
  it('按 offset 增量读 assistant 正文（isSidechain 恒真也照给）', async () => {
    const path = join(dir, 'agent-1.jsonl');
    const l1 = JSON.stringify(assistantEntry('第一段', '2026-11-04T10:00:00.000Z'));
    const l2 = JSON.stringify(assistantEntry('第二段', '2026-11-04T10:00:05.000Z'));
    writeFileSync(path, `${l1}\n`);
    const first = await CLAUDE_ACTIVITY.agentTranscript({ transcriptPath: path });
    expect(first?.segs.map((s) => s.text)).toEqual(['第一段']);
    expect(first?.nextOffset).toBeNull(); // 读到文件尾

    writeFileSync(path, `${l1}\n${l2}\n`);
    const second = await CLAUDE_ACTIVITY.agentTranscript({ transcriptPath: path, offset: 0 });
    expect(second?.segs.map((s) => s.text)).toEqual(['第一段', '第二段']);
  });

  it('文件不存在 → null', async () => {
    expect(await CLAUDE_ACTIVITY.agentTranscript({ transcriptPath: join(dir, 'nope.jsonl') })).toBeNull();
  });
});

describe('CLAUDE_ACTIVITY.shellOutput', () => {
  it('按 cwdSlug 落点读 tail，超限标 truncated', async () => {
    // 用本进程 tmpdir 派生 slug 落一个合法文件：cwd 取 dir 的父级形态没法控制，
    // 故直接构造 cwdSlug(dir)
    const slug = dir.replace(/[^A-Za-z0-9.-]/g, '-');
    const outDir = join(tmpdir(), 'claude', slug, 'sess-1', 'tasks');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 't1.output'), 'x'.repeat(100));

    const r = await CLAUDE_ACTIVITY.shellOutput({ taskId: 't1', sessionId: 'sess-1', cwd: dir, bytes: 10 });
    expect(r?.truncated).toBe(true);
    expect(r?.text.length).toBeLessThanOrEqual(10);

    rmSync(join(tmpdir(), 'claude', slug), { recursive: true, force: true });
  });

  it('cwd 缺失或文件不存在 → null', async () => {
    expect(await CLAUDE_ACTIVITY.shellOutput({ taskId: 't', sessionId: 's', cwd: null })).toBeNull();
    expect(await CLAUDE_ACTIVITY.shellOutput({ taskId: 'nope', sessionId: 's', cwd: dir })).toBeNull();
  });
});

describe('frameFacts：backgroundTasks 元数据与 bgShell', () => {
  it('Stop 的 background_tasks 带 type/description/agent_type/command', () => {
    const facts = frameFacts({
      eventType: 'Stop',
      toolName: null,
      toolResponse: null,
      raw: {
        background_tasks: [
          { id: 'a1', type: 'subagent', status: 'running', description: 'scan', agent_type: 'Explore' },
          { id: 'sh1', type: 'shell', status: 'running', command: 'npm test' },
        ],
      },
    });
    expect(facts.backgroundTasks).toEqual([
      expect.objectContaining({ id: 'a1', type: 'subagent', description: 'scan', agentType: 'Explore' }),
      expect.objectContaining({ id: 'sh1', type: 'shell', command: 'npm test' }),
    ]);
  });

  it('PostToolUse(Bash) 的 tool_response.backgroundTaskId → bgShell', () => {
    const facts = frameFacts({
      eventType: 'PostToolUse',
      toolName: 'Bash',
      toolResponse: { backgroundTaskId: 'sh9' },
      raw: null,
    });
    expect(facts.bgShell).toEqual({ taskId: 'sh9' });
  });
});
