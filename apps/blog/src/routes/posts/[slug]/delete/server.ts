// dogfood Form 第 3 周目 (2026-05-09): resource route 復活 (= ADR 0068 痛み点 6 解消)。
//
// 第 2 周目では `compileRoutes` の filter (= `index.{tsx,server.tsx}` 必須) で
// resource route が認識されず 405 になっていたため、`posts/[slug]/server.ts` の
// 同 path co-location に倒していた。ADR 0068 で handleAction の candidates 構築を
// 拡張した結果、`server.ts` 単独 directory が POST だけ受ける REST 自然な形で
// 動くようになった。
//
// 効果:
// - delete action が `/posts/:slug/delete` という意図通りの URL で受けられる
//   (= 一覧 form の `<form action={\`/posts/${slug}/delete\`}>` がそのまま動く)
// - `posts/[slug]` directory は page (`.server.tsx`) のみで loader/action 不在、
//   `posts/[slug]/server.ts` を撤去できる (= 痛み点 2 と整合する形で 1 ファイル削減)

import { db } from "../../../../data/posts";
import type { Route } from "./+types";

/**
 * POST /posts/[slug]/delete → 該当記事を削除して /posts に 303 redirect。
 * resource route なので GET は 404 (= 機構の既存 not-found fallback)。
 */
export async function action({ request, params }: Route.ActionArgs) {
  const deleted = await db.deletePost(params.slug);
  if (!deleted) {
    throw new Response("Not found", { status: 404 });
  }
  return Response.redirect(new URL("/posts", request.url), 303);
}
