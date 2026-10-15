/**
 * 浏览器通知（Web Notifications API）：标签页切走/最小化时唯一看得见的提醒。
 * 页面内的 toast 保留——两者互不替代（toast 只在看得见页面时有用）。
 * 该 API 仅安全上下文（HTTPS/localhost）可用：手机经局域网 HTTP 访问时整体被
 * 浏览器禁用，见 ensureNotifyPermission 的 insecure 态。
 * Android Chromium 禁用 new Notification() 构造器——SW 的 showNotification
 * 优先（见 public/sw.js），构造器只作 SW 缺位时的兜底。
 */

/**
 * 发一条系统通知；未授权/不支持时静默跳过（调用方仍有 toast 兜底）。
 * tag：同 tag 的通知互相替换——Web Push 通道（页面关着）与本条（页面开着）
 * 先后到达时只显示一条，不双弹。
 */
export async function notifyBrowser(title: string, body?: string, tag?: string): Promise<void> {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const options = { ...(body ? { body } : {}), ...(tag ? { tag } : {}) };
    const reg =
      'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (reg) {
      await reg.showNotification(title, Object.keys(options).length ? options : undefined);
      return;
    }
    new Notification(title, Object.keys(options).length ? options : undefined);
  } catch {
    // 通知构造失败不影响页面其余反馈
  }
}

/** ensureNotifyPermission 的四态结局：三种失败成因不同，文案别一律说「未授权」。 */
export type NotifyPermission = 'granted' | 'denied' | 'unsupported' | 'insecure';

/**
 * 申请通知权限——**必须在用户手势里调**（订阅空闲提醒那一刻）。已拒绝不重复
 * 弹窗（浏览器也不会再弹）。
 *   insecure   非安全上下文（手机经局域网 HTTP 访问的常态）——浏览器把通知整体
 *              关死、permission 恒报 denied，须先查它再查 permission（顺序不能反）
 *   unsupported 无 Notification API（如 iOS 普通标签页——仅加主屏的 PWA 才有）
 */
export async function ensureNotifyPermission(): Promise<NotifyPermission> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if ((globalThis as { isSecureContext?: boolean }).isSecureContext === false) return 'insecure';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    return (await Notification.requestPermission()) === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}
