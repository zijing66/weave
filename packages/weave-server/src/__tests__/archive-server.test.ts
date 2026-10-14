import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntimeRegistry } from '@weavecode/harness';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { HookEventRepository } from '../repositories/hook-events.js';
import { HookDispatchRepository } from '../repositories/hook-dispatches.js';
import { SessionRepository } from '../repositories/sessions.js';
import { createWeaveServer } from '../daemon/server.js';
import { setDaemonSettingsDb } from '../daemon/settings.js';
import { drainInboxOnce, type InboxDrainDeps } from '../hooks/inbox-worker.js';
import { hookShardId, hooksRoot, mirrorPathOf, outboxPathOf } from '../hooks/mirror.js';
import { MessageDeliverer } from '../hooks/message-deliverer.js';
import { HookEventBus } from '../hooks/bus.js';
import { promptboxPathOf } from '../hooks/promptbox.js';

const TOK_A = 'tok-archive-a';
const TOK_B = 'tok-archive-b';

function inboxLine(token: string, eventType: string, sessionId = 's1'): string {
  return (
    JSON.stringify({
      v: 1,
      token,
      report: {
        source: 'claude',
        eventType,
        sessionId,
        cwd: '/proj',
        payload: JSON.stringify({ hook_event_name: eventType, session_id: sessionId, cwd: '/proj' }),
      },
    }) + '\n'
  );
}

