import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { createContext } from "./context";
import { env } from "./lib/env";
import { authenticateRequest } from "./auth/session";
import { createRegisterHandler, createLoginHandler } from "./auth/password";
import { createDeleteAccountHandler } from "./auth/account";
import {
  createBackupListHandler,
  createBackupNowHandler,
  createBackupDownloadHandler,
  createDataExportHandler,
} from "./backup";
import { Paths } from "@contracts/constants";
import { saveUploadedFile, getFilePath } from "./lib/upload";
import { startScheduler } from "./lib/scheduler";
import fs from "fs";
import path from "path";

const app = new Hono<{ Bindings: HttpBindings }>();

app.use(bodyLimit({ maxSize: 50 * 1024 * 1024 }));
app.post(Paths.authRegister, createRegisterHandler());
app.post(Paths.authLogin, createLoginHandler());
// Delete-my-account. Accepts both verbs so clients can call it either way.
app.delete(Paths.authAccount, createDeleteAccountHandler());
app.post(Paths.authAccount, createDeleteAccountHandler());

// ── Backups (snapshot list / create / download) ──
app.get("/api/backup/list", createBackupListHandler());
app.post("/api/backup/now", createBackupNowHandler());
app.get("/api/backup/download", createBackupDownloadHandler());
app.get("/api/backup/export", createDataExportHandler());

// ── File upload endpoint ──
app.post("/api/upload/file", async (c) => {
  let user;
  try {
    user = await authenticateRequest(c.req.raw.headers);
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) {
    return c.json({ error: "No file provided" }, 400);
  }

  try {
    const result = await saveUploadedFile(user.id, file);
    return c.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    return c.json({ error: message }, 400);
  }
});

// ── Serve uploaded files ──
app.get("/api/uploads/:userId/:fileName", async (c) => {
  let user;
  try {
    user = await authenticateRequest(c.req.raw.headers);
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const userIdParam = Number(c.req.param("userId"));
  if (!userIdParam || user.id !== userIdParam) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const fileName = c.req.param("fileName");
  if (!fileName || fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
    return c.json({ error: "Invalid file name" }, 400);
  }

  const storagePath = `${userIdParam}/${fileName}`;
  const fullPath = getFilePath(storagePath);
  if (!fullPath) return c.json({ error: "Not Found" }, 404);

  const ext = path.extname(fullPath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".svg": "image/svg+xml",
  };
  const contentType = mimeMap[ext] || "application/octet-stream";
  const data = fs.readFileSync(fullPath);

  return new Response(data, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});

app.use("/api/trpc/*", async (c) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext,
  });
});
app.all("/api/*", (c) => c.json({ error: "Not Found" }, 404));

export default app;

if (env.isProduction) {
  const { serve } = await import("@hono/node-server");
  const { serveStaticFiles } = await import("./lib/vite");
  const { ensureSchema } = await import("./lib/ensure-schema");

  // 重新部署会替换整个项目目录，data/ 里的库可能已经被抹掉。
  // 建表之前先尝试从项目目录之外的备份恢复，避免"发一次版数据就没了"。
  const { restoreDatabase, startAutoSnapshot } = await import("./lib/persist");
  const { getSqliteDriver } = await import("./queries/connection");
  const restored = restoreDatabase(env.databaseFile);
  if (restored) {
    console.log("[boot] 数据库已从持久备份恢复");
  }

  // 建表必须在开始对外服务之前完成，否则第一批请求会打到空库。
  const driverKind = ensureSchema();
  console.log(`[boot] SQLite schema ready (driver: ${driverKind})`);

  // 定时快照 + 退出前快照，保证随时有可恢复点
  startAutoSnapshot(env.databaseFile, getSqliteDriver);

  serveStaticFiles(app);

  const port = parseInt(process.env.PORT || "3000");
  // 显式绑定 0.0.0.0：容器/沙箱里的反向代理需要从外部访问该端口，
  // 只绑 localhost 会导致部署后无法被访问。
  serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
    console.log(`Server running on http://0.0.0.0:${port}/`);
  });
}

if (env.isProduction || process.env.ENABLE_AUTO_GENERATION_IN_DEV === "true") {
  startScheduler();
}
