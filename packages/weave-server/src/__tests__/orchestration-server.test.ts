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
  type OrchestrationNode,
} from '../repositories/orchestrations.js';
import { AuthService } from '../daemon/dashboard-auth.js';
import { HookEventBus } from '../hooks/bus.js';
import { OrchestrationEngine } from '../hooks/orchestration-engine.js';
import type { SendInput, SendResult, PipeMessage } from '../hooks/message-deliverer.js';
import { createWeaveServer } from '../daemon/server.js';

/**
 * 编排域端到端：定义 CRUD 与图校验（多入口/webhook 节点）、触发/取消、
 * 公开 webhook（认证门豁免）、运行日志的筛选/翻页/清空、删编排保留日志。
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

const sNode = (id: string): OrchestrationNode => ({ id, kind: 'session' });
const wNode = (id: string): OrchestrationNode => ({ id, kind: 'webhook' });

const graphBody = (over: Record<string, unknown> = {}) => ({
  name: 'chain',
  startText: 'kick off',
  nodes: [sNode('sa'), sNode('sb')],
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
      json('POST', graphBody({ nodes: [sNode('sa'), sNode('nope')], edges: [edge('sa', 'nope')] })),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Unknown session: nope');
  });

  it('图校验：webhook-only 缺 projectId / webhook 出口缺 URL / 中间 webhook 节点被拒', async () => {
    const webhookOnly = await adminFetch(
      '/messaging/orchestrations',
      json('POST', graphBody({ nodes: [wNode('w:in')], edges: [] })),
    );
    expect(webhookOnly.status).toBe(400);

    const noUrl = await adminFetch(
      '/messaging/orchestrations',
      json('POST', graphBody({ nodes: [sNode('sa'), wNode('w:out')], edges: [edge('sa', 'w:out')] })),
    );
    expect(noUrl.status).toBe(400);
    expect((await noUrl.json()).error).toContain('http(s)');

    const middle = await adminFetch(
      '/messaging/orchestrations',
      json(
        'POST',
        graphBody({
          nodes: [sNode('sa'), wNode('w:mid'), sNode('sb')],
          edges: [edge('sa', 'w:mid'), edge('w:mid', 'sb')],
        }),
      ),
    );
    expect(middle.status).toBe(400);
    expect((await middle.json()).error).toContain('both inbound and outbound');
  });

  it('空正文只在 webhook 入口的出边上放行', async () => {
    const ok = await adminFetch(
      '/messaging/orchestrations',
      json(
        'POST',
        graphBody({
          nodes: [wNode('w:in'), sNode('sb')],
          edges: [{ ...edge('w:in', 'sb'), text: '' }],
        }),
      ),
    );
    expect(ok.status).toBe(201);
    const created = (await ok.json()).orchestration;
    expect(created.nodes[0]).toMatchObject({ id: 'w:in', kind: 'webhook' });
    expect(created.nodes[0].webhookToken).toMatch(/^[A-Za-z0-9_-]{10,}$/);

    const mute = await adminFetch(
      '/messaging/orchestrations',
      json('POST', graphBody({ edges: [{ ...edge('sa', 'sb'), text: ' ' }] })),
    );
    expect(mute.status).toBe(400);
    expect((await mute.json()).error).toContain('has no message');

    // 提取指令 + 空正文合法（{summary} 填充）；extract 随定义往返
    const withExtract = await adminFetch(
      '/messaging/orchestrations',
      json(
        'POST',
        graphBody({ edges: [{ ...edge('sa', 'sb'), text: '', extract: '请总结这一轮' }] }),
      ),
    );
    expect(withExtract.status).toBe(201);
    const extracted = (await withExtract.json()).orchestration;
    expect(extracted.edges[0]).toMatchObject({ text: '', extract: '请总结这一轮' });
    await adminFetch(`/messaging/orchestrations/${extracted.id}`, { method: 'DELETE' });

    await adminFetch(`/messaging/orchestrations/${created.id}`, { method: 'DELETE' });
  });

  it('创建返回定义（enabled 缺省 true），列表可按项目过滤', async () => {
    const res = await adminFetch('/messaging/orchestrations', json('POST', graphBody()));
    expect(res.status).toBe(201);
    const { orchestration } = await res.json();
    expect(orchestration).toMatchObject({
      name: 'chain',
      projectId,
      startText: 'kick off',
      enabled: true,
      cron: null,
      nextRunAt: null,
    });
    expect(orchestration.startSessionId).toBeUndefined();

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
    expect((await res.json()).orchestration).toMatchObject({ name: 'renamed', startText: 'kick off' });
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
    // 详情行要同时带 summary 的 pendingCounts 与原始 state——web 展开行直接顶替
    // 列表行渲染，缺 pendingCounts 会让 Object.values 崩（回归）。
    expect(run.pendingCounts).toEqual({ sa: 1 });
  });

  it('手动触发可带首步消息与入口子集', async () => {
    const id = orchestrations.insert({
      name: 'second',
      projectId,
      startText: 'fallback',
      nodes: [sNode('sc'), sNode('sb')],
      edges: [],
    }).id;
    const res = await adminFetch(
      `/messaging/orchestrations/${id}/trigger`,
      json('POST', { text: 'from hook', entries: ['sb'] }),
    );
    expect(res.status).toBe(201);
    expect(sent.at(-1)).toMatchObject({ toSessionId: 'sb', text: 'from hook' });
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
      startText: 'x',
      nodes: [sNode('sc')],
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

describe('webhook entry trigger', () => {
  it('节点 token 触发免认证；载荷随出边正文下发；错 token 404', async () => {
    const id = orchestrations.insert({
      name: 'hook',
      projectId,
      startText: 'fallback',
      nodes: [wNode('w:in'), sNode('sb')],
      edges: [{ ...edge('w:in', 'sb'), text: 'go' }],
    }).id;
    const token = orchestrations.getById(id)!.nodes[0]!.webhookToken!;

    const res = await fetch(url(`/webhooks/orchestrate/${token}`), {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'deploy finished',
    });
    expect(res.status).toBe(202);
    expect(sent.at(-1)).toMatchObject({ toSessionId: 'sb', text: 'go\n\ndeploy finished' });
    const { runId } = await res.json();
    expect(runs.getById(runId)).toMatchObject({ trigger: 'webhook' });

    // 同一次运行没落定前再打一次 = 409（不排队、不重入）
    const dup = await fetch(url(`/webhooks/orchestrate/${token}`), { method: 'POST' });
    expect(dup.status).toBe(409);
    expect(runs.getById(runId)!.trigger).toBe('webhook');

    expect((await fetch(url('/webhooks/orchestrate/unknown'), { method: 'POST' })).status).toBe(404);

    // 空载荷 = 只发出边正文
    await adminFetch(`/messaging/orchestration-runs/${runId}/cancel`, { method: 'POST' });
    const empty = await fetch(url(`/webhooks/orchestrate/${token}`), { method: 'POST' });
    expect(empty.status).toBe(202);
    expect(sent.at(-1)).toMatchObject({ toSessionId: 'sb', text: 'go' });
    await adminFetch(`/messaging/orchestration-runs/${(await empty.json()).runId}/cancel`, {
      method: 'POST',
    });
  });

  it('rotate-webhook 按节点换 token，旧 token 立即失效', async () => {
    const row = orchestrations.list().find((o) => o.name === 'hook')!;
    const old = row.nodes[0]!.webhookToken!;
    const res = await adminFetch(
      `/messaging/orchestrations/${row.id}/rotate-webhook`,
      json('POST', { nodeId: 'w:in' }),
    );
    expect(res.status).toBe(200);
    const { webhookToken } = await res.json();
    expect(webhookToken).not.toBe(old);
    expect((await fetch(url(`/webhooks/orchestrate/${old}`), { method: 'POST' })).status).toBe(404);
    expect(
      (await fetch(url(`/webhooks/orchestrate/${webhookToken}`), { method: 'POST' })).status,
    ).toBe(202);
    expect(
      (
        await adminFetch('/messaging/orchestrations/9999/rotate-webhook', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ nodeId: 'w:in' }),
        })
      ).status,
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
