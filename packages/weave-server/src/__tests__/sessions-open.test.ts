import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntimeRegistry } from '@weave/harness';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { HookEventRepository } from '../repositories/hook-events.js';
import { SessionRepository } from '../repositories/sessions.js';
import { createWeaveServer } from '../daemon/server.js';
import { setDaemonSettingsDb, type TerminalSettings } from '../daemon/settings.js';
import type { ProjectOpener } from '../daemon/opener.js';

const TOKEN = 'daemon-token';
const SESSION = 'sess-open-1';

describe('POST /sessions/:id/open-terminal', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let projectPath: string;
  let opener: ProjectOpener & {
    runCalls: Array<{ dir: string; argv: string[]; terminal: TerminalSettings }>;
  };

  const post = (url: string, auth = `Bearer ${TOKEN}`): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}${url}`, {
      method: 'POST',
      headers: { authorization: auth },
    });

  beforeAll(async () => {
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    projectPath = await mkdtemp(path.join(tmpdir(), 'weave-open-term-'));
    const row = projects.register({
      path: projectPath,
      name: 'open-term-test',
      token: 'ptoken',
      source: 'init',
    });
    const hookEvents = new HookEventRepository(db);
    const sessions = new SessionRepository(db);
    // claude 会话（有事件 + 有项目）
    sessions.touch(SESSION, row.id);
    hookEvents.insert({ projectId: row.id, source: 'claude', eventType: 'Stop', sessionId: SESSION, payload: '{}' });
    // codex 会话（resume 能力未注册 → 501）
    sessions.touch('sess-codex', row.id);
    hookEvents.insert({ projectId: row.id, source: 'codex', eventType: 'Stop', sessionId: 'sess-codex', payload: '{}' });
    // 无事件会话（无法判定 harness → 400）
    sessions.touch('sess-no-events', row.id);
    // 无项目会话（有事件可判 harness，但 sessions.project_id 为空 → 400）
    sessions.touch('sess-no-project', null);
    hookEvents.insert({ projectId: row.id, source: 'claude', eventType: 'Stop', sessionId: 'sess-no-project', payload: '{}' });

    opener = {
      runCalls: [],
      openExplorer: async () => {},
      openTerminal: async () => {},
      runInTerminal: async (dir, argv, terminal) => {
        opener.runCalls.push({ dir, argv, terminal });
      },
    };
    setDaemonSettingsDb(db);
    server = createWeaveServer({
      projects,
      daemonToken: TOKEN,
      port: 0,
      hookEvents,
      hookSessions: sessions,
      harnesses: createRuntimeRegistry(),
      opener,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    server.close();
    db.close();
    setDaemonSettingsDb(null);
    await rm(projectPath, { recursive: true, force: true });
  });

  it('opens a claude session with the interactive resume argv in the project dir', async () => {
    const res = await post(`/sessions/${SESSION}/open-terminal`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; command: string; cwd: string };
    expect(data).toMatchObject({ ok: true, command: `claude --resume ${SESSION}`, cwd: projectPath });
    // 独立进程语义在 opener（detached+unref）；路由层只校验传参形态
    expect(opener.runCalls).toHaveLength(1);
    expect(opener.runCalls[0]!.dir).toBe(projectPath);
    expect(opener.runCalls[0]!.argv).toEqual(['claude', '--resume', SESSION]);
    expect(opener.runCalls[0]!.terminal.preset).toBe('auto');
  });

  it('returns 501 for harness without interactive resume (codex)', async () => {
    const res = await post('/sessions/sess-codex/open-terminal');
    expect(res.status).toBe(501);
    expect(opener.runCalls).toHaveLength(1); // 未新增调用
  });

  it('returns 404 for an unknown session', async () => {
    expect((await post('/sessions/nope/open-terminal')).status).toBe(404);
  });

  it('returns 400 when the session has no events to determine its harness', async () => {
    const res = await post('/sessions/sess-no-events/open-terminal');
    expect(res.status).toBe(400);
  });

  it('returns 400 when the session is not bound to a project', async () => {
    const res = await post('/sessions/sess-no-project/open-terminal');
    expect(res.status).toBe(400);
  });

  it('requires the daemon token', async () => {
    expect((await post(`/sessions/${SESSION}/open-terminal`, 'Bearer wrong')).status).toBe(401);
  });
});
