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
 * unavailable = 该环境合法走不到推送（无 SW / HTTP / 未授权 / 推送服务黑洞
 * 且在超时记忆期内，订阅手势静默），failed = 真失败（设置页可见告知），
 * ok = 浏览器订阅 + 服务端落库双就绪。推送服务连接可能被网络黑洞（国内
 * Chrome 的 FCM）——所有对推送服务的 await 必须限时，订阅手势不能陪葬。
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

const stubSw = (opts: {
  existing?: PushSubscription | null;
  subscribe?: PushSubscription;
  /** origin 上还没有 SW 注册（main.tsx 启动注册失败被吞掉的局面）。 */
  missing?: boolean;
  /** subscribe 永不 settle（推送服务连接被黑洞）。 */
  hangSubscribe?: boolean;
} = {}) => {
  const registration = {
    pushManager: {
      getSubscription: vi.fn(async () => opts.existing ?? null),
      subscribe: opts.hangSubscribe
        ? vi.fn(() => new Promise<PushSubscription>(() => {}))
        : vi.fn(async () => opts.subscribe ?? sub('https://push/new', ab('NEWKEY'))),
    },
  };
  const register = vi.fn(async () => registration);
  vi.stubGlobal('navigator', {
    serviceWorker: {
      getRegistration: vi.fn(async () => (opts.missing ? undefined : registration)),
      register,
    },
  });
  return { registration, register };
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
    stubSw();
    vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission: 'default' }));
    await expect(ensurePushSubscribed()).resolves.toBe('unavailable');
  });
});

describe('ensurePushSubscribed', () => {
  it('无既有订阅 → subscribe（带 applicationServerKey）+ 服务端落库 → ok', async () => {
    grantNotification();
    const { registration } = stubSw();

    await expect(ensurePushSubscribed()).resolves.toBe('ok');
    expect(registration.pushManager.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        userVisibleOnly: true,
        applicationServerKey: expect.any(Uint8Array),
      }),
    );
    expect(api.pushSubscribe).toHaveBeenCalledWith({
      endpoint: 'https://push/new',
      keys: { p256dh: 'B', auth: 'A' },
    });
  });

  it('origin 上无注册 → 就地补注册 /sw.js（不用会永挂的 ready）', async () => {
    grantNotification();
    const { register } = stubSw({ missing: true });

    await expect(ensurePushSubscribed()).resolves.toBe('ok');
    expect(register).toHaveBeenCalledWith('/sw.js');
    expect(api.pushSubscribe).toHaveBeenCalled();
  });

  it('既有订阅钥匹配 → 不重订，仅重落库（幂等 upsert）→ ok', async () => {
    grantNotification();
    const { registration } = stubSw({ existing: sub('https://push/old', ab('PUBLICKEY')) });

    await expect(ensurePushSubscribed()).resolves.toBe('ok');
    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(api.pushSubscribe).toHaveBeenCalledWith({
      endpoint: 'https://push/old',
      keys: { p256dh: 'B', auth: 'A' },
    });
  });

  it('服务端钥轮换 → 旧订阅退订重订', async () => {
    grantNotification();
    const old = sub('https://push/old', ab('ROTATED-AWAY'));
    const { registration } = stubSw({ existing: old });

    await expect(ensurePushSubscribed()).resolves.toBe('ok');
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(registration.pushManager.subscribe).toHaveBeenCalled();
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

  it('推送服务黑洞 → 限时放弃 unavailable；记忆期内即时降级，force 显式重试', async () => {
    grantNotification();
    // fake 时钟拨回过去：超时记忆的落点也停在 2020，用例结束后回到真实时间
    // 即自然过期，不污染后续用例。
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
    const { registration } = stubSw({ hangSubscribe: true });

    const first = ensurePushSubscribed();
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(first).resolves.toBe('unavailable');

    // 记忆期内：不再碰推送服务，即时降级
    await expect(ensurePushSubscribed()).resolves.toBe('unavailable');
    expect(registration.pushManager.subscribe).toHaveBeenCalledTimes(1);

    // force（设置页开关的显式重试）绕过记忆再试——仍黑洞仍放弃
    const third = ensurePushSubscribed({ force: true });
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(third).resolves.toBe('unavailable');
    expect(registration.pushManager.subscribe).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});

describe('pushChannelState / unsubscribePush', () => {
  it('已订阅 → on；未订阅 → off', async () => {
    stubSw({ existing: sub('https://push/old', ab('PUBLICKEY')) });
    await expect(pushChannelState()).resolves.toBe('on');

    stubSw();
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
