/* weave dashboard 最小 Service Worker。
 *
 * 唯一职责：承载 Android Chromium 的系统通知（该平台禁用 new Notification()
 * 构造器，只能经 registration.showNotification()）。刻意**不注册 fetch
 * handler**——不拦截任何请求，页面资源永远走网络，无缓存陈旧风险。
 */

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if ('focus' in w) return w.focus();
      }
      return self.clients.openWindow('/');
    }),
  );
});
