import {
  sqliteTable,
  integer,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ─── Dialect notes (SQLite) ────────────────────────────────────────
//
// Migrated from MySQL to SQLite so the whole app can ship as a single
// self-contained service (one HTTP port, database file inside the
// project) instead of requiring an external MySQL server.
//
// Type mapping applied:
//   serial()                          -> integer().primaryKey({autoIncrement})
//   varchar(n)                        -> text()
//   mysqlEnum(col, [...])             -> text(col, { enum: [...] })
//   bigint({mode:'number',unsigned})  -> integer()
//   boolean()                         -> integer({ mode: "boolean" })
//   timestamp()                       -> integer({ mode: "timestamp" })  // Unix seconds
//   date()                            -> text()                          // 'YYYY-MM-DD'
//
// `timestamp({mode:"timestamp"})` stores Unix **seconds** and hands back a
// JS `Date`, so all existing date arithmetic in api/ keeps working.

const now = sql`(unixepoch())`;

const createdAt = () =>
  integer("created_at", { mode: "timestamp" }).default(now).notNull();

const updatedAt = () =>
  integer("updated_at", { mode: "timestamp" })
    .default(now)
    .notNull()
    .$onUpdate(() => new Date());

// ─── Users (auth feature) ──────────────────────────────────────────

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  unionId: text("unionId").notNull().unique(),
  // Local auth fields (null for OAuth-only users)
  username: text("username").unique(),
  passwordHash: text("password_hash"),
  name: text("name"),
  email: text("email"),
  avatar: text("avatar"),
  role: text("role", { enum: ["user", "admin"] }).default("user").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(now).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" })
    .default(now)
    .notNull()
    .$onUpdate(() => new Date()),
  lastSignInAt: integer("lastSignInAt", { mode: "timestamp" })
    .default(now)
    .notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ─── Entries — user fragments ──────────────────────────────────────

export const entries = sqliteTable("entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  contentText: text("content_text").notNull(),
  moodLabel: text("mood_label"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  entryDate: text("entry_date").notNull(),
  hasImages: integer("has_images", { mode: "boolean" })
    .default(false)
    .notNull(),
  includedInDiary: integer("included_in_diary", { mode: "boolean" })
    .default(false)
    .notNull(),
  deletedAt: integer("deleted_at", { mode: "timestamp" }),
});

export type Entry = typeof entries.$inferSelect;
export type InsertEntry = typeof entries.$inferInsert;

// ─── Entry Attachments (images) ────────────────────────────────────

export const entryAttachments = sqliteTable("entry_attachments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  entryId: integer("entry_id").notNull(),
  userId: integer("user_id").notNull(),
  fileUrl: text("file_url").notNull(),
  fileType: text("file_type").notNull(),
  fileName: text("file_name").notNull(),
  storagePath: text("storage_path").notNull(),
  visionStatus: text("vision_status").default("pending").notNull(),
  visionSummary: text("vision_summary"),
  visionModelUsed: text("vision_model_used"),
  visionContextSnapshot: text("vision_context_snapshot"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type EntryAttachment = typeof entryAttachments.$inferSelect;
export type InsertEntryAttachment = typeof entryAttachments.$inferInsert;

// ─── Diaries — AI generated diaries ────────────────────────────────

export const diaries = sqliteTable("diaries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  diaryDate: text("diary_date").notNull(),
  title: text("title"),
  summary: text("summary"),
  content: text("content"),
  style: text("style").default("温柔真实"),
  length: text("length").default("中"),
  diaryModelUsed: text("diary_model_used"),
  generationStatus: text("generation_status").default("pending").notNull(),
  generationError: text("generation_error"),
  generatedAt: integer("generated_at", { mode: "timestamp" }),
  manuallyEdited: integer("manually_edited", { mode: "boolean" })
    .default(false)
    .notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Diary = typeof diaries.$inferSelect;
export type InsertDiary = typeof diaries.$inferInsert;

// ─── Diary Versions — history of regenerations ─────────────────────

export const diaryVersions = sqliteTable("diary_versions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  diaryId: integer("diary_id").notNull(),
  userId: integer("user_id").notNull(),
  title: text("title"),
  summary: text("summary"),
  content: text("content"),
  diaryModelUsed: text("diary_model_used"),
  promptSnapshot: text("prompt_snapshot"),
  createdAt: createdAt(),
});

export type DiaryVersion = typeof diaryVersions.$inferSelect;
export type InsertDiaryVersion = typeof diaryVersions.$inferInsert;

// ─── AI Settings — user-configurable AI models and prompts ─────────

export const aiSettings = sqliteTable("ai_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().unique(),
  // Vision model config
  // NOTE: API keys are encrypted at-rest using AES-256-GCM (see api/lib/crypto.ts).
  visionApiKey: text("vision_api_key"),
  visionApiBaseUrl: text("vision_api_base_url"),
  visionModel: text("vision_model"),
  enableImageUnderstanding: integer("enable_image_understanding", {
    mode: "boolean",
  })
    .default(true)
    .notNull(),
  visionPromptTemplate: text("vision_prompt_template"),
  // Diary writer model config
  // NOTE: API keys are encrypted at-rest using AES-256-GCM (see api/lib/crypto.ts).
  diaryApiKey: text("diary_api_key"),
  diaryApiBaseUrl: text("diary_api_base_url"),
  diaryModel: text("diary_model"),
  diaryGenerationTime: text("diary_generation_time").default("02:00"),
  diaryLanguage: text("diary_language").default("zh"),
  diaryStyle: text("diary_style").default("温柔真实"),
  diaryLength: text("diary_length").default("中"),
  diaryPromptTemplate: text("diary_prompt_template"),
  // Per-style editable prompt snippets, stored as JSON: { "温柔真实": "...", "文学感": "..." }
  stylePrompts: text("style_prompts"),
  // Dream memory: when true, diary generation triggers an async profile-update
  // pass that maintains a long-term user profile + short-term memories, which
  // are injected into subsequent diary prompts for continuity.
  enableDream: integer("enable_dream", { mode: "boolean" })
    .default(true)
    .notNull(),
  // General
  timezone: text("timezone").default("Asia/Shanghai"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type AiSettings = typeof aiSettings.$inferSelect;
export type InsertAiSettings = typeof aiSettings.$inferInsert;

// ─── Model Presets — saved API configurations for quick switching ───

export const modelPresets = sqliteTable("model_presets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  name: text("name").notNull(),
  type: text("type", { enum: ["vision", "diary"] }).notNull(),
  apiBaseUrl: text("api_base_url"),
  apiKey: text("api_key"), // encrypted at-rest using AES-256-GCM (see api/lib/crypto.ts)
  model: text("model"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type ModelPreset = typeof modelPresets.$inferSelect;
export type InsertModelPreset = typeof modelPresets.$inferInsert;

// ─── User Profiles — long-term abstract understanding of the user ──
//
// Dream mechanism: one row per user. Maintained incrementally by the Dream
// pass (api/services/dream.ts) after each diary generation. Stores abstract
// traits only — persona, relationships, emotional tone, language style —
// never concrete events. Injected into diary prompts for continuity.

export const userProfiles = sqliteTable("user_profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().unique(),
  persona: text("persona"),
  relationships: text("relationships"),
  emotionalTone: text("emotional_tone"),
  languageStyle: text("language_style"),
  summary: text("summary"),
  version: integer("version").default(1).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type UserProfile = typeof userProfiles.$inferSelect;
export type InsertUserProfile = typeof userProfiles.$inferInsert;

// ─── Short-term Memories — abstract recent state, 14-day decay ──────
//
// Multi-row per user. Abstract descriptions of recent state (e.g. "recently
// under deadline pressure"), NOT concrete events. Decays after 14 days;
// deleted when decayAt passes. Referenced memories refresh
// lastReferencedAt to stay relevant longer.
//
// The (user_id, content) unique index drives an upsert during the Dream
// merge pass, so at most one row exists per (user, content).

export const shortTermMemories = sqliteTable(
  "short_term_memories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    content: text("content").notNull(),
    category: text("category", {
      enum: ["mood", "focus", "relationship", "other"],
    })
      .default("other")
      .notNull(),
    importance: integer("importance").default(3).notNull(),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp" })
      .default(now)
      .notNull(),
    lastReferencedAt: integer("last_referenced_at", { mode: "timestamp" })
      .default(now)
      .notNull(),
    decayAt: integer("decay_at", { mode: "timestamp" }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Ensures the Dream merge pass can upsert safely: at most one row per
    // (user_id, content). Expired memories are hard-deleted (not soft-archived),
    // so a memory can be re-created fresh after its previous incarnation expired.
    uniqueIndex("content_unique").on(table.userId, table.content),
  ],
);

export type ShortTermMemory = typeof shortTermMemories.$inferSelect;
export type InsertShortTermMemory = typeof shortTermMemories.$inferInsert;
