import { createRequire as createSqliteRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

// 注意：变量名必须区别于构建 banner 注入的 `require`，否则 esbuild 打包后会
// 出现 "Identifier 'createRequire' has already been declared" 的冲突。
const nodeRequire = createSqliteRequire(import.meta.url);

/**
 * SQLite 驱动适配层。
 *
 * 同时支持两种驱动，运行时择优：
 *
 *   1. `node:sqlite`  —— Node 内置（>= 22.5，需 --experimental-sqlite）。
 *      零第三方依赖，跨平台行为一致，没有原生模块 ABI / 编译问题。
 *   2. `better-sqlite3` —— 成熟第三方库，自带多平台预编译二进制。
 *
 * 两者的 prepared statement 接口（prepare/get/all/run/exec）语义一致，
 * 所以上层可以用同一套代码驱动，不需要关心当前用的是哪一个。
 */

export interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

export interface SqliteDriver {
  /** 实际生效的驱动名，用于启动日志与排障。 */
  kind: "node:sqlite" | "better-sqlite3";
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

function tryNodeSqlite(file: string): SqliteDriver | null {
  try {
    const mod = nodeRequire("node:sqlite") as {
      DatabaseSync: new (f: string) => {
        prepare(sql: string): SqliteStatement;
        exec(sql: string): void;
        close(): void;
      };
    };
    const db = new mod.DatabaseSync(file);
    return {
      kind: "node:sqlite",
      prepare: (sql) => db.prepare(sql),
      exec: (sql) => db.exec(sql),
      close: () => db.close(),
    };
  } catch {
    return null;
  }
}

function tryBetterSqlite3(file: string): SqliteDriver | null {
  try {
    const Database = nodeRequire("better-sqlite3") as new (f: string) => {
      prepare(sql: string): SqliteStatement;
      exec(sql: string): void;
      close(): void;
    };
    const db = new Database(file);
    return {
      kind: "better-sqlite3",
      prepare: (sql) => db.prepare(sql),
      exec: (sql) => db.exec(sql),
      close: () => db.close(),
    };
  } catch {
    return null;
  }
}

export function openSqliteDatabase(file: string): SqliteDriver {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const driver = tryNodeSqlite(file) ?? tryBetterSqlite3(file);

  if (!driver) {
    throw new Error(
      "[sqlite] 找不到可用的 SQLite 驱动。请使用 Node >= 22.5 并在启动时加 --experimental-sqlite，" +
        "或安装 better-sqlite3。",
    );
  }

  // WAL 让读写并发更顺畅（日记生成是长任务，期间用户仍可能记录碎片）。
  // 某些构建可能禁用该 pragma，失败不影响主流程。
  try {
    driver.exec("PRAGMA journal_mode = WAL");
  } catch {
    /* ignore */
  }
  try {
    driver.exec("PRAGMA foreign_keys = ON");
  } catch {
    /* ignore */
  }

  return driver;
}
