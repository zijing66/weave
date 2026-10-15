/* weave dashboard 最小 Service Worker。
 *
 * 职责两件：①承载 Android Chromium 的系统通知（该平台禁用 new Notification()
 * 构造器，只能经 registration.showNotification()）；②Web Push——页面关掉后
 * 厂商推送服务仍能唤起本 worker 的 push 事件（提醒通道的第三条腿）。刻意
 * **不注册 fetch handler**——不拦截任何请求，页面资源永远走网络，无缓存
 * 陈旧风险。
 */

/* 推送载荷 { title, body, tag, url }：tag 与页面开着的本地通知同值——
 * 双通道先后到达时同 tag 替换，不会弹两条。 */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // 非 JSON 载荷（异端发来）：仍出一条占位通知——userVisibleOnly 契约
    // 要求收到 push 必须展示，静默吞掉会被浏览器记违规。
    data = {};
  }
  const { title = 'weave', body = '', tag = 'weave', url = '/' } = data;
  event.waitUntil(
    self.registration.showNotification(title, { body, tag, data: { url } }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if ('focus' in w) return w.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
