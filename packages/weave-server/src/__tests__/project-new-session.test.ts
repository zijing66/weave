import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntimeRegistry } from '@weavecode/harness';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { createWeaveServer } from '../daemon/server.js';
import { setDaemonSettingsDb, writeDaemonSettings, type TerminalSettings } from '../daemon/settings.js';
import type { ProjectOpener } from '../daemon/opener.js';

describe('POST /projects/:id/new-session', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let projectPath: string;
  let projectId: number;
  /** 已开终端数：0 = 没得可复用（409），>0 = 复用既有 pane（200）。 */
  let openTerminals = 0;
  let runCalls: Array<{ dir: string; argv: string[]; terminal: TerminalSettings }>;

  const post = (url: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}${url}`, { method: 'POST' });

  beforeAll(async () => {
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    projectPath = await mkdtemp(path.join(tmpdir(), 'weave-new-session-'));
    projectId = projects.register({
      path: projectPath,
      name: 'new-session-test',
      token: 'nstoken',
      source: 'init',
    }).id;
    runCalls = [];
    const opener: ProjectOpener = {
      openExplorer: async () => {},
      openTerminal: async () => {},
      runInTerminal: async (dir, argv, terminal) => {
        runCalls.push({ dir, argv, terminal });
      },
      countTerminals: async (dirs) => new Map(dirs.map((d) => [d, openTerminals])),
    };
    setDaemonSettingsDb(db);
    await writeDaemonSettings({
      terminal: { preset: 'auto', customCommand: '' },
      locale: 'zh-CN',
      hooks: { enabled: true },
    });
    server = createWeaveServer({
      projects,
      port: 0,
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

  it('有已开终端时用 harness 裸 bin（新会话，不带 resume 参数）落进项目目录', async () => {
    openTerminals = 1;
    const res = await post(`/projects/${projectId}/new-session`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { command: string }).toMatchObject({
      ok: true,
      command: 'claude',
      cwd: projectPath,
    });
    expect(runCalls).toEqual([
      { dir: projectPath, argv: ['claude'], terminal: { preset: 'auto', customCommand: '' } },
    ]);
  });

  it('没有已开终端 → 409，且不 spawn（前置是硬闸，不是防误触）', async () => {
    openTerminals = 0;
    const before = runCalls.length;
    const res = await post(`/projects/${projectId}/new-session`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('No terminal is open');
    expect(runCalls).toHaveLength(before);
  });

  it('未知项目 404', async () => {
    openTerminals = 1;
    expect((await post('/projects/9999/new-session')).status).toBe(404);
  });
});
