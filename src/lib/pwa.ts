/**
 * Service Worker 注册。
 *
 * 只在生产构建中启用：开发模式下 SW 会把旧资源缓存住，
 * 让热更新看起来"没生效"，排查起来很浪费时间。
 */
export function registerServiceWorker() {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // PWA 能力是增强项，注册失败不应影响应用本体
    });
  });
}
