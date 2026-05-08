// dogfood Form 第 2 周目: 詳細 page (`/posts/[slug]`) の同 path action。
//
// 痛み点 6 で発見: Vidro の compileRoutes は `index.{tsx,server.tsx}` を必須に
// しているため、`/posts/[slug]/delete/server.ts` 単独 (= resource route) では
// route として認識されず 405 Method Not Allowed になる。回避策として、詳細
// page (`index.server.tsx`) の同階層に action だけの server.ts を置く形に倒す。
//
// **これが痛み点 2 (action 1 個のために server.ts) の典型再現**:
// - `/posts/[slug]/index.server.tsx` (= async server component、page 1 ファイル完結)
// - `/posts/[slug]/server.ts` (= action 1 関数のため、本ファイル)
// loader が消えた今、この 5 行のために専用 .ts ファイルが必要なのが co-location 違反感。

import { db } from "../../../data/posts";
import type { Route } from "./+types";

/**
 * POST /posts/[slug] → 詳細 page 経路の delete action。
 * 一覧 page (`/posts`) の各 row 内 `<form method="post" action={\`/posts/${slug}\`}>` から呼ばれる。
 * 成功 → 303 redirect で /posts に戻す。
 */
export async function action({ request, params }: Route.ActionArgs) {
  const deleted = await db.deletePost(params.slug);
  if (!deleted) {
    throw new Response("Not found", { status: 404 });
  }
  return Response.redirect(new URL("/posts", request.url), 303);
}
