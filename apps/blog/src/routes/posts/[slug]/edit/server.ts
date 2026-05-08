// dogfood Form 第 2 周目 (2026-05-08): edit page。
// 同 path co-location pattern (= POST /posts/[slug]/edit で受けて redirect)。
//
// 痛み点観察 — async server component が loader を「不要化」したと思っていたが、
// **client-side reactive (= submission().fieldError) を使う form では loader が必要**。
// signal/computed/effect は `.server.tsx` で焼き付け不可 (ADR 0058) なので、prefill
// data + client side fieldError を両立するには `.tsx` (sync, hydrate-able) で
// `loaderData()` を読む Remix 原型に戻る。結果として server.ts に loader + action
// 両方並ぶので、痛み点 2 (action 1 個のために server.ts) は **edit page に限っては
// 解消する**。read-only async render (= /posts list, /posts/[slug] detail) と
// form-with-fieldError では最適 pattern が分かれる、という発見。

import { db } from "../../../../data/posts";
import type { Route } from "./+types";

export async function loader({ params }: Route.LoaderArgs) {
  const post = await db.postBySlug(params.slug);
  if (!post) {
    throw new Response("Not found", { status: 404 });
  }
  return { post };
}

export async function action({ request, params }: Route.ActionArgs) {
  const fd = await request.formData();
  const title = String(fd.get("title") ?? "").trim();
  const body = String(fd.get("body") ?? "").trim();

  const fields: Record<string, string> = {};
  if (!title) fields.title = "title is required";
  if (!body) fields.body = "body is required";
  if (Object.keys(fields).length > 0) {
    throw new Response(JSON.stringify({ fields }), {
      status: 422,
      headers: { "content-type": "application/json" },
    });
  }

  await db.updatePost(params.slug, { title, body });
  return Response.redirect(new URL(`/posts/${params.slug}`, request.url), 303);
}
