// posts route の server-only helper hub (= db re-export)。
//
// 履歴 (= ADR 0073 着地後):
//   - 旧 (61st、ADR 0072 第 4 周目): updatePost / deletePost を本 file に集約していた
//     (= F1 = validator middleware × URL 動的 segment 共存不可、構造的回避)
//   - 新 (ADR 0073 第 5 周目): F1 が validator slot で構造解決、updatePost /
//     deletePost は `[slug]/edit/server.ts` / `[slug]/delete/server.ts` に co-location
//     復活
//
// 本 file は **route helper hub** として残る:
//   - posts/index.server.tsx の一覧 page が `db.postsAsync()` を await
//   - posts/[slug]/index.server.tsx の詳細 page が `db.postBySlug(slug)` を await
//   - posts/[slug]/edit/index.server.tsx の prefill が `db.postBySlug(slug)` を await
//   - edit-form.tsx の island が `Post` 型 import
//
// `db` 自体は data layer (= apps/blog/src/data/posts.ts)、本 file は薄い re-export。
// 将来「server.ts は同 dir route で参照される server-only logic 専用」という convention
// を強める場合は、re-export hub をやめて各 page で直 `from "../data/posts"` する案も
// あり (= dogfood 第 5 周目以降に再考)。

export { db } from "../../data/posts";
export type { Post } from "../../data/posts";
