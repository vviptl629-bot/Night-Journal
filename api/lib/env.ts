import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  persistDir,
  dataRoot,
  migrateIntoDataRoot,
  restoreDatabase,
  DB_FILE_NAME,
} from "./persist";

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

  // 部署会替换整个项目目录，data/ 里的密钥同样会丢。
  // 因此额外在"项目目录之外"的持久目录留一份，并优先读它。
  const persistent = persistDir();
  const persistFile = persistent ? path.join(persistent, ".app-secret") : null;

  const readSecret = (target: string | null): string => {
    if (!target) return "";
    try {
      if (fs.existsSync(target)) {
        return fs.readFileSync(target, "utf8").trim();
      }
    } catch {
      /* 读不到就当没有 */
    }
    return "";
  };

  const existing = readSecret(persistFile) || readSecret(file);
  if (existing) {
    // 顺手补回可能缺失的那一份
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, existing, { mode: 0o600 });
    } catch {
      /* ignore */
    }
    return existing;
  }

  const secret = crypto.randomBytes(32).toString("hex");
  let written = false;

  for (const target of [persistFile, file]) {
    if (!target) continue;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, secret, { mode: 0o600 });
      written = true;
    } catch {
      /* ignore */
    }
  }

  if (!written) {
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
 *   - 未设置 DATABASE_URL      -> <持久目录>/night-journal.sqlite
 *                                 （持久目录在项目目录之外，见 lib/persist.ts）
 *   - "file:./data/app.sqlite" -> 去掉 file: 前缀
 *   - "./data/app.sqlite"      -> 直接当路径
 *
 * 相对路径一律相对进程工作目录解析，这样无论是本地跑还是容器/沙箱里跑，
 * 数据库都会稳定落在项目的 data/ 目录下。
 */
function resolveDatabaseFile(): string {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) {
    // 主库默认放在**项目目录之外**的持久目录，避免重新部署时被整块替换。
    const root = dataRoot();
    const legacy = path.resolve(process.cwd(), "data", DB_FILE_NAME);
    if (!root) return legacy;

    const target = path.join(root, DB_FILE_NAME);
    if (fs.existsSync(target)) return target;

    // 目标位置没有库时的优先级：
    //   1. 持久目录里的快照 —— 那才是线上真实数据
    //   2. 旧的项目目录内 data/ 副本（本机开发时用）
    // 顺序不能反：部署会把本机 data/ 一起上传，若优先迁移它，
    // 反而会用开发机的库覆盖线上数据。
    if (!restoreDatabase(target)) {
      migrateIntoDataRoot(DB_FILE_NAME);
    }
    return target;
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
