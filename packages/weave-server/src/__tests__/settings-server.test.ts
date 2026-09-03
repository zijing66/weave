import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { createWeaveServer } from '../daemon/server.js';
import { setDaemonSettingsDir, type TerminalSettings } from '../daemon/settings.js';
import type { ProjectOpener } from '../daemon/opener.js';

const TOKEN = 'daemon-token';

describe('daemon /settings and /projects/:id/open routes', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let projectPath: string;
  let opener: ProjectOpener & {
    explorerCalls: string[];
    terminalCalls: Array<{ dir: string; terminal: TerminalSettings }>;
  };

  beforeAll(async () => {
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    projectPath = await mkdtemp(path.join(tmpdir(), 'weave-open-'));
    projects.register({ path: projectPath, name: 'open-test', token: 'ptoken', source: 'init' });
    opener = {
      explorerCalls: [],
      terminalCalls: [],
      openExplorer: async (dir) => {
        opener.explorerCalls.push(dir);
      },
      openTerminal: async (dir, terminal) => {
        opener.terminalCalls.push({ dir, terminal });
      },
    };
    server = createWeaveServer({ projects, daemonToken: TOKEN, port: 0, opener });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    db.close();
  });

  afterEach(() => {
    setDaemonSettingsDir(null);
  });

  it('GET /settings returns defaults plus platform presets', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/settings`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      settings: { terminal: { preset: string } };
      presets: Array<{ id: string }>;
      platform: string;
    };
    expect(data.settings.terminal.preset).toBe('auto');
    expect(data.presets.some((p) => p.id === 'auto')).toBe(true);
    expect(data.presets.some((p) => p.id === 'custom')).toBe(true);
    expect(typeof data.platform).toBe('string');
  });

  it('GET /settings rejects a missing token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/settings`);
    expect(res.status).toBe(401);
  });

  it('PUT /settings persists and returns the normalized settings', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'weave-settings-api-'));
    setDaemonSettingsDir(dir);
    const put = await fetch(`http://127.0.0.1:${port}/settings`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ terminal: { preset: 'wt' } }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({
      terminal: { preset: 'wt', customCommand: '' },
    });
    // A follow-up GET reads the same value back through the injected dir.
    const get = await fetch(`http://127.0.0.1:${port}/settings`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const data = (await get.json()) as { settings: { terminal: { preset: string } } };
    expect(data.settings.terminal.preset).toBe('wt');
  });

  it('POST /projects/:id/open with target=explorer opens the project directory', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/projects/1/open`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'explorer' }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; target: string; path: string };
    expect(data.ok).toBe(true);
    expect(data.target).toBe('explorer');
    expect(data.path).toBe(projectPath);
    expect(opener.explorerCalls).toEqual([projectPath]);
    expect(opener.terminalCalls).toEqual([]);
  });

  it('POST /projects/:id/open with target=terminal passes the configured preset', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'weave-settings-term-'));
    setDaemonSettingsDir(dir);
    await fetch(`http://127.0.0.1:${port}/settings`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ terminal: { preset: 'custom', customCommand: 'myterm {path}' } }),
    });
    const res = await fetch(`http://127.0.0.1:${port}/projects/1/open`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'terminal' }),
    });
    expect(res.status).toBe(200);
    expect(opener.terminalCalls).toEqual([
      { dir: projectPath, terminal: { preset: 'custom', customCommand: 'myterm {path}' } },
    ]);
  });

  it('POST /open rejects an invalid target', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/projects/1/open`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'vscode' }),
    });
    expect(res.status).toBe(400);
    expect(opener.explorerCalls).toHaveLength(1);
    expect(opener.terminalCalls).toHaveLength(1);
  });

  it('POST /open returns 404 for an unknown project', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/projects/999/open`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'explorer' }),
    });
    expect(res.status).toBe(404);
  });

  it('POST /open returns 400 when the registered path no longer exists', async () => {
    db.exec('delete from projects');
    const projects2 = new ProjectRepository(db);
    projects2.register({ path: path.join(tmpdir(), 'weave-gone-xyz'), name: 'gone', token: 't2', source: 'init' });
    const id = projects2.list()[0].id;
    const res = await fetch(`http://127.0.0.1:${port}/projects/${id}/open`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'explorer' }),
    });
    expect(res.status).toBe(400);
  });
});
