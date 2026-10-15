/**
 * Web Push 订阅（提醒通道第三条腿的浏览器侧）：dashboard 页面关掉后本地通知
 * 路径全死，只有厂商推送服务能唤起 SW 的 push 事件。订阅动作挂在订阅提醒的
 * 用户手势里（与权限申请同一手势），失败一律静默降级到「页面开着才提醒」
 * 的现状——HTTP 访问（非安全上下文）、iOS 普通标签页（无 SW）等环境完全
 * 合法地走不到这条路。
 */
import { api } from './api';

/** base64url（VAPID 公钥原样）→ pushManager.subscribe 要的 Uint8Array。 */
function b64ToUint8Array(b64: string): Uint8Array {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function bufferToB64(buf: ArrayBuffer | null | undefined): string | null {
  if (buf == null) return null;
  const bytes = new Uint8Array(buf);
  let raw = '';
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw);
}

async function registrationWithPush(): Promise<PushRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  if ((globalThis as { isSecureContext?: boolean }).isSecureContext === false) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager ? reg : null;
  } catch {
    return null;
  }
}

type PushRegistration = ServiceWorkerRegistration & { pushManager: PushManager };

/** ensurePushSubscribed 的三种结局：ok = 服务端已有本浏览器的订阅记录。 */
export type PushSubscribeResult = 'ok' | 'unavailable' | 'failed';

/**
 * 确保「本浏览器已订阅推送且服务端有记录」。VAPID 密钥轮换过（服务端
 * push.json 重生成）则旧订阅重新换——推送服务按密钥验签，旧订阅配新钥
 * 恒 403。unavailable = 该环境走不到推送（HTTP / 无 SW / 未授权，合法静默）；
 * failed = 真订阅失败（设置页开关要可见地告知，订阅手势继续静默）。
 */
export async function ensurePushSubscribed(): Promise<PushSubscribeResult> {
  try {
    const reg = await registrationWithPush();
    if (!reg || typeof Notification === 'undefined' || Notification.permission !== 'granted') {
      return 'unavailable';
    }
    const { publicKey } = await api.pushPublicKey();
    const existing = await reg.pushManager.getSubscription();
    let sub: PushSubscription | null = existing;
    if (existing && bufferToB64(existing.options.applicationServerKey) !== publicKey) {
      // 旧钥订阅：推送服务会拒新钥签名——退订重订
      await existing.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64ToUint8Array(publicKey),
    });
    const json = sub.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return 'failed';
    await api.pushSubscribe({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    });
    return 'ok';
  } catch {
    return 'failed';
  }
}

/** 取消本浏览器的推送订阅（设置页开关关向）：浏览器退订 + 服务端删行。 */
export async function unsubscribePush(): Promise<void> {
  try {
    const reg = await registrationWithPush();
    if (!reg) return;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await api.pushUnsubscribe(sub.endpoint);
    await sub.unsubscribe();
  } catch {
    // 关不掉就算了（下次 fire 服务端发送失败自会清行）
  }
}

export type PushChannelState = 'unsupported' | 'insecure' | 'off' | 'on';

/** 设置页展示态：本浏览器推送通道可用且已订阅 = on。 */
export async function pushChannelState(): Promise<PushChannelState> {
  if ((globalThis as { isSecureContext?: boolean }).isSecureContext === false) return 'insecure';
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return 'unsupported';
  try {
    const reg = await registrationWithPush();
    if (!reg) return 'unsupported';
    return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
  } catch {
    return 'unsupported';
  }
}
