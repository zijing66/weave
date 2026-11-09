import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer as netCreate } from 'node:net';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { ExtensionBindingRepository } from '../../repositories/extension-bindings.js';
import { createWeaveServer } from '../../daemon/server.js';
import { ExtensionEngine } from '../../hooks/extension-engine.js';
import { MessageDeliverer } from '../../hooks/message-deliverer.js';
import { HookEventBus } from '../../hooks/bus.js';
import { HookEventRepository } from '../../repositories/hook-events.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { postJson } from '../../hooks/handlers/webhook.js';

/**
 * 外部 webhook 扇入复活（F1，§1.6 接线清单）：POST /webhooks/extensions/<token>
 * token 即凭证（认证豁免段）→ 引擎同一套管线（执行日志 trigger='external-webhook'）
 * → session 端点扇出。错 token 404、未知 token 404、disabled 409。
 */

const rest = async (
  port: number,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
) => {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

describe('外部 webhook 扇入（/webhooks/extensions/<token>）', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let hooksDir: string;
  let bindings: ExtensionBindingRepository;
  let engine: ExtensionEngine;
  let webhookCalls: Array<{ url: string; body: unknown }> = [];

  beforeAll(async () => {
    db = openDatabase(':memory:');
    const projects = new ProjectRepository(db);
    projects.register({ path: 'D:/proj-wf', name: 'proj-wf', token: 't-wf', source: 'scan' });
    const hookEvents = new HookEventRepository(db);
    // 目标会话（claude 面：session 端点 prompt 通道判据）
    hookEvents.insert({ projectId: 1, source: 'claude', eventType: 'UserPromptSubmit', sessionId: 'sess-wf', payload: '{}' });
    new SessionRepository(db).touch('sess-wf', 1);

    hooksDir = mkdtempSync(path.join(tmpdir(), 'weave-wf-'));
    const deliverer = new MessageDeliverer({
      sessions: new SessionRepository(db),
      projects,
      hookEvents,
      bus: new HookEventBus(),
      hooksDir,
    });
    bindings = new ExtensionBindingRepository(db);
    engine = new ExtensionEngine({
      bindings,
      executions: {
        insert: (row) => {
          webhookExecutions.push(row);
          return 0;
        },
        query: () => ({ rows: [], nextBefore: null }),
        hasDelivered: () => false,
        prune: () => 0,
        listByBinding: () => [],
      } as never,
      deliverer,
      postJsonImpl: (async (url: string, _secret: unknown, body: unknown) => {
        webhookCalls.push({ url, body });
        return { ok: true, status: 'succeeded', output: '' };
      }) as never,
      labelOf: (id) => id.slice(0, 8),
    });

    const probe = netCreate();
    port = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => resolve((probe.address() as { port: number }).port));
    }).finally(() => new Promise<void>((resolve) => probe.close(() => resolve())));
    server = createWeaveServer({
      projects,
      port,
      hookSessions: new SessionRepository(db),
      hookEvents,
      messageDeliverer: deliverer,
      extensionBindings: bindings,
      extensionEngine: engine,
      extensionExecutions: undefined,
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

    // 端点三件套之一：生成 token（对齐编排 rotateNodeToken 语义）
    const binding = bindings.insert({
      name: 'fanin',
      projectId: 1,
      sessionId: null,
      point: 'idle',
      when: null,
      condition: null,
      summarize: null,
      endpoints: [{ kind: 'webhook', url: 'https://collector.example/hook' }],
      enabled: true,
    });
    bindingId = binding.id;
    webhookToken = bindings.rotateWebhookToken(binding.id)!;
    expect(webhookToken).toBeTruthy();
  });

  let bindingId = 0;
  let webhookToken = '';
  const webhookExecutions: Array<{ trigger: string; stage: string }> = [];

  afterAll(async () => {
    server.close();
    db.close();
    rmSync(hooksDir, { recursive: true, force: true });
  });

  it('token 即凭证：错 token 404；token 命中 202 + 引擎管线跑通', async () => {
    expect((await rest(port, 'POST', '/webhooks/extensions/not-a-token', { x: 1 })).status).toBe(404);
    const fired = await rest(port, 'POST', `/webhooks/extensions/${webhookToken}`, { hello: 'fanin' });
    expect(fired.status).toBe(202);
    expect(fired.body.bindingId).toBe(bindingId);
    // 引擎管线跑通（异步）：等一拍执行日志（trigger 记 external 之外的痕——此处
    // webhook 端点无闸拦截，delivered 落定）
    for (let i = 0; i < 40 && webhookExecutions.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(webhookExecutions.length).toBeGreaterThan(0);
    expect(webhookExecutions.some((e) => e.stage === 'delivered')).toBe(true);
    expect(webhookCalls).toHaveLength(1);
    // 端点载荷 = 引擎既有形状（binding/point/sessionId/upstream…，与 ingest 同构）
    expect(webhookCalls[0]!.url).toBe('https://collector.example/hook');
    expect((webhookCalls[0]!.body as { binding?: string; point?: string }).point).toBe('idle');
  });

  it('轮换后旧 token 失效（404）', async () => {
    const rotated = bindings.rotateWebhookToken(bindingId)!;
    expect((await rest(port, 'POST', `/webhooks/extensions/${webhookToken}`, {})).status).toBe(404);
    expect((await rest(port, 'POST', `/webhooks/extensions/${rotated}`, {})).status).toBe(202);
  });

  it('postJson 边界复用（白名单协议 + 5s 超时）：非 http(s) 拒', async () => {
    const bad = await postJson('ftp://x/y', undefined, {});
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/unsupported protocol/);
  });
});
