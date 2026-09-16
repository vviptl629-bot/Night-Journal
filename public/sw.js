/* 晚记 Night Journal — Service Worker
 *
 * 策略总览：
 *   - 应用外壳（图标/manifest）安装时预缓存
 *   - 页面导航：network-first，离线时回退到缓存的 index.html
 *   - 静态资源（/assets/*、图片、字体）：stale-while-revalidate
 *   - /api/*：完全不缓存，永远走网络
 *
 * 注意：任何 /api/ 请求都不进缓存 —— 日记是私人数据，
 * 读到陈旧响应比读到错误响应更糟。
 */

const VERSION = 'v1';
const CACHE = `night-journal-${VERSION}`;

// 只预缓存体积小的外壳资源。
// icon0.svg 有 1.4MB，不放进预缓存，留给运行时按需缓存。
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon1.png',
  '/apple-icon.png',
  '/web-app-manifest-192x192.png',
  '/web-app-manifest-512x512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // 单个资源失败不应让整个安装失败
      await Promise.all(
        APP_SHELL.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => {})
        )
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith('/assets/') ||
    /\.(?:js|css|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|otf)$/i.test(url.pathname)
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // 只接管同源 GET
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 后端接口永不缓存
  if (url.pathname.startsWith('/api/')) return;

  // 页面导航：网络优先，离线回退到应用外壳
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(CACHE);
          cache.put('/index.html', response.clone());
          return response;
        } catch {
          const cache = await caches.open(CACHE);
          const cached =
            (await cache.match('/index.html')) || (await cache.match('/'));
          if (cached) return cached;
          return new Response('离线中，且没有可用的缓存页面。', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }
      })()
    );
    return;
  }

  if (!isStaticAsset(url)) return;

  // 静态资源：先给缓存（快），后台同时更新
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);

      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => null);

      if (cached) return cached;

      const fresh = await network;
      if (fresh) return fresh;

      return new Response('', { status: 504, statusText: 'Gateway Timeout' });
    })()
  );
});
