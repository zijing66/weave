import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntimeRegistry } from '@weavecode/harness';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { createWeaveServer } from '../../daemon/server.js';
import { setDaemonSettingsDb, writeDaemonSettings } from '../../daemon/settings.js';
import { RpgRoleRepository } from '../roles.js';

/**
 * 房子域路由测试（G2 段1）：建房（核心+辅助+角色入住）/ 分身编辑 / 名册 live
 * 展开（成员行随库现读）。单项目房 = 退化态（core=自己、无成员行）同表成立。
 */
describe('POST/GET/PATCH/DELETE /rpg/houses（房子域 CRUD + 组建流）', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  const tmpDirs: string[] = [];
  let coreId = 0;
  let auxId = 0;
  let roleId = 0;

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
    const rolesRoot = mkdtempSync(path.join(tmpdir(), 'weave-rpg-houses-'));
    tmpDirs.push(rolesRoot);
    const hooksTmp = mkdtempSync(path.join(tmpdir(), 'weave-rpg-houses-hooks-'));
    tmpDirs.push(hooksTmp);
    const projects = new ProjectRepository(db);
    const core = projects.register({ path: path.join(rolesRoot, 'core'), name: 'core', token: 't1', source: 'init' });
    const aux = projects.register({ path: path.join(rolesRoot, 'aux'), name: 'aux', token: 't2', source: 'init' });
    coreId = core.id;
    auxId = aux.id;
    const roles = new RpgRoleRepository(db);
    roleId = roles.create({ projectId: core.id, name: 'frontend-dev' }).id;
    server = createWeaveServer({
      projects,
      port: 0,
      harnesses: createRuntimeRegistry(),
      rpgRoles: roles,
      rpgRolesRoot: rolesRoot,
      hooksDir: hooksTmp,
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

  let houseId = 0;

  it('① 建房：核心 + 辅助 + 角色入住一步落；同核心二房 409', async () => {
    const res = await call('POST', '/rpg/houses', {
      name: 'pixel-forge',
      coreProjectId: coreId,
      coordinatorPersona: '上帝的分身：协调者。',
      auxProjectIds: [auxId],
      roleIds: [roleId],
    });
    expect(res.status).toBe(201);
    const house = (await res.json()) as {
      id: number;
      coreProjectId: number;
      coordinatorPersona: string;
      members: Array<{ kind: string; projectId: number | null; roleId: number | null }>;
    };
    houseId = house.id;
    expect(house.coreProjectId).toBe(coreId);
    expect(house.coordinatorPersona).toContain('分身');
    expect(house.members).toHaveLength(2);
    expect(house.members[0]).toMatchObject({ kind: 'aux', projectId: auxId });
    expect(house.members[1]).toMatchObject({ kind: 'role', roleId });
    const dup = await call('POST', '/rpg/houses', { name: 'again', coreProjectId: coreId });
    expect(dup.status).toBe(409);
  });

  it('② 单项目房 = 退化态：core=自己、无成员行，同一张表', async () => {
    const res = await call('POST', '/rpg/houses', { name: 'solo', coreProjectId: auxId });
    expect(res.status).toBe(201);
    const house = (await res.json()) as { coreProjectId: number; members: unknown[] };
    expect(house.coreProjectId).toBe(auxId);
    expect(house.members).toEqual([]);
    await call('DELETE', `/rpg/houses/${(await (await call('GET', '/rpg/houses')).json() as { houses: Array<{ id: number }> }).houses.find((h) => h.name === 'solo')!.id}`);
  });

  it('③ 分身编辑（PATCH coordinatorPersona）+ 房名', async () => {
    const res = await call('PATCH', `/rpg/houses/${houseId}`, {
      name: 'pixel-forge-2',
      coordinatorPersona: '新分寸：少催多看。',
    });
    expect(res.status).toBe(200);
    const house = (await res.json()) as { name: string; coordinatorPersona: string };
    expect(house.name).toBe('pixel-forge-2');
    expect(house.coordinatorPersona).toContain('少催多看');
  });

  it('④ 名册 live 展开：addMember/removeMember 后 GET 即见，不拍快照', async () => {
    const added = await call('POST', `/rpg/houses/${houseId}/members`, { kind: 'role', roleId });
    expect(added.status).toBe(201);
    let members = ((await (await call('GET', `/rpg/houses/${houseId}`)).json()) as { members: unknown[] }).members;
    expect(members).toHaveLength(3);
    const mid = (added as unknown as never, (members[2] as { id: number }).id);
    const removed = await call('DELETE', `/rpg/houses/${houseId}/members/${mid}`);
    expect(removed.status).toBe(200);
    members = ((await (await call('GET', `/rpg/houses/${houseId}`)).json()) as { members: unknown[] }).members;
    expect(members).toHaveLength(2);
  });

  it('⑤ 未知资源 404；拆房后 404', async () => {
    expect((await call('GET', '/rpg/houses/99999')).status).toBe(404);
    expect((await call('POST', '/rpg/houses', { name: 'x', coreProjectId: 99999 })).status).toBe(404);
    expect((await call('DELETE', `/rpg/houses/${houseId}`)).status).toBe(200);
    expect((await call('GET', `/rpg/houses/${houseId}`)).status).toBe(404);
  });
});
