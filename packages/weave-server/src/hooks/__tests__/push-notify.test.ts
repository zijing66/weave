import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../db/db.js';
import { ProjectRepository } from '../../repositories/projects.js';
import { SessionRepository } from '../../repositories/sessions.js';
import { PushSubscriptionRepository } from '../../repositories/push-subscriptions.js';
import { HookEventBus } from '../bus.js';
import { PushNotifier, type PushPayload } from '../push-notify.js';
import type { PushSubscriptionRow } from '../../repositories/push-subscriptions.js';

/**
 * 提醒推送（第三条腿）：VAPID 密钥落盘复用、watch.fired 仅 dashboard 订阅
 * （watcher null）触发、payload 自包含（label + 触发短语 + 去重 tag）、
 * 推送服务回绝（404/410）清行自愈、其他错误保留订阅。
 */

let db: DatabaseSync;
let sessions: SessionRepository;
let subs: PushSubscriptionRepository;
let dir: string;
let projectId: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  projectId = new ProjectRepository(db).register({
    path: '/p',
    name: 'p',
    token: 't',
    source: 'init',
  }).id;
  sessions = new SessionRepository(db);
  subs = new PushSubscriptionRepository(db);
  dir = mkdtempSync(path.join(tmpdir(), 'weave-push-'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

type Send = NonNullable<ConstructorParameters<typeof PushNotifier>[0]['send']>;

const makeNotifier = (send?: Send) => {
  const bus = new HookEventBus();
  const notifier = new PushNotifier({
    subscriptions: subs,
    sessions,
    bus,
    keysPath: path.join(dir, 'push.json'),
    send,
  });
  return { bus, notifier, send };
};

const subRow = (endpoint = 'https://push.example/x'): PushSubscriptionRow => ({
  endpoint,
  p256dh: 'BPk',
  auth: 'AU',
  userAgent: 'test-agent',
  createdAt: new Date().toISOString(),
});

const fire = (bus: HookEventBus, watcherSessionId: string | null) => {
  bus.emit({
    kind: 'watch.fired',
    watchId: 1,
    targetSessionId: 'a',
    watcherSessionId,
    reason: 'idle',
    at: new Date().toISOString(),
  });
};

describe('VAPID 密钥', () => {
  it('缺失即生成并落盘（0600 语义由写入口径保证），二次构造复用同钥', () => {
    const first = new PushNotifier({
      subscriptions: subs,
      sessions,
      bus: new HookEventBus(),
      keysPath: path.join(dir, 'push.json'),
      send: async () => {},
    });
    const persisted = JSON.parse(readFileSync(path.join(dir, 'push.json'), 'utf8'));
    expect(persisted.publicKey).toBe(first.publicKey());

    const second = new PushNotifier({
      subscriptions: subs,
      sessions,
      bus: new HookEventBus(),
      keysPath: path.join(dir, 'push.json'),
      send: async () => {},
    });
    expect(second.publicKey()).toBe(first.publicKey());
  });

  it('坏文件视同缺失——重生成覆写', () => {
    writeFileSync(path.join(dir, 'push.json'), 'not json', 'utf8');
    const notifier = new PushNotifier({
      subscriptions: subs,
      sessions,
      bus: new HookEventBus(),
      keysPath: path.join(dir, 'push.json'),
      send: async () => {},
    });
    expect(notifier.publicKey()).toMatch(/^[\w-]{20,}$/);
    expect(() => JSON.parse(readFileSync(path.join(dir, 'push.json'), 'utf8'))).not.toThrow();
  });
});

describe('watch.fired 分流', () => {
  it('dashboard 订阅（watcher null）→ 组载荷群发全部订阅', async () => {
    sessions.touch('a', projectId);
    sessions.setPendingTitle('a', 'adapter 工作');
    subs.upsert({ endpoint: 'https://push/1', p256dh: 'k1', auth: 'a1' });
    subs.upsert({ endpoint: 'https://push/2', p256dh: 'k2', auth: 'a2' });
    const send = vi.fn(async (_sub: PushSubscriptionRow, _payload: string) => {});
    const { bus } = makeNotifier(send);

    fire(bus, null);

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    const payload = JSON.parse(send.mock.calls[0][1]) as PushPayload;
    expect(payload).toEqual({
      title: 'weave',
      body: 'Session adapter 工作 is now idle',
      tag: 'weave-watch-a',
      url: '/',
    });
    expect(send.mock.calls[0][0].endpoint).toMatch(/^https:\/\/push\//);
  });

  it('会话订阅（watcher 非空）→ 不推（通知已走消息域注入）', async () => {
    subs.upsert({ endpoint: 'https://push/1', p256dh: 'k', auth: 'a' });
    const send = vi.fn(async () => {});
    const { bus } = makeNotifier(send);

    fire(bus, 'w');

    await new Promise((r) => setTimeout(r, 20));
    expect(send).not.toHaveBeenCalled();
  });

  it('零订阅 → 不调 send', async () => {
    const send = vi.fn(async () => {});
    const { bus } = makeNotifier(send);

    fire(bus, null);

    await new Promise((r) => setTimeout(r, 20));
    expect(send).not.toHaveBeenCalled();
  });

  it('目标会话无标题 → label 退化为 sessionId 前 8 位', async () => {
    sessions.touch('a', projectId);
    subs.upsert({ endpoint: 'https://push/1', p256dh: 'k', auth: 'a' });
    const send = vi.fn(async (_sub: PushSubscriptionRow, _payload: string) => {});
    const { bus } = makeNotifier(send);

    bus.emit({
      kind: 'watch.fired',
      watchId: 1,
      targetSessionId: 'a',
      watcherSessionId: null,
      reason: 'turnEnd',
      at: new Date().toISOString(),
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    const payload = JSON.parse(send.mock.calls[0][1]) as PushPayload;
    expect(payload.body).toBe('Session a finished its turn');
  });
});

describe('发送失败自愈', () => {
  it('404/410 = 订阅已撤销 → 删行，其余订阅照发', async () => {
    subs.upsert({ endpoint: 'https://push/dead', p256dh: 'k', auth: 'a' });
    subs.upsert({ endpoint: 'https://push/live', p256dh: 'k', auth: 'a' });
    const send = vi.fn(async (sub: PushSubscriptionRow) => {
      if (sub.endpoint === 'https://push/dead') {
        throw Object.assign(new Error('gone'), { statusCode: 410 });
      }
    });
    const { bus } = makeNotifier(send);

    fire(bus, null);

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(subs.list().map((s) => s.endpoint)).toEqual(['https://push/live']),
    );
  });

  it('非回绝错误（网络瞬断）→ 保留订阅下轮再试', async () => {
    subs.upsert({ endpoint: 'https://push/flaky', p256dh: 'k', auth: 'a' });
    const send = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const { bus } = makeNotifier(send);

    fire(bus, null);

    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(subs.list()).toHaveLength(1);
  });
});
