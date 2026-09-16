import { getSqliteDriver } from "../queries/connection";

/**
 * 启动时幂等建表。
 *
 * 之前这套 DDL 是由 entrypoint.sh 里的 `drizzle-kit push` 执行的，
 * 但部署环境只有一个 HTTP 端口、不保证能跑 devDependencies 里的 CLI，
 * 所以把建表内联进应用启动流程：所有语句都是 IF NOT EXISTS，可安全重复执行。
 *
 * DDL 与 `drizzle-kit generate` 从 db/schema.ts 生成的结果保持一致 ——
 * 改动 schema 后应重新生成并同步到这里。
 */
const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS \`ai_settings\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`user_id\` integer NOT NULL,
	\`vision_api_key\` text,
	\`vision_api_base_url\` text,
	\`vision_model\` text,
	\`enable_image_understanding\` integer DEFAULT true NOT NULL,
	\`vision_prompt_template\` text,
	\`diary_api_key\` text,
	\`diary_api_base_url\` text,
	\`diary_model\` text,
	\`diary_generation_time\` text DEFAULT '02:00',
	\`diary_language\` text DEFAULT 'zh',
	\`diary_style\` text DEFAULT '温柔真实',
	\`diary_length\` text DEFAULT '中',
	\`diary_prompt_template\` text,
	\`style_prompts\` text,
	\`enable_dream\` integer DEFAULT true NOT NULL,
	\`timezone\` text DEFAULT 'Asia/Shanghai',
	\`created_at\` integer DEFAULT (unixepoch()) NOT NULL,
	\`updated_at\` integer DEFAULT (unixepoch()) NOT NULL
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS \`ai_settings_user_id_unique\` ON \`ai_settings\` (\`user_id\`)`,

  `CREATE TABLE IF NOT EXISTS \`diaries\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`user_id\` integer NOT NULL,
	\`diary_date\` text NOT NULL,
	\`title\` text,
	\`summary\` text,
	\`content\` text,
	\`style\` text DEFAULT '温柔真实',
	\`length\` text DEFAULT '中',
	\`diary_model_used\` text,
	\`generation_status\` text DEFAULT 'pending' NOT NULL,
	\`generation_error\` text,
	\`generated_at\` integer,
	\`manually_edited\` integer DEFAULT false NOT NULL,
	\`created_at\` integer DEFAULT (unixepoch()) NOT NULL,
	\`updated_at\` integer DEFAULT (unixepoch()) NOT NULL
)`,

  `CREATE TABLE IF NOT EXISTS \`diary_versions\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`diary_id\` integer NOT NULL,
	\`user_id\` integer NOT NULL,
	\`title\` text,
	\`summary\` text,
	\`content\` text,
	\`diary_model_used\` text,
	\`prompt_snapshot\` text,
	\`created_at\` integer DEFAULT (unixepoch()) NOT NULL
)`,

  `CREATE TABLE IF NOT EXISTS \`entries\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`user_id\` integer NOT NULL,
	\`content_text\` text NOT NULL,
	\`mood_label\` text,
	\`created_at\` integer DEFAULT (unixepoch()) NOT NULL,
	\`updated_at\` integer DEFAULT (unixepoch()) NOT NULL,
	\`entry_date\` text NOT NULL,
	\`has_images\` integer DEFAULT false NOT NULL,
	\`included_in_diary\` integer DEFAULT false NOT NULL,
	\`deleted_at\` integer
)`,

  `CREATE TABLE IF NOT EXISTS \`entry_attachments\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`entry_id\` integer NOT NULL,
	\`user_id\` integer NOT NULL,
	\`file_url\` text NOT NULL,
	\`file_type\` text NOT NULL,
	\`file_name\` text NOT NULL,
	\`storage_path\` text NOT NULL,
	\`vision_status\` text DEFAULT 'pending' NOT NULL,
	\`vision_summary\` text,
	\`vision_model_used\` text,
	\`vision_context_snapshot\` text,
	\`created_at\` integer DEFAULT (unixepoch()) NOT NULL,
	\`updated_at\` integer DEFAULT (unixepoch()) NOT NULL
)`,

  `CREATE TABLE IF NOT EXISTS \`model_presets\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`user_id\` integer NOT NULL,
	\`name\` text NOT NULL,
	\`type\` text NOT NULL,
	\`api_base_url\` text,
	\`api_key\` text,
	\`model\` text,
	\`created_at\` integer DEFAULT (unixepoch()) NOT NULL,
	\`updated_at\` integer DEFAULT (unixepoch()) NOT NULL
)`,

  `CREATE TABLE IF NOT EXISTS \`short_term_memories\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`user_id\` integer NOT NULL,
	\`content\` text NOT NULL,
	\`category\` text DEFAULT 'other' NOT NULL,
	\`importance\` integer DEFAULT 3 NOT NULL,
	\`first_seen_at\` integer DEFAULT (unixepoch()) NOT NULL,
	\`last_referenced_at\` integer DEFAULT (unixepoch()) NOT NULL,
	\`decay_at\` integer NOT NULL,
	\`created_at\` integer DEFAULT (unixepoch()) NOT NULL,
	\`updated_at\` integer DEFAULT (unixepoch()) NOT NULL
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS \`content_unique\` ON \`short_term_memories\` (\`user_id\`,\`content\`)`,

  `CREATE TABLE IF NOT EXISTS \`user_profiles\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`user_id\` integer NOT NULL,
	\`persona\` text,
	\`relationships\` text,
	\`emotional_tone\` text,
	\`language_style\` text,
	\`summary\` text,
	\`version\` integer DEFAULT 1 NOT NULL,
	\`created_at\` integer DEFAULT (unixepoch()) NOT NULL,
	\`updated_at\` integer DEFAULT (unixepoch()) NOT NULL
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS \`user_profiles_user_id_unique\` ON \`user_profiles\` (\`user_id\`)`,

  `CREATE TABLE IF NOT EXISTS \`users\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`unionId\` text NOT NULL,
	\`username\` text,
	\`password_hash\` text,
	\`name\` text,
	\`email\` text,
	\`avatar\` text,
	\`role\` text DEFAULT 'user' NOT NULL,
	\`createdAt\` integer DEFAULT (unixepoch()) NOT NULL,
	\`updatedAt\` integer DEFAULT (unixepoch()) NOT NULL,
	\`lastSignInAt\` integer DEFAULT (unixepoch()) NOT NULL
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS \`users_unionId_unique\` ON \`users\` (\`unionId\`)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS \`users_username_unique\` ON \`users\` (\`username\`)`,
];

export function ensureSchema(): string {
  const driver = getSqliteDriver();
  for (const statement of DDL) {
    driver.exec(statement);
  }
  return driver.kind;
}
