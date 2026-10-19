import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntimeRegistry } from '@weavecode/harness';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { HookEventRepository } from '../repositories/hook-events.js';
import { SessionRepository } from '../repositories/sessions.js';
import { createWeaveServer } from '../daemon/server.js';
import { setDaemonSettingsDb, writeDaemonSettings, type TerminalSettings } from '../daemon/settings.js';
import { SessionProbe } from '../daemon/session-probe.js';
import type { ProjectOpener } from '../daemon/opener.js';

const SESSION = 'sess-open-1';
/** 转录已从磁盘上消失的会话（会话行还在，`--resume` 接不回来）。 */
const SESSION_GONE = 'sess-gone';

describe('POST /sessions/:id/open-terminal', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let projectPath: string;
  let opener: ProjectOpener & {
    runCalls: Array<{ dir: string; argv: string[]; terminal: TerminalSettings }>;
    atCalls: Array<{ dir: string; argv: string[]; target: string }>;
  };

  const post = (url: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}${url}`, {
      method: 'POST',
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
    // 同上，但转录文件已经没了（被清理/删掉）→ 打开前就该 409
    sessions.touch(SESSION_GONE, row.id);
    hookEvents.insert({ projectId: row.id, source: 'claude', eventType: 'Stop', sessionId: SESSION_GONE, payload: '{}' });
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
      atCalls: [],
      openExplorer: async () => {},
      openTerminal: async () => {},
      runInTerminal: async (dir, argv, terminal) => {
        opener.runCalls.push({ dir, argv, terminal });
      },
      runInTerminalAt: async (dir, argv, target) => {
        opener.atCalls.push({ dir, argv, target });
      },
    };
    // 转录探测：SESSION 有一份在，SESSION_GONE 那份不存在（真机上的清理/手删）
    const transcript = path.join(projectPath, 'session.jsonl');
    writeFileSync(transcript, '{"type":"user","message":{"content":"hi"}}\n');
    const sessionProbe = new SessionProbe();
    sessionProbe.noteTranscript(SESSION, transcript);
    sessionProbe.noteTranscript(SESSION_GONE, path.join(projectPath, 'gone.jsonl'));
    setDaemonSettingsDb(db);
    server = createWeaveServer({
      projects,
      port: 0,
      hookEvents,
      hookSessions: sessions,
      harnesses: createRuntimeRegistry(),
      opener,
      sessionProbe,
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

  it('带 target：定点附加走 runInTerminalAt，不落到自动落点', async () => {
    const before = opener.runCalls.length;
    const res = await fetch(`http://127.0.0.1:${port}/sessions/${SESSION}/open-terminal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'deadbeef:1:2' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { target?: string }).toMatchObject({ target: 'deadbeef:1:2' });
    expect(opener.atCalls).toEqual([
      { dir: projectPath, argv: ['claude', '--resume', SESSION], target: 'deadbeef:1:2' },
    ]);
    expect(opener.runCalls).toHaveLength(before);
  });

  it('带 target 但 preset 无定点通道 → 400（明确拒绝，不静默忽略）', async () => {
    await writeDaemonSettings({
      terminal: { preset: 'powershell', customCommand: '' },
      locale: 'zh-CN',
      hooks: { enabled: true },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/sessions/${SESSION}/open-terminal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'deadbeef:1:2' }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(
        'cannot attach to a chosen pane',
      );
    } finally {
      await writeDaemonSettings({
        terminal: { preset: 'auto', customCommand: '' },
        locale: 'zh-CN',
        hooks: { enabled: true },
      });
    }
  });

  it('returns 501 for harness without interactive resume (codex)', async () => {
    const res = await post('/sessions/sess-codex/open-terminal');
    expect(res.status).toBe(501);
    expect(opener.runCalls).toHaveLength(1); // 未新增调用
  });

  it('转录已丢失 → 409（不 spawn 一个注定报 "No conversation found" 的进程）', async () => {
    const before = opener.runCalls.length;
    const res = await post(`/sessions/${SESSION_GONE}/open-terminal`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('transcript');
    expect(opener.runCalls).toHaveLength(before);
  });

  it('GET /sessions 逐行带 transcriptPresent：列表与 --resume 对齐同一份文件', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/sessions`);
    const { sessions: rows } = (await res.json()) as {
      sessions: Array<{ sessionId: string; transcriptPresent: boolean | null }>;
    };
    const byId = new Map(rows.map((r) => [r.sessionId, r.transcriptPresent]));
    expect(byId.get(SESSION)).toBe(true);
    expect(byId.get(SESSION_GONE)).toBe(false);
    // 不报转录路径的会话（codex）判不动 → null，前端也就不挂提示
    expect(byId.get('sess-codex')).toBeNull();
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
});
