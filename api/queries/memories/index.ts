import { eq, and, desc, lt, gte, sql } from "drizzle-orm";
import { getDb } from "../connection";
import { userProfiles, shortTermMemories } from "@db/schema";
import type { ShortTermMemory } from "@db/schema";

// ─── User Profile (long-term, one row per user) ────────────────────

export async function findProfileByUserId(userId: number) {
  const rows = await getDb()
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  return rows.at(0);
}

export interface ProfileUpdate {
  persona?: string | null;
  relationships?: string | null;
  emotionalTone?: string | null;
  languageStyle?: string | null;
  summary?: string | null;
}

/**
 * Atomically upsert the user profile using INSERT ... ON CONFLICT DO
 * UPDATE (relies on the `user_id` UNIQUE constraint).
 *
 * On insert: all fields written as-is, version defaults to 1.
 * On update: each field is set to IFNULL(excluded.col, col) — if the new
 * value is NULL, the existing value is preserved. version is atomically
 * incremented. This eliminates the read-then-write TOCTOU race that the
 * previous implementation had when two Dream passes ran concurrently.
 */
export async function upsertProfile(userId: number, data: ProfileUpdate) {
  const db = getDb();

  await db
    .insert(userProfiles)
    .values({
      userId,
      persona: data.persona ?? null,
      relationships: data.relationships ?? null,
      emotionalTone: data.emotionalTone ?? null,
      languageStyle: data.languageStyle ?? null,
      summary: data.summary ?? null,
    })
    .onConflictDoUpdate({
      target: userProfiles.userId,
      set: {
        // SQLite 用 excluded.<col> 表示"本次本应插入的值"（对应 MySQL 的 VALUES(col)）
        persona: sql`IFNULL(excluded.persona, ${userProfiles.persona})`,
        relationships: sql`IFNULL(excluded.relationships, ${userProfiles.relationships})`,
        emotionalTone: sql`IFNULL(excluded.emotional_tone, ${userProfiles.emotionalTone})`,
        languageStyle: sql`IFNULL(excluded.language_style, ${userProfiles.languageStyle})`,
        summary: sql`IFNULL(excluded.summary, ${userProfiles.summary})`,
        version: sql`${userProfiles.version} + 1`,
      },
    });

  return findProfileByUserId(userId);
}

/**
 * Delete the user's long-term profile. Short-term memories are unaffected
 * (they have their own decay lifecycle). Used by the "reset profile" feature
 * in Settings when the user notices the profile has drifted from reality.
 */
export async function resetProfile(userId: number) {
  await getDb()
    .delete(userProfiles)
    .where(eq(userProfiles.userId, userId));
}

// ─── Short-term Memories (multi-row, 14-day decay) ──────────────────

export interface ShortTermMemoryInput {
  content: string;
  category: "mood" | "focus" | "relationship" | "other";
  importance: number;
}

// Hard cap on how long a "short-term" memory can stay active by repeated
// refresh. Even if the LLM keeps outputting the same theme every Dream pass,
// after 30 days from firstSeenAt we stop extending decayAt — the memory
// will naturally archive when its current decayAt passes. This prevents
// short_term_memories from silently becoming permanent storage.
const SHORT_TERM_MAX_AGE_DAYS = 30;
const SHORT_TERM_DECAY_DAYS = 14;

/**
 * Merge newly extracted short-term memories into storage atomically.
 *
 * Uses INSERT ... ON CONFLICT DO UPDATE with the `(user_id, content)`
 * unique index. On conflict (existing row with same content):
 *  - lastReferencedAt always refreshed (it was referenced)
 *  - decayAt extended by 14 days ONLY if firstSeenAt is under 30 days old
 *  - importance raised to the max of existing and new
 *
 * This eliminates the select-then-insert TOCTOU race of the previous
 * implementation.
 */
export async function mergeShortTermMemories(userId: number, inputs: ShortTermMemoryInput[]) {
  const db = getDb();
  const now = new Date();
  const decayAt = new Date(now.getTime() + SHORT_TERM_DECAY_DAYS * 24 * 60 * 60 * 1000);
  // better-sqlite3 不接受 Date 作为绑定参数，裸 SQL 里必须显式传 Unix 秒。
  const decayAtSeconds = Math.floor(decayAt.getTime() / 1000);
  const maxAgeSeconds = SHORT_TERM_MAX_AGE_DAYS * 24 * 60 * 60;

  for (const input of inputs) {
    const content = input.content.trim();
    if (!content) continue;

    await db
      .insert(shortTermMemories)
      .values({
        userId,
        content,
        category: input.category,
        importance: input.importance,
        firstSeenAt: now,
        lastReferencedAt: now,
        decayAt,
      })
      .onConflictDoUpdate({
        target: [shortTermMemories.userId, shortTermMemories.content],
        set: {
          lastReferencedAt: now,
          // 只在记忆未超过年龄上限时续期；超限的保留原 decay_at，
          // 让它自然到期后被清理。
          // first_seen_at 存的是 Unix 秒，所以年龄用秒差比较。
          decayAt: sql`CASE WHEN (unixepoch() - first_seen_at) > ${maxAgeSeconds} THEN decay_at ELSE ${decayAtSeconds} END`,
          importance: sql`MAX(importance, ${input.importance})`,
        },
      });
  }
}

/**
 * Active memories for a user, ordered by importance then recency of
 * reference. Used for prompt injection and the Settings view.
 */
export async function findActiveShortTermMemories(
  userId: number,
  limit = 10,
): Promise<ShortTermMemory[]> {
  const now = new Date();
  return getDb()
    .select()
    .from(shortTermMemories)
    .where(and(eq(shortTermMemories.userId, userId), gte(shortTermMemories.decayAt, now)))
    .orderBy(desc(shortTermMemories.importance), desc(shortTermMemories.lastReferencedAt))
    .limit(limit);
}

/**
 * Delete all memories whose decayAt has passed. Called from the scheduler
 * tick once per day, and after each Dream pass for a specific user.
 * Returns the count deleted (useful for logging).
 *
 * Hard-deletes (not soft-archives) so that the same content can be
 * re-created fresh by a future Dream pass without unique-constraint
 * collisions.
 */
export async function archiveExpiredMemories(userId?: number): Promise<number> {
  const db = getDb();
  const now = new Date();
  const conditions = [lt(shortTermMemories.decayAt, now)];
  if (userId !== undefined) {
    conditions.push(eq(shortTermMemories.userId, userId));
  }

  const result = await db
    .delete(shortTermMemories)
    .where(and(...conditions));

  // better-sqlite3 写操作返回 { changes, lastInsertRowid }（MySQL 是 affectedRows）
  const affected = (result as unknown as { changes?: number }).changes;
  return typeof affected === "number" ? affected : 0;
}

export async function deleteShortTermMemory(userId: number, memoryId: number) {
  await getDb()
    .delete(shortTermMemories)
    .where(
      and(
        eq(shortTermMemories.id, memoryId),
        eq(shortTermMemories.userId, userId),
      ),
    );
}
