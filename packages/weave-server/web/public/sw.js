/* weave dashboard Service Worker。
 *
 * 三件职责：①承载 Android Chromium 的系统通知（该平台禁用 new Notification()
 * 构造器，只能经 registration.showNotification()）；②Web Push——页面关掉后厂商
 * 推送服务仍能唤起本 worker 的 push 事件（提醒通道的第三条腿）；③预载壳——把
 * 构建产物与 app shell 收进 Cache，再开页面时启动页直接从本机盘出、不等网络。
 *
 * 缓存只认**构建产物**（/assets/ 下 vite 内容哈希、/fonts/、logo），dev 路径下
 * 一条都不命中，故本地开发不必为它让路。HTML 走「网络优先 + 1.8s 超时回落」，
 * 装包/升级后不会卡在旧壳上。旧产物**不清**：升级瞬间还开着的页面可能懒加载
 * 老 hash 的分块，清掉就成了 404；靠 `SHELL` 改名整档淘汰。
 */

const SHELL = 'weave-shell-v1';
/** 只从本地盘直出、永不回源的路径：内容哈希 → 同 URL 同内容。 */
const IMMUTABLE = (path) =>
  path.startsWith('/assets/') || path.startsWith('/fonts/') || path.endsWith('weave-logo.svg');
/** 网络优先的兜底窗口：daemon 冷启动/挂住时，超过这个时长就先给缓存壳。 */
const SHELL_TIMEOUT_MS = 1800;

/** 首装的预铺：字体与 favicon 体积小、且 index.html 已经 preload，顺手垫上。
 *  `/` 单独处理——离线时它就是那屏启动页，但它可能 302 到登录页，不能进 addAll。 */
const PRECACHE = [
  '/fonts/WeaveNerdMono-Regular.woff?v=2',
  '/fonts/WeaveNerdMono-Bold.woff?v=2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      await Promise.allSettled(PRECACHE.map((url) => cache.add(url)));
      // 装的时候就把壳铺好：第二次打开即便断网也有启动页可看。
      const html = await fetchShell();
      if (html) await cache.put('/', shellResponse(html));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

/* ---- 预载壳 ---- */

/** 只读构建产物形态的 HTML：dev（vite）注入 /@vite/client，且产物引用在 /assets/。 */
function isBuiltShell(html) {
  return html.includes('/assets/') && !html.includes('/@vite/client');
}

function shellResponse(html) {
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

async function fetchShell() {
  try {
    const res = await fetch('/', { cache: 'no-cache' });
    if (!res.ok) return null;
    const html = await res.text();
    return isBuiltShell(html) ? html : null;
  } catch {
    return null;
  }
}

/** 网络优先、超时回落缓存；拿到新壳就替换掉 `/` 那条（产物条目照旧留着）。 */
async function navigateWithShell(request) {
  const cache = await caches.open(SHELL);
  try {
    const res = await withTimeout(fetch(request), SHELL_TIMEOUT_MS);
    if (res.ok && res.type === 'basic') {
      const html = await res.clone().text();
      if (isBuiltShell(html)) {
        const prev = await cache.match('/');
        if (!prev || (await prev.text()) !== html) await cache.put('/', shellResponse(html));
      }
    }
    return res;
  } catch (err) {
    const hit = await cache.match('/');
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && res.type === 'basic') await cache.put(request, res.clone());
  return res;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('shell-timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(navigateWithShell(request));
    return;
  }
  if (IMMUTABLE(url.pathname)) event.respondWith(cacheFirst(request));
});

/* ---- 通知 ---- */

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
