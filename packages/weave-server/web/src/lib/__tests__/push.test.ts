import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api', () => ({
  api: {
    pushPublicKey: vi.fn(),
    pushSubscribe: vi.fn(),
    pushUnsubscribe: vi.fn(),
  },
}));

import { api } from '../api';
import { ensurePushSubscribed, unsubscribePush, pushChannelState } from '../push';

/**
 * 推送订阅浏览器侧三分态（node 环境无 SW/PushManager → stub 全局）：
 * unavailable = 该环境合法走不到推送（无 SW / HTTP / 未授权，订阅手势静默），
 * failed = 真失败（设置页可见告知），ok = 浏览器订阅 + 服务端落库双就绪。
 * VAPID 密钥轮换（服务端重生成）→ 旧订阅退订重订。
 */

const ab = (s: string): ArrayBuffer => {
  const bytes = new Uint8Array([...s].map((c) => c.charCodeAt(0)));
  return bytes.buffer;
};
/** btoa('PUBLICKEY')——与 mock 的服务端公钥对齐（bufferToB64 口径）。 */
const PUB = btoa('PUBLICKEY');

const sub = (endpoint: string, keyAb: ArrayBuffer | null): PushSubscription =>
  ({
    endpoint,
    options: { applicationServerKey: keyAb },
    toJSON: () => ({ endpoint, keys: { p256dh: 'B', auth: 'A' } }),
    unsubscribe: vi.fn(async () => {}),
  }) as unknown as PushSubscription;

const stubSw = (opts: { existing?: PushSubscription | null; subscribe?: PushSubscription }) => {
  const registration = {
    pushManager: {
      getSubscription: vi.fn(async () => opts.existing ?? null),
      subscribe: vi.fn(async () => opts.subscribe ?? sub('https://push/new', ab('NEWKEY'))),
    },
  };
  vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.resolve(registration) } });
  return registration;
};

const grantNotification = () =>
  vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission: 'granted' }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.pushPublicKey).mockResolvedValue({ publicKey: PUB });
  vi.mocked(api.pushSubscribe).mockResolvedValue({ ok: true });
  vi.mocked(api.pushUnsubscribe).mockResolvedValue({ ok: true });
});

afterEach(() => vi.unstubAllGlobals());

describe('环境门控', () => {
  it('无 serviceWorker（node/iOS 普通标签页）→ unavailable / unsupported', async () => {
    grantNotification();
    await expect(ensurePushSubscribed()).resolves.toBe('unavailable');
    await expect(pushChannelState()).resolves.toBe('unsupported');
  });

  it('非安全上下文（手机 HTTP 访问）→ insecure', async () => {
    vi.stubGlobal('isSecureContext', false);
    await expect(pushChannelState()).resolves.toBe('insecure');
  });

  it('通知权限未授予 → unavailable（订阅面与权限同一手势）', async () => {
    stubSw({});
    vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission: 'default' }));
    await expect(ensurePushSubscribed()).resolves.toBe('unavailable');
  });
});

describe('ensurePushSubscribed', () => {
  it('无既有订阅 → subscribe（带 applicationServerKey）+ 服务端落库 → ok', async () => {
    grantNotification();
    const reg = stubSw({});

    await expect(ensurePushSubscribed()).resolves.toBe('ok');
    expect(reg.pushManager.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true, applicationServerKey: expect.any(Uint8Array) }),
    );
    expect(api.pushSubscribe).toHaveBeenCalledWith({
      endpoint: 'https://push/new',
      keys: { p256dh: 'B', auth: 'A' },
    });
  });

  it('既有订阅钥匹配 → 不重订，仅重落库（幂等 upsert）→ ok', async () => {
    grantNotification();
    const reg = stubSw({ existing: sub('https://push/old', ab('PUBLICKEY')) });

    await expect(ensurePushSubscribed()).resolves.toBe('ok');
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled();
    expect(api.pushSubscribe).toHaveBeenCalledWith({
      endpoint: 'https://push/old',
      keys: { p256dh: 'B', auth: 'A' },
    });
  });

  it('服务端钥轮换 → 旧订阅退订重订', async () => {
    grantNotification();
    const old = sub('https://push/old', ab('ROTATED-AWAY'));
    const reg = stubSw({ existing: old });

    await expect(ensurePushSubscribed()).resolves.toBe('ok');
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(reg.pushManager.subscribe).toHaveBeenCalled();
    expect(api.pushSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'https://push/new' }),
    );
  });

  it('订阅对象缺加密密钥 → failed', async () => {
    grantNotification();
    stubSw({
      subscribe: {
        endpoint: 'https://push/bad',
        options: {},
        toJSON: () => ({ endpoint: 'https://push/bad' }),
        unsubscribe: vi.fn(async () => {}),
      } as unknown as PushSubscription,
    });

    await expect(ensurePushSubscribed()).resolves.toBe('failed');
    expect(api.pushSubscribe).not.toHaveBeenCalled();
  });
});

describe('pushChannelState / unsubscribePush', () => {
  it('已订阅 → on；未订阅 → off', async () => {
    stubSw({ existing: sub('https://push/old', ab('PUBLICKEY')) });
    await expect(pushChannelState()).resolves.toBe('on');

    stubSw({});
    await expect(pushChannelState()).resolves.toBe('off');
  });

  it('退订 = 服务端删行 + 浏览器 unsubscribe', async () => {
    const old = sub('https://push/old', ab('PUBLICKEY'));
    stubSw({ existing: old });

    await unsubscribePush();
    expect(api.pushUnsubscribe).toHaveBeenCalledWith('https://push/old');
    expect(old.unsubscribe).toHaveBeenCalled();
  });
});
