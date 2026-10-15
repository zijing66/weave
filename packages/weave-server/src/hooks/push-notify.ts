import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import type { SessionRepository } from '../repositories/sessions.js';
import type {
  PushSubscriptionRepository,
  PushSubscriptionRow,
} from '../repositories/push-subscriptions.js';
import { getPushKeysPath } from '../db/paths.js';
import type { HookEventBus } from './bus.js';
import { watchReasonPhrase } from './watch-engine.js';

/** 推送载荷：SW 端按 title/body/tag/showNotification，url 供点击打开。 */
export interface PushPayload {
  title: string;
  body: string;
  /** 同 tag 的通知互相替换（与页面开着的本地通知去重）。 */
  tag: string;
  url: string;
}

/**
 * Web Push 发送器（提醒通道的第三条腿）：浏览器把 dashboard 关掉后，本地
 * 通知路径全死——只有厂商推送服务能唤起 SW 的 push 事件。订阅 hookBus 的
 * `watch.fired`（watcher null = dashboard 订阅，与 web toast 同口径；会话
 * 订阅的通知已走消息域注入，不推）。发送失败永不影响采集（hooks 非阻塞
 * 不变式）：404/410 = 浏览器端已撤销 → 删行自愈；网络错误保留订阅下轮再试。
 */
export class PushNotifier {
  private readonly vapid: { publicKey: string; privateKey: string };

  constructor(
    private readonly deps: {
      subscriptions: Pick<PushSubscriptionRepository, 'list' | 'deleteByEndpoint'>;
      sessions: Pick<SessionRepository, 'getBySessionId'>;
      bus: HookEventBus;
      /** VAPID 密钥文件（测试注入）；缺省 `<dataDir>/push.json`。 */
      keysPath?: string;
      /** 发送函数（测试注入）；缺省 web-push。 */
      send?: (
        subscription: PushSubscriptionRow,
        payload: string,
        vapid: { publicKey: string; privateKey: string },
      ) => Promise<void>;
    },
  ) {
    this.vapid = loadOrGenerateVapidKeys(deps.keysPath ?? getPushKeysPath());
    deps.bus.subscribe((message) => this.onBus(message));
  }

  /** 订阅面要的 applicationServerKey（base64url 原样）。 */
  publicKey(): string {
    return this.vapid.publicKey;
  }

  private onBus(message: Parameters<HookEventBus['emit']>[0]): void {
    if (message.kind !== 'watch.fired' || message.watcherSessionId !== null) return;
    const target = this.deps.sessions.getBySessionId(message.targetSessionId);
    const label = target?.title ?? message.targetSessionId.slice(0, 8);
    const payload: PushPayload = {
      title: 'weave',
      body: `Session ${label} ${watchReasonPhrase(message.reason)}`,
      tag: `weave-watch-${message.targetSessionId}`,
      url: '/',
    };
    const subs = this.deps.subscriptions.list();
    if (subs.length === 0) return;
    void this.pushAll(subs, JSON.stringify(payload));
  }

  private async pushAll(subs: PushSubscriptionRow[], payload: string): Promise<void> {
    for (const sub of subs) {
      try {
        await (this.deps.send ?? webPushSend)(sub, payload, this.vapid);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        // 推送服务的明确回绝 = 订阅已死（浏览器清了站点数据/卸载）；其他错误
        // （网络不可达等）保留订阅——下一轮 fire 自然重试。
        if (status === 404 || status === 410) this.deps.subscriptions.deleteByEndpoint(sub.endpoint);
      }
    }
  }
}

async function webPushSend(
  subscription: PushSubscriptionRow,
  payload: string,
  vapid: { publicKey: string; privateKey: string },
): Promise<void> {
  webpush.setVapidDetails('mailto:weave@localhost', vapid.publicKey, vapid.privateKey);
  await webpush.sendNotification(
    { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
    payload,
    { TTL: 3600 },
  );
}

/** 读 VAPID 密钥；缺失即生成并落盘（0600，与 ai.json/auth.json 同口径——非 UI 可读面）。 */
function loadOrGenerateVapidKeys(file: string): { publicKey: string; privateKey: string } {
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        publicKey?: unknown;
        privateKey?: unknown;
      };
      if (
        typeof parsed.publicKey === 'string' &&
        parsed.publicKey &&
        typeof parsed.privateKey === 'string' &&
        parsed.privateKey
      ) {
        return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
      }
    } catch {
      // 坏文件视同缺失——重新生成并覆写
    }
  }
  const generated = webpush.generateVAPIDKeys();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(generated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // 平台不支持时忽略（Windows）
  }
  return generated;
}
