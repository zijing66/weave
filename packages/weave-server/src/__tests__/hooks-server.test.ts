import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { HookEventRepository } from '../repositories/hook-events.js';
import { ClaudeCodeAdapter } from '../hooks/adapter.js';
import { createWeaveServer } from '../daemon/server.js';

const DAEMON_TOKEN = 'daemon-token';
const PROJECT_TOKEN = 'ptoken';

describe('daemon server /hooks endpoint', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let hookEvents: HookEventRepository;
  let projectId: number;

  beforeAll(async () => {
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    const row = projects.register({
      path: '/proj',
      name: 'test',
      token: PROJECT_TOKEN,
      source: 'init',
    });
    projectId = row.id;
    hookEvents = new HookEventRepository(db);
    server = createWeaveServer({
      projects,
      daemonToken: DAEMON_TOKEN,
      port: 0,
      hookEvents,
      adapters: [new ClaudeCodeAdapter()],
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    db.close();
  });

  it('accepts a valid hook report authenticated by the project token', async () => {
    const body = JSON.stringify({
      source: 'claude',
      eventType: 'PostToolUse',
      sessionId: 's1',
      cwd: '/proj',
      payload: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Edit' }),
    });
    const res = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${PROJECT_TOKEN}` },
      body,
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      id: number;
      projectId: number;
      source: string;
      eventType: string;
    };
    expect(data.projectId).toBe(projectId);
    expect(data.source).toBe('claude');
    expect(data.eventType).toBe('PostToolUse');
    expect(typeof data.id).toBe('number');

    // Persisted as an append-only row.
    const rows = hookEvents.listByProject(projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe('PostToolUse');
    expect(rows[0].sessionId).toBe('s1');
  });

  it('rejects the daemon token (a project token is required)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${DAEMON_TOKEN}` },
      body: JSON.stringify({ source: 'claude', eventType: 'PostToolUse', payload: '{}' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a missing token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'claude', eventType: 'PostToolUse', payload: '{}' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects invalid JSON', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${PROJECT_TOKEN}` },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('rejects a report missing source or eventType', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${PROJECT_TOKEN}` },
      body: JSON.stringify({ source: 'claude' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a source with no registered adapter', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${PROJECT_TOKEN}` },
      body: JSON.stringify({ source: 'codex', eventType: 'X', payload: '{}' }),
    });
    expect(res.status).toBe(400);
  });
});
