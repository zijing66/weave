import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../db/db.js';
import { NotifyChannelRepository } from '../../repositories/notify-channels.js';
import { handleNotifyChannelRoutes } from '../routes/notify-channels.js';
import type { WeaveServerDeps } from '../server.js';

/** 外发通道路由：CRUD + 按 kind 校验必填 + 测试发送走注入的发送器。 */

let db: ReturnType<typeof openDatabase>;
let repo: NotifyChannelRepository;
let send: ReturnType<typeof vi.fn>;
let deps: WeaveServerDeps;

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = new NotifyChannelRepository(db);
  send = vi.fn(async () => ({ ok: true, status: 'succeeded' }));
  deps = { projects: {} as never, port: 0, notifyChannels: repo, notifySend: send as never };
});

afterEach(() => db.close());

const call = async (
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
): Promise<{ handled: boolean; status: number; body: Record<string, unknown> }> => {
  const req = Readable.from([
    Buffer.from(body === undefined ? '' : JSON.stringify(body)),
  ]) as unknown as IncomingMessage;
  req.method = method;
  let out: unknown = null;
  const res = {
    statusCode: 0,
    setHeader: () => undefined,
    end: (chunk?: unknown) => {
      out = typeof chunk === 'string' ? JSON.parse(chunk) : chunk;
    },
  };
  const url = new URL(path, 'http://x');
  const handled = await handleNotifyChannelRoutes(
    req,
    res as unknown as ServerResponse,
    deps,
    url.pathname,
    url,
  );
  return { handled, status: res.statusCode, body: out as Record<string, unknown> };
};

describe('notify channel routes', () => {
  it('非本域路径不认领', async () => {
    expect((await call('/settings', 'GET')).handled).toBe(false);
  });

  it('创建 → 列表 → 删除', async () => {
    const created = await call('/notify/channels', 'POST', {
      kind: 'wecom',
      name: '群',
      config: { url: 'https://qy.example/hook?key=k' },
    });
    expect(created.status).toBe(201);
    const id = (created.body.channel as { id: string }).id;
    expect((await call('/notify/channels', 'GET')).body.channels).toHaveLength(1);
    expect((await call(`/notify/channels/${id}`, 'DELETE')).status).toBe(200);
    expect((await call('/notify/channels', 'GET')).body.channels).toHaveLength(0);
  });

  it('未知 kind / 缺必填 → 400', async () => {
    const bad = await call('/notify/channels', 'POST', { kind: 'sms', name: 'x', config: {} });
    expect(bad.status).toBe(400);
    const missing = await call('/notify/channels', 'POST', { kind: 'wecom', name: 'x', config: {} });
    expect(missing.status).toBe(400);
    const email = await call('/notify/channels', 'POST', {
      kind: 'email',
      name: 'x',
      config: { host: 'smtp.example' },
    });
    expect(email.status).toBe(400);
  });

  it('PUT 局部更新（只改 enabled）', async () => {
    const c = repo.create({ kind: 'feishu', name: 'a', config: { url: 'https://fs' } });
    const res = await call(`/notify/channels/${c.id}`, 'PUT', { enabled: false });
    expect(res.status).toBe(200);
    expect(repo.getById(c.id)!.enabled).toBe(false);
    expect(repo.getById(c.id)!.config.url).toBe('https://fs');
  });

  it('测试发送走注入发送器并回结果', async () => {
    const c = repo.create({ kind: 'wecom', name: 'a', config: { url: 'https://qy' } });
    const res = await call(`/notify/channels/${c.id}/test`, 'POST');
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    send.mockResolvedValueOnce({ ok: false, status: 'failed', error: 'boom' });
    expect((await call(`/notify/channels/${c.id}/test`, 'POST')).status).toBe(502);
  });

  it('不存在的 id → 404', async () => {
    expect((await call('/notify/channels/nope/test', 'POST')).status).toBe(404);
    expect((await call('/notify/channels/nope', 'DELETE')).status).toBe(404);
  });
});
