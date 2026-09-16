import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const isProduction = process.env.NODE_ENV === "production";

/**
 * 生成 APP_SECRET 并持久化到 data/ 目录。
 *
 * 与容器 entrypoint 那种"每次重启都换一把"的做法不同：这里会把密钥落到
 * data/.app-secret，重启后依然能解开既有的 JWT 会话。
 *
 * 单机自托管场景下这是合理的默认：零配置即可启动，同时避免
 * "重启一次就全员掉线"的体验问题。若宿主通过环境变量显式指定，则优先使用。
 */
function generateAndPersistSecret(): string {
  const dir = path.resolve(process.cwd(), "data");
  const file = path.join(dir, ".app-secret");

  try {
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, "utf8").trim();
      if (existing) return existing;
    }
  } catch {
    /* 读不到就当没有，下面会重新生成 */
  }

  const secret = crypto.randomBytes(32).toString("hex");

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
  } catch {
    console.warn(
      "[env] WARNING: APP_SECRET 无法持久化到 data/.app-secret，" +
        "服务重启后已登录会话会失效。",
    );
  }

  return secret;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    if (isProduction) {
      // 生产环境不允许退回随机值（那样每次重启都会让会话失效），
      // 但也不应直接崩掉 —— 自动生成一次并持久化，保证零配置可启动。
      console.warn(
        `[env] WARNING: ${name} is not set. Generated one and persisted to data/.app-secret.`,
      );
      return generateAndPersistSecret();
    }
    console.warn(
      `[env] WARNING: ${name} is not set. Using an insecure fallback for development only.`,
    );
    return `dev-fallback-${name}-${Math.random().toString(36).slice(2)}`;
  }
  return value;
}

/**
 * 解析 SQLite 数据库文件位置。
 *
 * 支持三种写法：
 *   - 未设置 DATABASE_URL      -> ./data/night-journal.sqlite
 *   - "file:./data/app.sqlite" -> 去掉 file: 前缀
 *   - "./data/app.sqlite"      -> 直接当路径
 *
 * 相对路径一律相对进程工作目录解析，这样无论是本地跑还是容器/沙箱里跑，
 * 数据库都会稳定落在项目的 data/ 目录下。
 */
function resolveDatabaseFile(): string {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) {
    return path.resolve(process.cwd(), "data", "night-journal.sqlite");
  }

  const withoutScheme = raw.startsWith("file:")
    ? raw.slice("file:".length)
    : raw;

  return path.isAbsolute(withoutScheme)
    ? withoutScheme
    : path.resolve(process.cwd(), withoutScheme);
}

export const env = {
  // Core — always required
  appSecret: required("APP_SECRET"),
  isProduction,
  // SQLite database file (no external database service needed).
  databaseFile: resolveDatabaseFile(),
  // Optional — admin union_id (typically "local:<username>")
  ownerUnionId: process.env.OWNER_UNION_ID ?? "",
};
