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
import { posts as postsTable, type Post } from "../db/schema";

export type { Post };

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
};

// `eq(postsTable.slug, slug)` を呼ぶための薄い helper。drizzle-orm の eq を直 import
// すると import が増えるが、本 file 内 1 箇所しか使わないので import を local に閉じる
// 形は採用しない (= named export 経由)。下の import をまとめる方が clean。
import { eq } from "drizzle-orm";
function eqSlug(slug: string) {
  return eq(postsTable.slug, slug);
}
