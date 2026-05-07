// drizzle-kit 設定。schema 変更検出 + migration SQL 生成に使う。
//
// dialect: sqlite。Cloudflare D1 は SQLite 互換。runtime driver は drizzle-orm/d1
// だが、drizzle-kit generate は dialect 単位で動くので "sqlite" を指定する。
//
// driver: 未指定。drizzle-kit generate (= migration SQL 生成) には driver 不要。
// drizzle-kit push / migrate (= 直接 DB に流す) を使うなら d1-http driver +
// CLOUDFLARE_* 環境変数を入れる必要があるが、本 project は wrangler 経由で
// `wrangler d1 migrations apply` する流儀 (= 旧来の Workers パターン) に倒すので
// driver なしで OK。
//
// out: drizzle/。wrangler.toml の `migrations_dir = "drizzle"` と一致。

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
});
