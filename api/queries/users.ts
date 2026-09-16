import { eq, sql } from "drizzle-orm";
import * as schema from "@db/schema";
import type { InsertUser } from "@db/schema";
import { getDb } from "./connection";
import { env } from "../lib/env";

export async function findUserByUnionId(unionId: string) {
  const rows = await getDb()
    .select()
    .from(schema.users)
    .where(eq(schema.users.unionId, unionId))
    .limit(1);
  return rows.at(0);
}

/**
 * Lookup used by login/register for local accounts.
 * Case-insensitive so "Alan" and "alan" resolve to the same user.
 */
export async function findUserByUsername(username: string) {
  const rows = await getDb()
    .select()
    .from(schema.users)
    .where(sql`lower(${schema.users.username}) = ${username.trim().toLowerCase()}`)
    .limit(1);
  return rows.at(0);
}

export async function findAllUsers() {
  return getDb().select().from(schema.users);
}

/**
 * Create a local (username + password) user.
 * unionId is auto-generated with a "local:" prefix so it never
 * collides with Kimi OAuth union IDs.
 */
export async function createLocalUser(data: {
  username: string;
  passwordHash: string;
  name?: string;
}) {
  const unionId = `local:${data.username}`;
  const values: InsertUser = {
    unionId,
    username: data.username,
    passwordHash: data.passwordHash,
    name: data.name ?? data.username,
    lastSignInAt: new Date(),
  };

  if (unionId === env.ownerUnionId) {
    values.role = "admin";
  }

  await getDb().insert(schema.users).values(values);
  return findUserByUnionId(unionId);
}

/**
 * Permanently delete a local account and every row that belongs to it.
 *
 * Used by "delete my account" (POST/DELETE /api/auth/account). Tables are
 * removed child-first so no orphans are left behind, and the username is
 * freed up for re-registration.
 */
export async function deleteUserCascade(userId: number) {
  const db = getDb();
  const owned = eq(schema.users.id, userId);

  // Child rows first (attachments reference entries, versions reference diaries)
  await db.delete(schema.entryAttachments).where(eq(schema.entryAttachments.userId, userId));
  await db.delete(schema.diaryVersions).where(eq(schema.diaryVersions.userId, userId));
  await db.delete(schema.shortTermMemories).where(eq(schema.shortTermMemories.userId, userId));
  await db.delete(schema.userProfiles).where(eq(schema.userProfiles.userId, userId));
  await db.delete(schema.modelPresets).where(eq(schema.modelPresets.userId, userId));
  await db.delete(schema.aiSettings).where(eq(schema.aiSettings.userId, userId));
  await db.delete(schema.diaries).where(eq(schema.diaries.userId, userId));
  await db.delete(schema.entries).where(eq(schema.entries.userId, userId));
  await db.delete(schema.users).where(owned);
}

export async function upsertUser(data: InsertUser) {
  const values = { ...data };
  const updateSet: Partial<InsertUser> = {
    lastSignInAt: new Date(),
    ...data,
  };

  if (
    values.role === undefined &&
    values.unionId &&
    values.unionId === env.ownerUnionId
  ) {
    values.role = "admin";
    updateSet.role = "admin";
  }

  await getDb()
    .insert(schema.users)
    .values(values)
    .onConflictDoUpdate({ target: schema.users.unionId, set: updateSet });
}
