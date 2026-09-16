import "dotenv/config";
import { defineConfig } from "drizzle-kit";

/**
 * DATABASE_URL 现在指向一个 SQLite 文件（不再是 MySQL 连接串）。
 * 解析逻辑与 api/lib/env.ts 的 resolveDatabaseFile() 保持一致，
 * 否则 drizzle-kit 与应用会操作到两个不同的数据库文件。
 */
function resolveDatabaseFile(): string {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) return "./data/night-journal.sqlite";

  return raw.startsWith("file:") ? raw.slice("file:".length) : raw;
}

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: resolveDatabaseFile(),
  },
});
