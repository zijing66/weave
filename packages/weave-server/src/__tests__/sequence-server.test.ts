import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { HookEventRepository } from '../repositories/hook-events.js';
import { SessionRepository } from '../repositories/sessions.js';
import { SessionSequenceRepository } from '../repositories/session-sequences.js';
import { MessageDeliverer } from '../hooks/message-deliverer.js';
import { SequenceEngine } from '../hooks/sequence-engine.js';
import { HookEventBus } from '../hooks/bus.js';
import { createWeaveServer } from '../daemon/server.js';

/**
 * 序列路由 HTTP 契约（批 3 ②）：hop 上限、步级前置校验（404/400/409 指明
 * 步号）、创建即触发步 0、列表形状、取消与终态冲突。引擎推进语义见
 * sequence-engine.test.ts。
 */
describe('daemon server sequence endpoints（POST/GET/DELETE /messaging/sequences）', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let hooksDir: string;
  let sequences: SessionSequenceRepository;
  let deliverer: MessageDeliverer;
  let projectId: number;

  beforeAll(async () => {
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    projectId = projects.register({ path: '/p', name: 'p', token: 'tk', source: 'init' }).id;
    const hookEvents = new HookEventRepository(db);
    const hookSessions = new SessionRepository(db);
    sequences = new SessionSequenceRepository(db);
    hooksDir = await mkdtemp(path.join(tmpdir(), 'weave-seq-srv-'));

    // a/b = claude（双步链目标）；cx = codex（无消息通道）；bare = 无事件
    const sessions = hookSessions;
    sessions.touch('a', projectId);
    sessions.touch('b', projectId);
    for (const eventType of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
      hookEvents.insert({ projectId, source: 'claude', eventType, sessionId: 'a', payload: '{}' });
      hookEvents.insert({ projectId, source: 'claude', eventType, sessionId: 'b', payload: '{}' });
    }
    sessions.touch('cx', projectId);
    hookEvents.insert({ projectId, source: 'codex', eventType: 'SessionStart', sessionId: 'cx', payload: '{}' });
    sessions.touch('bare', projectId);

    const bus = new HookEventBus();
    deliverer = new MessageDeliverer({
      sessions: hookSessions, projects, hookEvents, bus, hooksDir,
    });
    const sequenceEngine = new SequenceEngine({
      sequences, deliverer, sessions: hookSessions, bus,
    });

    server = createWeaveServer({
      projects,
      port: 0,
      hookEvents,
      hookSessions,
      messageDeliverer: deliverer,
      sessionSequences: sequences,
      sequenceEngine,
      hooksDir,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    server.close();
    db.close();
    await rm(hooksDir, { recursive: true, force: true });
  });

  const post = (p: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}/api${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const step = (to: string, mode?: string) => ({ to, text: `go ${to}`, ...(mode ? { mode } : {}) });

  it('hop 超限（>3 步）→ 400 带上限语义', async () => {
    const res = await post('/messaging/sequences', {
      steps: [step('a'), step('a'), step('a'), step('a')],
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain('3 steps');
  });

  it('步级前置校验：未知会话 404 指明步号；无事件 400；无通道 harness 409', async () => {
    const missing = await post('/messaging/sequences', { steps: [step('a'), step('ghost')] });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toContain('Step 2');

    const bare = await post('/messaging/sequences', { steps: [step('bare')] });
    expect(bare.status).toBe(400);

    const codex = await post('/messaging/sequences', { steps: [step('a'), step('cx')] });
    expect(codex.status).toBe(409);
    expect(((await codex.json()) as { error: string }).error).toContain('Step 2');
  });

  it('创建即触发步 0：201 + 行 running + 消息经管道可查（inject 走 outbox）', async () => {
    const res = await post('/messaging/sequences', {
      name: 'chain',
      steps: [step('a', 'inject'), step('b', 'inject')],
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      ok: boolean;
      sequence: { id: number; status: string; cursor: number; steps: Array<{ messageId?: string }> };
    };
    expect(data.ok).toBe(true);
    expect(data.sequence.status).toBe('running');
    const messageId = data.sequence.steps[0]!.messageId!;
    expect(typeof messageId).toBe('string'); // trigger 已同步回填（管道发号）
    expect(deliverer.getMessage(messageId)).toMatchObject({ sessionId: 'a', status: 'injected' });
    const row = sequences.getById(data.sequence.id)!;
    expect(row.cursor).toBe(0);
  });

  it('GET 列表形状（新在前）', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/messaging/sequences`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { sequences: Array<{ id: number; status: string }> };
    expect(data.sequences.length).toBeGreaterThan(0);
  });

  it('DELETE：running → 200 cancelled；终态再删 → 409；未知 → 404', async () => {
    const created = await post('/messaging/sequences', { steps: [step('a', 'inject')] });
    const { sequence } = (await created.json()) as { sequence: { id: number } };

    const del = await fetch(`http://127.0.0.1:${port}/api/messaging/sequences/${sequence.id}`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
    expect(sequences.getById(sequence.id)!.status).toBe('cancelled');

    const again = await fetch(`http://127.0.0.1:${port}/api/messaging/sequences/${sequence.id}`, {
      method: 'DELETE',
    });
    expect(again.status).toBe(409);

    const ghost = await fetch(`http://127.0.0.1:${port}/api/messaging/sequences/9999`, {
      method: 'DELETE',
    });
    expect(ghost.status).toBe(404);
  });

  it('空步数组 → 400', async () => {
    const res = await post('/messaging/sequences', { steps: [] });
    expect(res.status).toBe(400);
  });
});
