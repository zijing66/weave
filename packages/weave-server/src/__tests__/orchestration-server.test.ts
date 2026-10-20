import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db/db.js';
import { setDaemonSettingsDb } from '../daemon/settings.js';
import { ProjectRepository } from '../repositories/projects.js';
import { SessionRepository } from '../repositories/sessions.js';
import {
  OrchestrationRepository,
  OrchestrationRunRepository,
  type OrchestrationEdge,
} from '../repositories/orchestrations.js';
import { AuthService } from '../daemon/dashboard-auth.js';
import { HookEventBus } from '../hooks/bus.js';
import { OrchestrationEngine } from '../hooks/orchestration-engine.js';
import type { SendInput, SendResult, PipeMessage } from '../hooks/message-deliverer.js';
import { createWeaveServer } from '../daemon/server.js';

/**
 * 编排域端到端：定义 CRUD 与图校验、触发/取消、公开 webhook（认证门豁免）、
 * 运行日志的筛选/翻页/清空、删编排保留日志。
 */

vi.setConfig({ testTimeout: 20000 });

let db: DatabaseSync;
let server: Server;
let port: number;
let dir: string;
let projectId: number;
let sessions: SessionRepository;
let orchestrations: OrchestrationRepository;
let runs: OrchestrationRunRepository;
let sent: SendInput[];

const url = (p: string): string => `http://127.0.0.1:${port}${p}`;
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const edge = (from: string, to: string): OrchestrationEdge => ({
  id: `${from}-${to}`,
  from,
  to,
  text: `msg ${from}->${to}`,
});

const graphBody = (over: Record<string, unknown> = {}) => ({
  name: 'chain',
  startSessionId: 'sa',
  startText: 'kick off',
  nodes: ['sa', 'sb'],
  edges: [edge('sa', 'sb')],
  ...over,
});

