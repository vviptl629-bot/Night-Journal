import type { Context, Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import fs from "fs";
import path from "path";

type App = Hono<{ Bindings: HttpBindings }>;

/**
 * 静态资源的缓存策略。
 *
 * 这几个响应头直接决定"发布之后手机上还是旧版"会不会再发生：
 *
 *  - `/assets/*`：文件名自带内容哈希，可以放心长缓存（内容一变文件名就变）
 *  - `/sw.js`  ：必须每次回源校验。否则浏览器会把旧 Service Worker 留在本地，
 *                手机上就会出现"电脑上是新版、手机上是旧版"。
 *  - 其余（index.html / manifest 等）：每次校验，避免旧 index 继续引用旧 bundle。
 *
 * Gateway 本身不发 Cache-Control，所以这里必须显式声明。
 */
function setCacheHeaders(c: Context) {
  const pathname = new URL(c.req.url).pathname;

  if (pathname.startsWith("/assets/")) {
    c.res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
    return;
  }

  if (pathname === "/sw.js") {
    // no-store 而不是 no-cache：SW 脚本一旦被 HTTP 缓存住，
    // 更新检查就要等到缓存过期（浏览器上限 24h），手机端会长时间卡旧版。
    c.res.headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
    c.res.headers.set("Service-Worker-Allowed", "/");
    return;
  }

  c.res.headers.set("Cache-Control", "no-cache");
}

export function serveStaticFiles(app: App) {
  const distPath = path.resolve(import.meta.dirname, "../dist/public");

  // 注册在 serveStatic 之前，等响应生成后再补缓存头（Hono 的后置中间件写法）。
  app.use("*", async (c, next) => {
    const pathname = new URL(c.req.url).pathname;

    // 接口自己有缓存语义（例如导出是 no-store），不要覆盖
    if (pathname.startsWith("/api/")) {
      await next();
      return;
    }

    await next();
    setCacheHeaders(c);
  });

  app.use("*", serveStatic({ root: "./dist/public" }));

  app.notFound((c) => {
    const accept = c.req.header("accept") ?? "";
    if (!accept.includes("text/html")) {
      return c.json({ error: "Not Found" }, 404);
    }
    const indexPath = path.resolve(distPath, "index.html");
    const content = fs.readFileSync(indexPath, "utf-8");
    // 每次回源校验：回退页也必须是"当前"的 index，否则会挂上旧 bundle
    c.header("Cache-Control", "no-cache");
    return c.html(content);
  });
}
