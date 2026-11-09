import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntimeRegistry } from '@weavecode/harness';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { createWeaveServer } from '../../daemon/server.js';
import { setDaemonSettingsDb, writeDaemonSettings } from '../../daemon/settings.js';
import {
  RpgGrowthRepository,
  RpgHexagramRepository,
  RpgRoleRepository,
  RpgScoreRepository,
} from '../roles.js';
import type { ProjectOpener } from '../../daemon/opener.js';

/**
 * 动词门面 e2e（D1 验收④，路由级）：修炼 / 组队 / 出征 / 传音四动词各走一枚
 * /rpg/* 端点。引擎与投递器按 deps Pick 形状注入 fake（路由级不验底层域，
 * 底层行为各自测试已盖）；游戏事实（growth/score/hexagram）走真表断言。
 */
describe('POST /rpg/* 动词门面（修炼/组队/出征/传音）', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let rolesRoot: string;
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
    rolesRoot = mkdtempSync(path.join(tmpdir(), 'weave-rpg-verbs-e2e-'));
    tmpDirs.push(rolesRoot);
    const hooksTmp = mkdtempSync(path.join(tmpdir(), 'weave-rpg-verbs-hooks-'));
    tmpDirs.push(hooksTmp);
    const opener: ProjectOpener = {
      openExplorer: async () => {},
      openTerminal: async () => {},
      runInTerminal: async () => {},
    };
    server = createWeaveServer({
      projects: new ProjectRepository(db),
      port: 0,
      harnesses: createRuntimeRegistry(),
      opener,
      hooksDir: hooksTmp,
      rpgRoles: new RpgRoleRepository(db),
      rpgGrowth: new RpgGrowthRepository(db),
      rpgScores: new RpgScoreRepository(db),
      rpgHexagram: new RpgHexagramRepository(db),
      rpgRolesRoot: rolesRoot,
      // fake 引擎/投递器（路由只认 Pick 形状）：出征/传音的转发行为由各自单测盖
      orchestrationEngine: {
        start: async () => ({ ok: true, runId: 42 }),
        cancel: async () => ({ ok: true }),
      },
      orchestrations: {
        getById: (id: number) =>
          id === 5
            ? { id, name: 'gank', projectId: 1, startText: '', nodes: [], edges: [], enabled: true, cron: null, lastCronAt: null, createdAt: '', updatedAt: '' }
            : undefined,
      } as never,
      messageDeliverer: {
        send: async (input: { toSessionId: string; text: string }) =>
          input.text === 'boom'
            ? { ok: false as const, status: 409 as const, error: 'stalled' }
            : { ok: true as const, messageId: 'm-9', status: 'delivered' },
      },
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

  it('修炼：POST /rpg/roles/:id/cultivate → skill 落仓库 + 三样游戏事实', async () => {
    await call('POST', '/rpg/roles', { name: 'cultivator-e2e', archetype: '思考' });
    const list = (await (await call('GET', '/rpg/roles')).json()) as {
      roles: Array<{ id: number; name: string }>;
    };
    const role = list.roles.find((r) => r.name === 'cultivator-e2e')!;
    const src = mkdtempSync(path.join(tmpdir(), 'weave-rpg-verbs-skill-'));
    tmpDirs.push(src);
    const skillDir = path.join(src, 'qi-basic');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: qi-basic\n---\n# 吐纳\n');

    const res = await call('POST', `/rpg/roles/${role.id}/cultivate`, {
      skill: 'qi-basic',
      sourceDir: skillDir,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; score: number; hexagon: Record<string, number> };
    expect(body.ok).toBe(true);
    expect(body.hexagon['智慧']).toBe(6); // 思考基线 5 + 1 门修炼
    // 三样事实：growth / score / hexagon 读面
    const growth = (await (await call('GET', `/rpg/roles/${role.id}/growth`)).json()) as {
      growth: Array<{ verb: string; target: string }>;
    };
    expect(growth.growth[0]).toMatchObject({ verb: 'cultivate', target: 'qi-basic' });
    const hex = await call('GET', `/rpg/roles/${role.id}/hexagon`);
    expect(hex.status).toBe(200);
    const hexBody = (await hex.json()) as { dims: Record<string, number>; score: { score: number } | null };
    expect(hexBody.dims['智慧']).toBe(6);
    expect(hexBody.score?.score).toBe(body.score);
    // 重复修炼同名 409
    expect((await call('POST', `/rpg/roles/${role.id}/cultivate`, { skill: 'qi-basic', sourceDir: skillDir })).status).toBe(409);
  });

  it('组队：POST /rpg/teams → coordinator teams/ 文件落盘', async () => {
    const res = await call('POST', '/rpg/teams', {
      name: 'sprint-e2e',
      goal: '攻下登录页',
      roles: [{ role: 'thinker' }],
      playbook: 'sprint-flow',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; file: string };
    expect(body.ok).toBe(true);
    expect(body.file.startsWith(path.join(rolesRoot, '..', 'coordinator', 'teams'))).toBe(true);
  });

  it('出征：POST /rpg/roles/:id/expedition → 引擎转发 + 成长记录', async () => {
    const list = (await (await call('GET', '/rpg/roles')).json()) as {
      roles: Array<{ id: number; name: string }>;
    };
    const role = list.roles.find((r) => r.name === 'cultivator-e2e')!;
    const res = await call('POST', `/rpg/roles/${role.id}/expedition`, { orchId: 5, text: '出征' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; runId: number; orchName: string };
    expect(body).toMatchObject({ ok: true, runId: 42, orchName: 'gank' });
    // 编排缺失 404
    expect((await call('POST', `/rpg/roles/${role.id}/expedition`, { orchId: 999 })).status).toBe(404);
  });

  it('传音：POST /rpg/roles/:id/message → 投递器转发；失败 409 不落成长', async () => {
    const list = (await (await call('GET', '/rpg/roles')).json()) as {
      roles: Array<{ id: number; name: string }>;
    };
    const role = list.roles.find((r) => r.name === 'cultivator-e2e')!;
    const ok = await call('POST', `/rpg/roles/${role.id}/message`, { toSessionId: 'sess-a', text: '你好' });
    expect(ok.status).toBe(200);
    const bad = await call('POST', `/rpg/roles/${role.id}/message`, { toSessionId: 'sess-a', text: 'boom' });
    expect(bad.status).toBe(409);
    const growth = (await (await call('GET', `/rpg/roles/${role.id}/growth`)).json()) as {
      growth: Array<{ verb: string }>;
    };
    expect(growth.growth.filter((g) => g.verb === 'transmit')).toHaveLength(1);
  });
});
