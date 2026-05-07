// blog dogfood: Drizzle schema (= D1 SQLite)。Cloudflare Workers の `env.DB`
// (D1Database) に対して Drizzle ORM (`drizzle-orm/d1`) で type-safe query を
// 投げる。`getRequestEnv<{ DB: D1Database }>()` で取った env を `drizzle(env.DB,
// { schema })` に渡す形 (= 実装は ../data/posts.ts)。
//
// schema 変更時は `pnpm drizzle-kit generate` で migration SQL を生成、
// `pnpm wrangler d1 migrations apply blog-db --local` で local に apply する。
//
// 旧 in-memory store (data/posts.ts の sorted: readonly Post[]) は削除済。seed
// は drizzle/0001_seed_posts.sql 経由 (= drizzle-kit generate --custom で
// empty migration を作って手書き SQL で insert する流儀)。

import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const posts = sqliteTable("posts", {
  // slug を primary key にする (= URL identifier、blog content addressable)。
  slug: text("slug").primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  // ISO 8601 文字列で保存 (= JSON serialize 通る、Date instance ではない)。
  // SQLite には native Date 型がないので TEXT 列として扱う。
  publishedAt: text("published_at").notNull(),
});

export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;
