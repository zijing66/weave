/**
 * 浏览器通知（Web Notifications API）：标签页切走/最小化时唯一看得见的提醒。
 * 页面内的 toast 保留——两者互不替代（toast 只在看得见页面时有用）。
 */

/** 发一条系统通知；未授权/不支持时静默跳过（调用方仍有 toast 兜底）。 */
export function notifyBrowser(title: string, body?: string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    new Notification(title, body ? { body } : undefined);
  } catch {
    // 通知构造失败不影响页面其余反馈
  }
}

/**
 * 申请通知权限——**必须在用户手势里调**（订阅空闲提醒那一刻）。已授权 = true；
 * 已拒绝不重复弹窗（浏览器也不会再弹）。
 */
export async function ensureNotifyPermission(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}
