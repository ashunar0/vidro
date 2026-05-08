// dogfood Form 議論 (2026-05-08): `/posts/new` 同 path co-location action。
// 痛み点記録: action 1 個のためだけに server.ts を増やしている (= async server
// component で page が `index.tsx` 1 ファイルで完結するのに、action だけが別
// ファイルに残る co-location 違反感)。これは Vidro 設計上の論点として ADR 起票
// 候補 (= action 置き場の 3 mode 整理: co-located action / resource route /
// 同 path action)。
//
// なぜ POST /posts ではなく POST /posts/new で受けるか:
// - `submission()` が `defaultPathname()` (= 現 page path) で per-route slot を引く
// - cross-route な form action ("/posts") に submit すると、 /posts/new で
//   `submission().fieldError` を読んでも /posts slot 側に書かれていて拾えない
//   (= 痛み点 1 として記録、submission() の cross-route 解決 API 拡張要)
// - 同 path co-location (= Remix `<Form>` default) なら slot 整合 + validation
//   error 時に form がそのまま残る UX が成立する

import { db } from "../../../data/posts";
import type { Route } from "./+types";

export async function action({ request }: Route.ActionArgs) {
  const fd = await request.formData();
  const title = String(fd.get("title") ?? "").trim();
  const body = String(fd.get("body") ?? "").trim();

  // ADR 0059: validation error は `{ fields }` で 422 throw、`sub.fieldError` に流れる。
  const fields: Record<string, string> = {};
  if (!title) fields.title = "title is required";
  if (!body) fields.body = "body is required";
  if (Object.keys(fields).length > 0) {
    throw new Response(JSON.stringify({ fields }), {
      status: 422,
      headers: { "content-type": "application/json" },
    });
  }

  const post = await db.createPost({ title, body });
  // 成功 → 詳細 page に 303 redirect (POST/Redirect/GET pattern、F5 再 POST 防止)
  return Response.redirect(new URL(`/posts/${post.slug}`, request.url), 303);
}
