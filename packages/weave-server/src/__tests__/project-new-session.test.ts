import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  let projects: ProjectRepository;
  let projectPath: string;
  let projectId: number;
  /** 已开终端数：0 = 没得可复用（409），>0 = 复用既有 pane（200）。 */
  let openTerminals = 0;
  let runCalls: Array<{ dir: string; argv: string[]; terminal: TerminalSettings }>;
  /** 临时项目目录清单（afterAll 统一清）。 */
  const tmpDirs: string[] = [];

  const post = (url: string, body?: unknown): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });

  /** 新注册一个项目目录，并把 init 选择结果写进它的 `.weave/config.yaml`。 */
  async function makeProject(name: string, harnesses: string[]): Promise<number> {
    const dir = await mkdtemp(path.join(tmpdir(), `weave-new-session-${name}-`));
    tmpDirs.push(dir);
    await mkdir(path.join(dir, '.weave'), { recursive: true });
    await writeFile(
      path.join(dir, '.weave', 'config.yaml'),
      `initVersion: 0.1.0\nharnesses: ${JSON.stringify(harnesses)}\n`,
      'utf-8',
    );
    return projects.register({ path: dir, name, token: `${name}-token`, source: 'init' }).id;
  }

  beforeAll(async () => {
    db = openDatabase(':memory:');
    projects = new ProjectRepository(db);
    projectPath = await mkdtemp(path.join(tmpdir(), 'weave-new-session-'));
    tmpDirs.push(projectPath);
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
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
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

  it('body 指定已接入的 harness：起它', async () => {
    openTerminals = 1;
    const id = await makeProject('pick', ['claude', 'codex']);
    runCalls = [];
    const res = await post(`/projects/${id}/new-session`, { harness: 'claude' });
    expect(res.status).toBe(200);
    expect(runCalls.map((c) => c.argv)).toEqual([['claude']]);
  });

  it('未接入的 harness 409（不替用户跨配置起会话）、非法值 400', async () => {
    openTerminals = 1;
    const id = await makeProject('codex-only', ['codex']);
    const before = runCalls.length;
    const res = await post(`/projects/${id}/new-session`, { harness: 'claude' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('not integrated');
    expect((await post(`/projects/${id}/new-session`, { harness: 'bogus' })).status).toBe(400);
    expect(runCalls).toHaveLength(before);
  });

  it('已接入但起不了交互会话（codex 无 resume 槽裸 bin）→ 501，缺省亦然', async () => {
    openTerminals = 1;
    const id = await makeProject('codex-pick', ['codex']);
    const before = runCalls.length;
    expect((await post(`/projects/${id}/new-session`, { harness: 'codex' })).status).toBe(501);
    expect((await post(`/projects/${id}/new-session`)).status).toBe(501);
    expect(runCalls).toHaveLength(before);
  });
});
