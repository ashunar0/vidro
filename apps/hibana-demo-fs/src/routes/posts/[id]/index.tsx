// GET /posts/:id = detail、POST /posts/:id = update (= named export)。
// `[id]/index.tsx` 形式 (= directory + index、user 指定形式)。

import type { Metadata } from "@vidro/hibana";
import { createRoute } from "@vidro/hibana/fs";
import type { z } from "zod";
import { getPost, updatePost } from "../../../domains/posts/service.ts";
import { postInputSchema } from "../../../domains/posts/schema.ts";
import { PostDetailPage } from "../../../pages/PostDetailPage.tsx";
import PostEditPage from "../../../pages/PostEditPage.tsx";

// inline 重複: handler-based 版 routes.ts + posts/index.tsx (= POST /posts) と同 logic。
// Hibana validation helper が無いので route file ごとに同 logic を書く形 = dogfood F2 として memorize 予定。
const fieldsFromZodError = (err: z.ZodError): Record<string, string> => {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && !(key in fields)) fields[key] = issue.message;
  }
  return fields;
};

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
