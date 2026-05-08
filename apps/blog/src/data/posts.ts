// blog dogfood: posts data layer。D1 (SQLite) + Drizzle ORM 経由で取得する。
// 旧 in-memory `sorted: readonly Post[]` は ADR 0066 dogfood Step 3 で D1 に置換済。
// .server.tsx / server.ts → data/posts.ts と層を 1 段挟む構造は維持 (ADR 0058 の
// 「.server.tsx (component) と server.ts (logic) の責務分離」)。
//
// runtime: `getRequestEnv<{ DB: D1Database }>()` で per-request の env を取り、
// `drizzle(env.DB, { schema })` で type-safe ORM handle を作る。各 helper は
// 必要な時だけ handle を作る (= per-request short-lived、isolate global は持たない)。
//
// schema 変更時:
//   1. src/db/schema.ts を編集
//   2. `pnpm db:generate` で migration SQL 生成
//   3. `pnpm db:migrate:local` で local D1 に apply (本番 deploy 時は `:remote`)

import { drizzle } from "drizzle-orm/d1";
import { desc } from "drizzle-orm";
import { getRequestEnv } from "@vidro/router/server";
import { posts as postsTable, type NewPost, type Post } from "../db/schema";

export type { NewPost, Post };

type Env = { DB: D1Database };

function getDb() {
  const { DB } = getRequestEnv<Env>();
  return drizzle(DB, { schema: { posts: postsTable } });
}

export const db = {
  /** publishedAt desc に sort された全記事を返す。SSR で `<ul>` に map される想定。 */
  postsAsync: async (): Promise<Post[]> => {
    const drz = getDb();
    return drz.select().from(postsTable).orderBy(desc(postsTable.publishedAt)).all();
  },

  /** slug 単一 lookup。詳細 page (`posts/[slug]/index.server.tsx`) で使う。 */
  postBySlug: async (slug: string): Promise<Post | null> => {
    const drz = getDb();
    const rows = await drz.select().from(postsTable).where(eqSlug(slug)).limit(1).all();
    return rows[0] ?? null;
  },

  /**
   * 1 件 insert。slug は title から自動生成 (= ASCII slugify、空になったら timestamp fallback)。
   * publishedAt は呼び側から渡されなければ現在時刻 (ISO 8601)。dogfood のため最小実装で、
   * slug 衝突時 / 空 title 等の edge は handler 層で先に弾く前提 (= ADR 0059 validation 規約)。
   */
  createPost: async (input: { title: string; body: string }): Promise<Post> => {
    const drz = getDb();
    const row: NewPost = {
      slug: slugify(input.title),
      title: input.title,
      body: input.body,
      publishedAt: new Date().toISOString(),
    };
    const [inserted] = await drz.insert(postsTable).values(row).returning();
    return inserted!;
  },

  /**
   * title / body のみ更新。slug は URL identifier として安定保持 (= rename 不可)。
   * publishedAt も初回作成時から不変 (= 更新時刻が必要なら別 column 拡張)。
   */
  updatePost: async (
    slug: string,
    input: { title: string; body: string },
  ): Promise<Post | null> => {
    const drz = getDb();
    const [updated] = await drz
      .update(postsTable)
      .set({ title: input.title, body: input.body })
      .where(eqSlug(slug))
      .returning();
    return updated ?? null;
  },

  /** slug 単 row delete。戻り値は削除した row (見つからなければ null)。 */
  deletePost: async (slug: string): Promise<Post | null> => {
    const drz = getDb();
    const [deleted] = await drz.delete(postsTable).where(eqSlug(slug)).returning();
    return deleted ?? null;
  },
};

// title から URL slug を作る最小 helper。ASCII 化 + lowercase + `-` join。
// 日本語 title 等で全部除去された場合は `post-<timestamp>` に fallback。
function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return s || `post-${Date.now()}`;
}

// `eq(postsTable.slug, slug)` を呼ぶための薄い helper。drizzle-orm の eq を直 import
// すると import が増えるが、本 file 内 1 箇所しか使わないので import を local に閉じる
// 形は採用しない (= named export 経由)。下の import をまとめる方が clean。
import { eq } from "drizzle-orm";
function eqSlug(slug: string) {
  return eq(postsTable.slug, slug);
}
