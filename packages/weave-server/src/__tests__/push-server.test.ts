import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { PushSubscriptionRepository } from '../repositories/push-subscriptions.js';
import { HookEventBus } from '../hooks/bus.js';
import { SessionRepository } from '../repositories/sessions.js';
import { PushNotifier } from '../hooks/push-notify.js';
import { createWeaveServer } from '../daemon/server.js';

/**
 * Web Push 路由 HTTP 契约（提醒第三条腿）：公钥分发（订阅面的
 * applicationServerKey）、订阅注册 upsert（同 endpoint 覆写密钥）、撤销。
 * 推送触发链见 push-notify.test.ts。
 */
describe('daemon server push endpoints（GET /messaging/push/key, POST subscribe/unsubscribe）', () => {
  let db: DatabaseSync;
  let server: Server;
  let port: number;
  let subs: PushSubscriptionRepository;
  let dir: string;
  let publicKey: string;

  beforeAll(async () => {
    db = openDatabase(':memory:');
    dir = mkdtempSync(path.join(tmpdir(), 'weave-push-srv-'));
    subs = new PushSubscriptionRepository(db);
    const notifier = new PushNotifier({
      subscriptions: subs,
      sessions: new SessionRepository(db),
      bus: new HookEventBus(),
      keysPath: path.join(dir, 'push.json'),
      send: async () => {},
    });
    publicKey = notifier.publicKey();

    server = createWeaveServer({
      projects: new ProjectRepository(db),
      port: 0,
      pushSubscriptions: subs,
      pushNotifier: notifier,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (pathname: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('GET /messaging/push/key → base64url 公钥（订阅面直用）', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/messaging/push/key`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { publicKey: string };
    expect(data.publicKey).toBe(publicKey);
    expect(data.publicKey).toMatch(/^[\w-]+$/);
  });

  it('POST subscribe → 201 落库；同 endpoint 重复订阅覆写密钥不增行', async () => {
    const first = await post('/messaging/push/subscribe', {
      endpoint: 'https://push.example/sub/1',
      keys: { p256dh: 'BOLD', auth: 'AOLD' },
    });
    expect(first.status).toBe(201);

    const second = await post('/messaging/push/subscribe', {
      endpoint: 'https://push.example/sub/1',
      keys: { p256dh: 'BNEW', auth: 'ANEW' },
    });
    expect(second.status).toBe(201);

    const rows = subs.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      endpoint: 'https://push.example/sub/1',
      p256dh: 'BNEW',
      auth: 'ANEW',
    });
  });

  it('POST subscribe 缺字段 → 400', async () => {
    const res = await post('/messaging/push/subscribe', { endpoint: 'https://push.example/x' });
    expect(res.status).toBe(400);
  });

  it('POST unsubscribe → 200 删行（未知 endpoint 幂等成功）', async () => {
    subs.upsert({ endpoint: 'https://push.example/sub/2', p256dh: 'B', auth: 'A' });
    const gone = await post('/messaging/push/unsubscribe', { endpoint: 'https://push.example/sub/2' });
    expect(gone.status).toBe(200);
    expect(subs.list().map((s) => s.endpoint)).toEqual(['https://push.example/sub/1']);

    const unknown = await post('/messaging/push/unsubscribe', {
      endpoint: 'https://push.example/never',
    });
    expect(unknown.status).toBe(200);
  });

  it('未装推送子系统 → 503', async () => {
    const bare = createWeaveServer({ projects: new ProjectRepository(db), port: 0 });
    await new Promise<void>((resolve) => bare.listen(0, '127.0.0.1', resolve));
    const barePort = (bare.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${barePort}/messaging/push/key`);
      expect(res.status).toBe(503);
    } finally {
      bare.close();
    }
  });
});