describe('项目归档（POST /projects/:id/archive · restore · 消费面跳过）', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let hooksDir: string;
  let projects: ProjectRepository;
  let hookEvents: HookEventRepository;
  let sessions: SessionRepository;
  let dispatches: HookDispatchRepository;
  let deliverer: MessageDeliverer;
  let idA: number;
  let idB: number;

  const get = (p: string) => fetch(`http://127.0.0.1:${port}/api${p}`);
  const post = (p: string) =>
    fetch(`http://127.0.0.1:${port}/api${p}`, { method: 'POST' });

  beforeAll(async () => {
    db = openDatabase(':memory:');
    projects = new ProjectRepository(db);
    hookEvents = new HookEventRepository(db);
    sessions = new SessionRepository(db);
    dispatches = new HookDispatchRepository(db);
    setDaemonSettingsDb(db);
    // 派发行有 rule_id 外键（ON DELETE CASCADE），先落一条规则行
    db.prepare(
      `INSERT INTO hook_rules (id, name, source, filter, handler, created_at, updated_at)
       VALUES ('rule-arch', 'r', '{"kind":"hook-event","event":"UserPromptSubmit","harness":"claude"}', '{}', '{"type":"log"}', ?, ?)`,
    ).run(new Date().toISOString(), new Date().toISOString());

    hooksDir = await mkdtemp(path.join(tmpdir(), 'weave-archive-'));
    mkdirSync(path.join(hooksDir, 'inbox'), { recursive: true });
    mkdirSync(path.join(hooksDir, 'mirror'), { recursive: true });
    mkdirSync(path.join(hooksDir, 'outbox'), { recursive: true });

    idA = projects.register({ path: '/proj-a', name: 'a', token: TOK_A, source: 'init' }).id;
    const b = projects.register({ path: '/proj-b', name: 'b', token: TOK_B, source: 'init' });
    idB = b.id;
    // B 的历史会话：会话行 + 事件 + 指令池派发（三条删除路径全覆盖）
    sessions.touch('sess-b1', idB);
    sessions.touch('sess-b2', idB);
    const ev1 = hookEvents.insert({ projectId: idB, source: 'claude', eventType: 'UserPromptSubmit', sessionId: 'sess-b1', payload: '{}' });
    hookEvents.insert({ projectId: idB, source: 'claude', eventType: 'Stop', sessionId: 'sess-b2', payload: '{}' });
    hookEvents.insert({ projectId: idA, source: 'claude', eventType: 'Stop', sessionId: 'sess-a1', payload: '{}' });
    dispatches.insert({ ruleId: 'rule-arch', eventId: ev1, sessionId: 'sess-b1', prompt: 'do', status: 'pending', mode: 'manual' });
    // B 的会话消息（消息域第四条删除路径——管道口径：prompt 队列行）
    deliverer = new MessageDeliverer({
      sessions, projects, hookEvents, bus: new HookEventBus(), hooksDir,
    });
    const queued = await deliverer.send({
      toSessionId: 'sess-b1',
      text: 'msg',
      mode: 'prompt',
      fromKind: 'dashboard',
    });
    if (!queued.ok) throw new Error(`seed prompt message failed: ${queued.error}`);
    // B 的管道文件（inbox 活文件 + mirror + outbox）——归档即焚的对象
    writeFileSync(path.join(hooksDir, 'inbox', `${hookShardId(TOK_B)}.jsonl`), inboxLine(TOK_B, 'Stop', 'sess-b1'));
    writeFileSync(mirrorPathOf(hooksDir, hookShardId(TOK_B)), '{}');
    writeFileSync(outboxPathOf(hooksDir, hookShardId(TOK_B)), '');
    // A 的管道文件必须原样保留（焚毁只针对被归档项目）
    writeFileSync(path.join(hooksDir, 'inbox', `${hookShardId(TOK_A)}.jsonl`), inboxLine(TOK_A, 'Stop', 'sess-a1'));

    server = createWeaveServer({
      projects,
      port: 0,
      hookEvents,
      hookSessions: sessions,
      hookDispatches: dispatches,
      messageDeliverer: deliverer,
      hooksDir,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    server.close();
    setDaemonSettingsDb(null);
    db.close();
    await rm(hooksDir, { recursive: true, force: true });
  });

  it('归档：清空历史会话（派发/事件/会话行）+ 焚毁管道文件，活跃列表即刻除名', async () => {
    const res = await post(`/projects/${idB}/archive`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      project: { archivedAt: string | null };
      purged: { events: number; dispatches: number; sessions: number; messages: number };
    };
    expect(data.project.archivedAt).toBeTruthy();
    // 事件 2（B 的）+ 派发 1 + 会话 2（B 的）+ 消息 1（B 的队列行）——A 的一概不动
    expect(data.purged).toEqual({ events: 2, dispatches: 1, sessions: 2, messages: 1 });
    expect(hookEvents.listByProject(idB)).toHaveLength(0);
    expect(sessions.list(idB)).toHaveLength(0);
    expect(dispatches.list({ sessionId: 'sess-b1' })).toHaveLength(0);
    expect(hookEvents.listByProject(idA)).toHaveLength(1);
    expect(deliverer.hasQueued('sess-b1')).toBe(false);

    // 管道文件：B 的四处焚毁（含 promptbox），A 的原样
    expect(existsSync(path.join(hooksDir, 'inbox', `${hookShardId(TOK_B)}.jsonl`))).toBe(false);
    expect(existsSync(mirrorPathOf(hooksDir, hookShardId(TOK_B)))).toBe(false);
    expect(existsSync(outboxPathOf(hooksDir, hookShardId(TOK_B)))).toBe(false);
    expect(existsSync(promptboxPathOf(hooksDir, hookShardId(TOK_B)))).toBe(false);
    expect(existsSync(path.join(hooksDir, 'inbox', `${hookShardId(TOK_A)}.jsonl`))).toBe(true);
  });

  it('GET /projects 只剩活跃；GET /projects/archived 只有归档行（基础信息在）', async () => {
    const active = (await (await get('/projects')).json()) as { projects: Array<{ id: number }> };
    expect(active.projects.map((p) => p.id)).toEqual([idA]);
    const archived = (await (await get('/projects/archived')).json()) as {
      projects: Array<{ id: number; token: string; archivedAt: string | null }>;
    };
    expect(archived.projects.map((p) => p.id)).toEqual([idB]);
    expect(archived.projects[0]!.token).toBe(TOK_B); // 基础信息保留，可恢复
    expect(archived.projects[0]!.archivedAt).toBeTruthy();
  });

  it('重复归档幂等：不再动数据（purged 全零）', async () => {
    const res = await post(`/projects/${idB}/archive`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { purged: { events: number; dispatches: number; sessions: number; messages: number } };
    expect(data.purged).toEqual({ events: 0, dispatches: 0, sessions: 0, messages: 0 });
  });

  it('归档项目的 inbox 行即焚：消费其他项目的同一轮 drain 里销毁，不入库', () => {
    // B 已归档：hook 仍在项目侧写 inbox（归档不碰用户项目文件），server 消费时焚毁
    const fileB = path.join(hooksDir, 'inbox', `${hookShardId(TOK_B)}.jsonl`);
    writeFileSync(fileB, inboxLine(TOK_B, 'SessionStart', 'sess-b3'));
    const fileA = path.join(hooksDir, 'inbox', `${hookShardId(TOK_A)}.jsonl`);
    writeFileSync(fileA, inboxLine(TOK_A, 'Stop', 'sess-a1'));

    const deps: InboxDrainDeps = {
      hooksDir,
      projects,
      hookEvents,
      hookSessions: sessions,
      adapters: createRuntimeRegistry().byCapability('events').flatMap((d) => d.events ?? []),
    };
    const records = drainInboxOnce(deps);
    // 只有 A 的行入库；B 的行被焚（不进 records、不建会话、文件删除）
    expect(records.map((r) => r.projectId)).toEqual([idA]);
    expect(hookEvents.listByProject(idB)).toHaveLength(0);
    expect(sessions.list(idB)).toHaveLength(0);
    expect(existsSync(fileB)).toBe(false);
    expect(existsSync(fileA)).toBe(false); // A 的是正常消费后删除
  });

  it('恢复：回到活跃列表、归档面除名；会话历史不回来（删除不是暂停）', async () => {
    const res = await post(`/projects/${idB}/restore`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { project: { archivedAt: string | null } };
    expect(data.project.archivedAt).toBeNull();

    const active = (await (await get('/projects')).json()) as { projects: Array<{ id: number }> };
    expect(active.projects.map((p) => p.id).sort()).toEqual([idA, idB].sort());
    const archived = (await (await get('/projects/archived')).json()) as { projects: unknown[] };
    expect(archived.projects).toHaveLength(0);
    expect(sessions.list(idB)).toHaveLength(0);
  });

  it('恢复幂等：活跃项目的 restore 是 no-op', async () => {
    const res = await post(`/projects/${idB}/restore`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { project: { id: number; archivedAt: string | null } };
    expect(data.project.id).toBe(idB);
    expect(data.project.archivedAt).toBeNull();
  });

  it('未知项目：404', async () => {
    expect((await post('/projects/9999/archive')).status).toBe(404);
    expect((await post('/projects/9999/restore')).status).toBe(404);
  });

  it('hooksRoot 默认根不受测试注入影响（生产装配走缺省值）', () => {
    // 仅守护：注入的 hooksDir 只是测试替身，模块缺省仍是全局数据目录
    expect(hooksRoot()).not.toBe(hooksDir);
  });
});

describe('ProjectRepository 归档语义', () => {
  it('归档清 sort_order（退出活跃排序局）；register 不隐式解档', () => {
    const db = openDatabase(':memory:');
    try {
      const projects = new ProjectRepository(db);
      db.prepare('UPDATE projects SET sort_order = 3 WHERE id = ?').run(
        projects.register({ path: '/p', name: 'p', token: 'tk', source: 'init' }).id,
      );

      const row = projects.list()[0]!;
      projects.setArchived(row.id, true);
      expect(projects.list()).toHaveLength(0);
      const archived = projects.listArchived()[0]!;
      expect(archived.sortOrder).toBeNull();
      expect(archived.archivedAt).toBeTruthy();

      // weave init 再次注册（如用户在归档项目里重跑）→ 仍归档，恢复只能走归档面
      projects.register({ path: '/p', name: 'p2', token: 'tk2', source: 'init' });
      expect(projects.list()).toHaveLength(0);
      expect(projects.listArchived()).toHaveLength(1);
      expect(projects.listArchived()[0]!.name).toBe('p'); // 名字也保留原值

      projects.setArchived(row.id, false);
      expect(projects.list()).toHaveLength(1);
      expect(projects.listArchived()).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
