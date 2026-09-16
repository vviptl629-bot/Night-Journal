/**
 * Service Worker 注册与自动更新。
 *
 * 只在生产构建中启用：开发模式下 SW 会把旧资源缓存住，
 * 让热更新看起来"没生效"，排查起来很浪费时间。
 *
 * 这里的重点是**自动更新**：手机上装成 PWA 之后，页面经常是从后台恢复而不是
 * 重新加载，旧 Service Worker 会一直留着，表现就是手机端和电脑端界面不一致。
 * 所以除了注册，还要主动做三件事：
 *   1. 注册时不使用 HTTP 缓存去取 sw.js（updateViaCache: "none"）
 *   2. 每次页面回到前台 / 每 30 分钟，主动检查一次是否有新版本
 *   3. 发现新版本就让它立刻接管，并自动刷新页面一次，让页面代码与 SW 对齐
 */

const RELOAD_FLAG = "nj-sw-reloaded";

export function registerServiceWorker() {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    void initServiceWorker();
  });
}

async function initServiceWorker() {
  try {
    // 首次安装时页面本来就是最新的，不必刷新（避免白闪一次）；
    // 只有"之前已经被旧的 SW 接管"才需要靠刷新换掉旧页面代码。
    const hadController = !!navigator.serviceWorker.controller;

    // 页面已经由 SW 接管，说明上一次"自动刷新"已经完成，清掉标记，
    // 为下一次版本更新留出刷新的机会（同时避免无限刷新）。
    if (navigator.serviceWorker.controller) {
      try {
        sessionStorage.removeItem(RELOAD_FLAG);
      } catch {
        /* 隐私模式下 sessionStorage 可能不可用 */
      }
    }

    const registration = await navigator.serviceWorker.register("/sw.js", {
      // 不要用 HTTP 缓存来取 SW 脚本本身，否则新版本可能被压到最长 24 小时后才生效
      updateViaCache: "none",
    });

    // 已经在等待接管的新版本，直接放行
    const activateWaiting = () => {
      if (registration.waiting) registration.waiting.postMessage("SKIP_WAITING");
    };

    activateWaiting();

    registration.addEventListener("updatefound", () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => {
        if (installing.state === "installed") activateWaiting();
      });
    });

    // 新 SW 接管后刷新一次，保证页面跑的是与 SW 配套的新代码
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController) return; // 首次安装，页面本身就是新的

      let alreadyReloaded = false;
      try {
        alreadyReloaded = sessionStorage.getItem(RELOAD_FLAG) === "1";
      } catch {
        /* 读不到就按"没刷新过"处理 */
      }
      if (alreadyReloaded) return;

      try {
        sessionStorage.setItem(RELOAD_FLAG, "1");
      } catch {
        /* 同上 */
      }
      window.location.reload();
    });

    // 手机 PWA 常驻后台，重新打开时不会重新加载页面 —— 靠这个时机抓新版本
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        void registration.update().catch(() => {});
      }
    });

    // 长时间停在同一个页面的兜底检查
    window.setInterval(() => {
      void registration.update().catch(() => {});
    }, 30 * 60 * 1000);
  } catch {
    // PWA 能力是增强项，注册失败不应影响应用本体
  }
}
