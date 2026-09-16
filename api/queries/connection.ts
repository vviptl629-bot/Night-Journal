import { drizzle } from "drizzle-orm/sqlite-proxy";
import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { env } from "../lib/env";
import { openSqliteDatabase, type SqliteDriver } from "../lib/sqlite";
import * as schema from "@db/schema";
import * as relations from "@db/relations";

const fullSchema = { ...schema, ...relations };

let instance: SqliteRemoteDatabase<typeof fullSchema>;
let driver: SqliteDriver | undefined;

/** 暴露底层驱动，供启动时建表 / 健康检查使用。 */
export function getSqliteDriver(): SqliteDriver {
  if (!driver) {
    driver = openSqliteDatabase(env.databaseFile);
  }
  return driver;
}

export function getDb() {
  if (!instance) {
    const handle = getSqliteDriver();

    // 用 sqlite-proxy 适配器桥接：驱动是同步的，这里包成 async 交给 drizzle。
    // 之所以不用 better-sqlite3 专用适配器，是因为它要求驱动实现
    // transaction()/raw() 等 better-sqlite3 专有方法，而 node:sqlite 没有。
    instance = drizzle(
      async (sql, params, method) => {
        const stmt = handle.prepare(sql);

        if (method === "run") {
          stmt.run(...params);
          return { rows: [] };
        }

        if (method === "get") {
          const row = stmt.get(...params) as
            | Record<string, unknown>
            | undefined;
          // 注意语义：sqlite-proxy 的 get 期望 rows **本身就是那一行的值数组**，
          // 且无结果时必须给 falsy —— 否则 drizzle 会构造出一个字段全 undefined
          // 的"幽灵对象"，让 findUser 之类的查询误判为查到了记录。
          return {
            rows: (row ? Object.values(row) : null) as unknown[],
          };
        }

        // all / values：每行一个值数组
        const rows = stmt.all(...params) as Record<string, unknown>[];
        return { rows: rows.map((r) => Object.values(r)) };
      },
      { schema: fullSchema },
    );
  }
  return instance;
}