beforeAll(async () => {
  db = openDatabase(':memory:');
  setDaemonSettingsDb(openDatabase(':memory:'));
  dir = mkdtempSync(path.join(tmpdir(), 'weave-orch-srv-'));
  projectId = new ProjectRepository(db).register({
    path: dir,
    name: 'test',
    token: 'ptoken',
    source: 'init',
  }).id;
  sessions = new SessionRepository(db);
  for (const id of ['sa', 'sb', 'sc']) sessions.touch(id, projectId);
  orchestrations = new OrchestrationRepository(db);
  runs = new OrchestrationRunRepository(db);
  sent = [];
  const engine = new OrchestrationEngine({
    orchestrations,
    runs,
    deliverer: {
      send: async (input: SendInput): Promise<SendResult> => {
        sent.push(input);
        const msg: PipeMessage = {
          id: `m-${sent.length}`,
          sessionId: input.toSessionId,
          text: input.text,
          mode: input.mode,
          channel: 'prompt',
          status: 'delivered',
          at: new Date().toISOString(),
        };
        return { ok: true, messageId: msg.id, status: 'delivered', message: msg };
      },
    },
    sessions,
    bus: new HookEventBus(),
    livenessOf: () => new Map(),
  });
  const auth = new AuthService({
    authPath: path.join(dir, 'auth.json'),
    initialPasswordPath: path.join(dir, 'initial-password'),
  });
  server = createWeaveServer({
    projects: new ProjectRepository(db),
    port: 0,
    auth,
    hookSessions: sessions,
    orchestrations,
    orchestrationRuns: runs,
    orchestrationEngine: engine,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  server.close();
  setDaemonSettingsDb(null);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 管理面一律带本机令牌（门怎么放行不是这份测试的主题，webhook 那几条才验门）。 */
const localToken = async (): Promise<Record<string, string>> => {
  const { readFileSync } = await import('node:fs');
  const token = readFileSync(path.join(dir, 'auth.json'), 'utf8');
  return { 'x-weave-local': (JSON.parse(token) as { localToken: string }).localToken };
};

const adminFetch = async (p: string, init: RequestInit = {}): Promise<Response> =>
  fetch(url(p), { ...init, headers: { ...(init.headers ?? {}), ...(await localToken()) } });

describe('orchestration definitions', () => {
  it('无凭据的管理面 401，公开 webhook 路径不受门拦', async () => {
    expect((await fetch(url('/messaging/orchestrations'))).status).toBe(401);
    const webhook = await fetch(url('/webhooks/orchestrate/nope'), { method: 'POST' });
    expect(webhook.status).toBe(404);
  });

  it('图校验：起始会话必须在节点集里', async () => {
    const res = await adminFetch(
      '/messaging/orchestrations',
      json('POST', graphBody({ startSessionId: 'sc' })),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Start session must be part of the node set');
  });

  it('图校验：成环被拒', async () => {
    const res = await adminFetch(
      '/messaging/orchestrations',
      json('POST', graphBody({ edges: [edge('sa', 'sb'), edge('sb', 'sa')] })),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Cycle detected');
  });

  it('图校验：无名会话被拒', async () => {
    const res = await adminFetch(
      '/messaging/orchestrations',
      json('POST', graphBody({ nodes: ['sa', 'nope'], edges: [edge('sa', 'nope')] })),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Unknown session: nope');
  });

  it('边可只转发上游输出（正文空 + carryOutput），两者皆无则拒', async () => {
    const carry = await adminFetch(
      '/messaging/orchestrations',
      json('POST', graphBody({ edges: [{ ...edge('sa', 'sb'), text: '', carryOutput: true }] })),
    );
    expect(carry.status).toBe(201);
    const created = (await carry.json()).orchestration;
    expect(created.edges[0]).toMatchObject({ text: '', carryOutput: true });

    const mute = await adminFetch(
      '/messaging/orchestrations',
      json('POST', graphBody({ edges: [{ ...edge('sa', 'sb'), text: ' ' }] })),
    );
    expect(mute.status).toBe(400);
    expect((await mute.json()).error).toContain('has no message');

    await adminFetch(`/messaging/orchestrations/${created.id}`, { method: 'DELETE' });
  });

  it('交接总结指令随定义存取（PUT 省略即保持原值）', async () => {
    const res = await adminFetch(
      '/messaging/orchestrations',
      json('POST', graphBody({ handoffPrompt: '请按交接格式总结' })),
    );
    expect(res.status).toBe(201);
    const created = (await res.json()).orchestration;
    expect(created.handoffPrompt).toBe('请按交接格式总结');

    const put = await adminFetch(
      `/messaging/orchestrations/${created.id}`,
      json('PUT', { name: 'renamed' }),
    );
    expect((await put.json()).orchestration).toMatchObject({
      name: 'renamed',
      handoffPrompt: '请按交接格式总结',
    });
    await adminFetch(`/messaging/orchestrations/${created.id}`, { method: 'DELETE' });
  });

  it('创建返回定义 + webhook token，列表可按项目过滤', async () => {
    const res = await adminFetch('/messaging/orchestrations', json('POST', graphBody()));
    expect(res.status).toBe(201);
    const { orchestration } = await res.json();
    expect(orchestration).toMatchObject({
      name: 'chain',
      projectId,
      startSessionId: 'sa',
      startText: 'kick off',
      cron: null,
      nextRunAt: null,
    });
    expect(orchestration.webhookToken).toMatch(/^[A-Za-z0-9_-]{10,}$/);

    const mine = await adminFetch(`/messaging/orchestrations?projectId=${projectId}`);
    expect(((await mine.json()) as { orchestrations: unknown[] }).orchestrations).toHaveLength(1);
    const other = await adminFetch('/messaging/orchestrations?projectId=999');
    expect(((await other.json()) as { orchestrations: unknown[] }).orchestrations).toHaveLength(0);
  });

  it('PUT 改 cron 回 nextRunAt；非法 cron 400', async () => {
    const id = orchestrations.list()[0]!.id;
    const ok = await adminFetch(
      `/messaging/orchestrations/${id}`,
      json('PUT', { cron: '0 9 * * 1-5' }),
    );
    expect(ok.status).toBe(200);
    expect((await ok.json()).orchestration.nextRunAt).toMatch(/T/);

    const bad = await adminFetch(`/messaging/orchestrations/${id}`, json('PUT', { cron: 'nope' }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain('Invalid cron expression');
    expect(orchestrations.getById(id)!.cron).toBe('0 9 * * 1-5');
  });

  it('PUT 部分更新沿用未给字段；未知 id 404', async () => {
    const id = orchestrations.list()[0]!.id;
    const res = await adminFetch(`/messaging/orchestrations/${id}`, json('PUT', { name: 'renamed' }));
    expect(res.status).toBe(200);
    expect((await res.json()).orchestration).toMatchObject({ name: 'renamed', startSessionId: 'sa' });
    expect(
      (await adminFetch('/messaging/orchestrations/9999', json('PUT', { name: 'x' }))).status,
    ).toBe(404);
  });
});

describe('orchestration runs', () => {
  let orchId: number;

  beforeAll(() => {
    orchId = orchestrations.list()[0]!.id;
  });

  it('触发建一次运行；再触发 409', async () => {
    const res = await adminFetch(`/messaging/orchestrations/${orchId}/trigger`, json('POST', {}));
    expect(res.status).toBe(201);
    const { runId } = await res.json();
    expect(sent.at(-1)).toMatchObject({ toSessionId: 'sa', text: 'kick off' });

    const again = await adminFetch(`/messaging/orchestrations/${orchId}/trigger`, {
      method: 'POST',
    });
    expect(again.status).toBe(409);

    const detail = await adminFetch(`/messaging/orchestration-runs/${runId}`);
    expect(detail.status).toBe(200);
    const { run } = await detail.json();
    expect(run).toMatchObject({ orchestrationId: orchId, trigger: 'manual', status: 'running' });
    expect(run.state.pending.sa).toHaveLength(1);
  });

  it('手动触发可带首步消息覆盖起始文本', async () => {
    const id = orchestrations.insert({
      name: 'second',
      projectId,
      startSessionId: 'sc',
      startText: 'fallback',
      nodes: ['sc'],
      edges: [],
    }).id;
    const res = await adminFetch(`/messaging/orchestrations/${id}/trigger`, json('POST', { text: 'from hook' }));
    expect(res.status).toBe(201);
    expect(sent.at(-1)).toMatchObject({ toSessionId: 'sc', text: 'from hook' });
    await adminFetch(`/messaging/orchestration-runs/${(await res.json()).runId}/cancel`, {
      method: 'POST',
    });
  });

  it('取消运行；已落定的再取消 409，未知 run 404', async () => {
    const running = runs.listRunning()[0]!;
    const res = await adminFetch(`/messaging/orchestration-runs/${running.id}/cancel`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(runs.getById(running.id)!.status).toBe('cancelled');
    const again = await adminFetch(`/messaging/orchestration-runs/${running.id}/cancel`, {
      method: 'POST',
    });
    expect(again.status).toBe(409);
    expect(
      (await adminFetch('/messaging/orchestration-runs/9999/cancel', { method: 'POST' })).status,
    ).toBe(404);
  });

  it('日志按编排/状态/名字筛，未知状态 400', async () => {
    const all = await adminFetch(`/messaging/orchestration-runs?orchestrationId=${orchId}`);
    const { runs: rows } = await all.json();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: { orchestrationId: number }) => r.orchestrationId === orchId)).toBe(true);
    expect(rows[0]).not.toHaveProperty('state');
    expect(rows[0]).toHaveProperty('pendingCounts');

    const cancelled = await adminFetch(
      `/messaging/orchestration-runs?status=cancelled&projectId=${projectId}`,
    );
    expect(((await cancelled.json()) as { runs: unknown[] }).runs.length).toBeGreaterThan(0);
    const byName = await adminFetch('/messaging/orchestration-runs?text=second');
    expect(
      ((await byName.json()) as { runs: Array<{ orchestrationName: string }> }).runs.every(
        (r) => r.orchestrationName === 'second',
      ),
    ).toBe(true);

    const bad = await adminFetch('/messaging/orchestration-runs?status=nope');
    expect(bad.status).toBe(400);
  });

  it('日志翻页走 before 游标', async () => {
    for (let i = 0; i < 3; i++) {
      runs.insert({ orchestrationId: orchId, orchestrationName: 'chain', projectId, trigger: 'cron' });
    }
    const first = await adminFetch(`/messaging/orchestration-runs?limit=2&projectId=${projectId}`);
    const page = await first.json();
    expect(page.runs).toHaveLength(2);
    expect(page.nextBefore).toBe(page.runs[1].id);
    const second = await adminFetch(
      `/messaging/orchestration-runs?limit=2&before=${page.nextBefore}&projectId=${projectId}`,
    );
    const next = await second.json();
    expect(next.runs.every((r: { id: number }) => r.id < page.nextBefore)).toBe(true);
  });

  it('清空只删终态（scope=finished），全清连运行中的先停手', async () => {
    const id = orchestrations.insert({
      name: 'to-clear',
      projectId,
      startSessionId: 'sc',
      startText: 'x',
      nodes: ['sc'],
      edges: [],
    }).id;
    const started = await adminFetch(`/messaging/orchestrations/${id}/trigger`, {
      method: 'POST',
    });
    expect(started.status).toBe(201);

    const cleared = await adminFetch('/messaging/orchestration-runs?scope=finished', {
      method: 'DELETE',
    });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { deleted: number }).deleted).toBeGreaterThan(0);
    // 运行中的那行还在：finished 不碰在飞
    expect(runs.listRunning().some((r) => r.orchestrationId === id)).toBe(true);

    const all = await adminFetch(`/messaging/orchestration-runs?scope=all&projectId=${projectId}`, {
      method: 'DELETE',
    });
    expect(all.status).toBe(200);
    expect(runs.listRunning().filter((r) => r.projectId === projectId)).toHaveLength(0);
  });

  it('删编排停掉在飞运行；日志照旧保留', async () => {
    const id = orchestrations.list().find((o) => o.name === 'to-clear')!.id;
    await adminFetch(`/messaging/orchestrations/${id}/trigger`, { method: 'POST' });
    const before = runs.query({ orchestrationId: id }).runs.length;
    expect(before).toBeGreaterThan(0);
    expect((await adminFetch(`/messaging/orchestrations/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect(orchestrations.getById(id)).toBeUndefined();
    expect(runs.listRunning().some((r) => r.orchestrationId === id)).toBe(false);
    expect(runs.query({ orchestrationId: id }).runs.length).toBe(before);
    expect((await adminFetch(`/messaging/orchestrations/${id}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('webhook trigger', () => {
  it('token 触发免认证；载荷当首步消息；错 token 404', async () => {
    const id = orchestrations.insert({
      name: 'hook',
      projectId,
      startSessionId: 'sb',
      startText: 'fallback',
      nodes: ['sb'],
      edges: [],
    }).id;
    const token = orchestrations.getById(id)!.webhookToken!;

    const res = await fetch(url(`/webhooks/orchestrate/${token}`), {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'deploy finished',
    });
    expect(res.status).toBe(202);
    expect(sent.at(-1)).toMatchObject({ toSessionId: 'sb', text: 'deploy finished' });
    const { runId } = await res.json();
    expect(runs.getById(runId)).toMatchObject({ trigger: 'webhook' });

    // 同一次运行没落定前再打一次 = 409（不排队、不重入）
    const dup = await fetch(url(`/webhooks/orchestrate/${token}`), { method: 'POST' });
    expect(dup.status).toBe(409);
    expect(runs.getById(runId)!.trigger).toBe('webhook');

    expect((await fetch(url('/webhooks/orchestrate/unknown'), { method: 'POST' })).status).toBe(404);

    // 空载荷回落编排自己的起始文本
    await adminFetch(`/messaging/orchestration-runs/${runId}/cancel`, { method: 'POST' });
    const empty = await fetch(url(`/webhooks/orchestrate/${token}`), { method: 'POST' });
    expect(empty.status).toBe(202);
    expect(sent.at(-1)).toMatchObject({ toSessionId: 'sb', text: 'fallback' });
    await adminFetch(`/messaging/orchestration-runs/${(await empty.json()).runId}/cancel`, {
      method: 'POST',
    });
  });

  it('rotate-webhook 换 token，旧 token 立即失效', async () => {
    const row = orchestrations.list().find((o) => o.name === 'hook')!;
    const old = row.webhookToken!;
    const res = await adminFetch(`/messaging/orchestrations/${row.id}/rotate-webhook`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const { webhookToken } = await res.json();
    expect(webhookToken).not.toBe(old);
    expect((await fetch(url(`/webhooks/orchestrate/${old}`), { method: 'POST' })).status).toBe(404);
    expect(
      (await fetch(url(`/webhooks/orchestrate/${webhookToken}`), { method: 'POST' })).status,
    ).toBe(202);
    expect(
      (await adminFetch('/messaging/orchestrations/9999/rotate-webhook', { method: 'POST' })).status,
    ).toBe(404);
  });
});

describe('api-log masking', () => {
  it('webhook 路径里的 token 不落盘', async () => {
    const { maskPath } = await import('../daemon/api-log.js');
    expect(maskPath('/webhooks/orchestrate/abc123?x=1')).toBe(
      '/webhooks/orchestrate/[redacted]?x=1',
    );
    expect(maskPath('/messaging/orchestrations?token=abc')).toBe(
      '/messaging/orchestrations?token=abc',
    );
  });
});
