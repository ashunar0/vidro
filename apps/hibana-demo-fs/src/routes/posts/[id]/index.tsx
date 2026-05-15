// GET /posts/:id = detail、POST /posts/:id = update (= named export)。
// `[id]/index.tsx` 形式 (= directory + index、user 指定形式)。

import type { Metadata } from "@vidro/hibana";
import { createRoute } from "@vidro/hibana/fs";
import { fieldsFromZodError } from "@vidro/zod";
import { getPost, updatePost } from "../../../domains/posts/service.ts";
import { postInputSchema } from "../../../domains/posts/schema.ts";
import { PostDetailPage } from "../../../pages/PostDetailPage.tsx";
import PostEditPage from "../../../pages/PostEditPage.tsx";

// 第 27 周目 (= ADR 0083、F6 解消): inline 重複を `@vidro/zod` の sibling 共用 helper に置換。

export const metadata: Metadata = {
  title: "Post Detail — Hibana Demo FS",
  description: "個別 post の表示画面。static metadata の dogfood (= filesystem-based 版)。",
};

// GET /posts/:id = detail
export default createRoute((c) => {
  // filesystem-based 版では Hono の chain 型推論が切れて `c.req.param("id")` が
  // `string | undefined` になる (= app.get("/posts/:id", ...) で path リテラル経由 narrow
  // ができない構造)。route file の path 自体が `/posts/[id]/index.tsx` で `id` 必須なので、
  // この handler に到達した時点で id は string 保証 → non-null assertion で OK。
  // handler-based 版 (= apps/hibana-demo) では chain で narrow されるため `!` 不要。
  // この差は ADR 0080 比較軸の「型貫通」項目で記録予定。
  const post = getPost(c.req.param("id")!);
  if (!post) return c.notFound();
  return c.render(PostDetailPage, { post });
});

// POST /posts/:id = update
export const POST = createRoute(async (c) => {
  const id = c.req.param("id")!;
  const existing = getPost(id);
  if (!existing) return c.notFound();
  const form = await c.req.formData();
  const raw = {
    title: form.get("title")?.toString() ?? "",
    excerpt: form.get("excerpt")?.toString() ?? "",
  };
  const result = postInputSchema.safeParse(raw);
  if (!result.success) {
    return c.render(PostEditPage, {
      post: existing,
      values: raw,
      errors: fieldsFromZodError(result.error),
    });
  }
  updatePost(id, result.data);
  return c.redirect(`/posts/${id}`);
});
