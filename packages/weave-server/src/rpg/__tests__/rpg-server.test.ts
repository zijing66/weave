import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntimeRegistry } from '@weavecode/harness';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { MessageDeliverer } from '../../hooks/message-deliverer.js';
import { createWeaveServer } from '../../daemon/server.js';
import { setDaemonSettingsDb, writeDaemonSettings } from '../../daemon/settings.js';
import { RpgRoleRepository, RpgGrowthRepository } from '../roles.js';
import type { ProjectOpener } from '../../daemon/opener.js';

/**
 * 建角色 e2e（RPG-1 验收②）：走既有 REST 动词门面（路由级，不起真终端）——
 * POST /rpg/coordinator（协调者脚手架）→ POST /rpg/roles（建角色 = 项目+登记）
 * → POST /projects/:id/new-session（角色会话起在角色项目目录）。
 * 终端 opener 注入 fake：会话落点按项目真实目录断言。
 */
describe('POST /rpg/* + 建角色全链（REST，不依赖 MCP）', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let rolesRoot: string;
  let runDirs: string[];
  const tmpDirs: string[] = [];

  const call = (method: string, url: string, body?: unknown): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    db = openDatabase(':memory:');
    setDaemonSettingsDb(db);
    await writeDaemonSettings({
      terminal: { preset: 'auto', customCommand: '' },
      locale: 'zh-CN',
      hooks: { enabled: true },
    });
    rolesRoot = mkdtempSync(path.join(tmpdir(), 'weave-rpg-e2e-roles-'));
    tmpDirs.push(rolesRoot);
    const hooksTmp = mkdtempSync(path.join(tmpdir(), 'weave-rpg-e2e-hooks-'));
    tmpDirs.push(hooksTmp);
    runDirs = [];
    const opener: ProjectOpener = {
      openExplorer: async () => {},
      openTerminal: async () => {},
      runInTerminal: async (dir) => {
        runDirs.push(dir);
      },
    };
    const projects = new ProjectRepository(db);
    server = createWeaveServer({
      projects,
      port: 0,
      harnesses: createRuntimeRegistry(),
      opener,
      hooksDir: hooksTmp,
      rpgRoles: new RpgRoleRepository(db),
      rpgGrowth: new RpgGrowthRepository(db),
      rpgRolesRoot: rolesRoot,
      messageDeliverer: new MessageDeliverer({
        sessions: new SessionRepository(db),
        projects,
        hookEvents: new HookEventRepository(db),
        hooksDir: hooksTmp,
      }),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    server.close();
    db.close();
    setDaemonSettingsDb(null);
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('① 协调者脚手架：POST /rpg/coordinator 建出 teams/roles/playbooks/state + 项目行', async () => {
    const res = await call('POST', '/rpg/coordinator');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; created: string[]; path: string };
    expect(body.ok).toBe(true);
    expect(body.created).toEqual(['teams', 'roles', 'playbooks', 'state']);
    expect(path.dirname(body.path)).toBe(path.dirname(rolesRoot));
  });

  it('② 建角色：POST /rpg/roles → 仓库目录 + 项目注册 + RPG 行', async () => {
    const res = await call('POST', '/rpg/roles', {
      name: 'frontend-dev',
      archetype: '创造',
      persona: '你是像素风前端工程师。',
    });
    expect(res.status).toBe(201);
    const role = (await res.json()) as { id: number; projectId: number; path: string; reused: boolean };
    expect(role.reused).toBe(false);
    expect(path.dirname(role.path)).toBe(rolesRoot);
    expect(mkdirSync.length).toBeGreaterThan(0); // 仓库目录已由服务端建（.weave 子目录）
    const roles = await (await call('GET', '/rpg/roles')).json() as { roles: Array<{ id: number }> };
    expect(roles.roles.map((r) => r.id)).toContain(role.id);
  });

  it('③ 角色会话起在角色项目目录：POST /projects/:id/new-session（cwd = 角色仓库）', async () => {
    const list = (await (await call('GET', '/rpg/roles')).json()) as {
      roles: Array<{ id: number; projectId: number; project: { path: string } }>;
    };
    const role = list.roles[0]!;
    const res = await call('POST', `/projects/${role.projectId}/new-session`, { harness: 'claude' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; cwd: string };
    expect(body.cwd).toBe(role.project.path);
    expect(runDirs).toEqual([role.project.path]);
  });

  it('非法角色名 400 / RPG 关（无 rpgRoles）503', async () => {
    expect((await call('POST', '/rpg/roles', { name: 'Bad!' })).status).toBe(400);
  });

  it('成长记录只读面：GET /rpg/roles/:id/growth', async () => {
    const list = (await (await call('GET', '/rpg/roles')).json()) as {
      roles: Array<{ id: number }>;
    };
    const res = await call('GET', `/rpg/roles/${list.roles[0]!.id}/growth`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { growth: unknown[] }).toEqual({ growth: [] });
  });
});
