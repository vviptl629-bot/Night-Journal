/**
 * 备份接口（需登录）：
 *
 *   GET  /api/backup/list?       — 列出服务端已有的数据库快照
 *   POST /api/backup/now         — 立即打一份快照
 *   GET  /api/backup/download?id — 下载指定快照（.sqlite 文件）
 *
 * 快照目录在项目目录之外，重新部署不会被抹掉；启动时若主库缺失会自动
 * 从最新快照恢复，所以这些文件就是数据兜底的最后一道防线。
 */

import type { Context } from "hono";
import fs from "node:fs";
import { env } from "./lib/env";
import {
  createSnapshot,
  listSnapshots,
  resolveSnapshotFile,
} from "./lib/persist";
import { authenticateRequest } from "./auth/session";
import { getSqliteDriver } from "./queries/connection";
import { getDb } from "./queries/connection";
import { eq } from "drizzle-orm";
import * as schema from "@db/schema";

async function requireUser(c: Context) {
  try {
    return await authenticateRequest(c.req.raw.headers);
  } catch {
    return null;
  }
}

export function createBackupListHandler() {
  return async (c: Context) => {
    const user = await requireUser(c);
    if (!user) return c.json({ error: "请先登录" }, 401);
    const snapshots = listSnapshots();
    return c.json({ ok: true, snapshots });
  };
}

export function createBackupNowHandler() {
  return async (c: Context) => {
    const user = await requireUser(c);
    if (!user) return c.json({ error: "请先登录" }, 401);
    const snapshot = createSnapshot(env.databaseFile, getSqliteDriver());
    if (!snapshot) {
      return c.json({ error: "快照失败，可能没有可用的备份目录" }, 500);
    }
    return c.json({ ok: true, snapshot });
  };
}

/**
 * 真正的全量数据导出（原先设置页里的"数据导出"只是个占位 JSON，
 * 导出来根本没有日记内容，等于没有备份）。
 */
export function createDataExportHandler() {
  return async (c: Context) => {
    const user = await requireUser(c);
    if (!user) return c.json({ error: "请先登录" }, 401);

    const db = getDb();
    const [entries, diaries, attachments] = await Promise.all([
      db
        .select()
        .from(schema.entries)
        .where(eq(schema.entries.userId, user.id)),
      db
        .select()
        .from(schema.diaries)
        .where(eq(schema.diaries.userId, user.id)),
      db
        .select()
        .from(schema.entryAttachments)
        .where(eq(schema.entryAttachments.userId, user.id)),
    ]);

    const alive = entries.filter((e) => !e.deletedAt);
    const payload = {
      app: "Night Journal",
      exportedAt: new Date().toISOString(),
      user: { id: user.id, username: user.username ?? null, name: user.name ?? null },
      entries: alive,
      deletedEntries: entries.filter((e) => e.deletedAt).length,
      diaries,
      attachments,
    };

    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="night-journal-${new Date()
          .toISOString()
          .slice(0, 10)}.json"`,
        "Cache-Control": "no-store",
      },
    });
  };
}

export function createBackupDownloadHandler() {
  return async (c: Context) => {
    const user = await requireUser(c);
    if (!user) return c.json({ error: "请先登录" }, 401);

    const id = c.req.query("id") ?? "";
    const file = resolveSnapshotFile(id);
    if (!file) return c.json({ error: "快照不存在" }, 404);

    const data = fs.readFileSync(file);
    return new Response(data, {
      headers: {
        "Content-Type": "application/x-sqlite3",
        "Content-Disposition": `attachment; filename="${id}"`,
        "Cache-Control": "no-store",
      },
    });
  };
}
