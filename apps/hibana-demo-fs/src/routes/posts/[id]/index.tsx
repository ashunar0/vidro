// GET /posts/:id の handler。`[id]/index.tsx` 形式 (= directory + index、user 指定形式)。
// `[id].tsx` 単体形式も Vite plugin が両対応 (= filename → URL pattern 変換時に [id] → :id)。

import type { Metadata } from "@vidro/hibana";
import { createRoute } from "@vidro/hibana/fs";
import { getPost } from "../../../domains/posts/service.ts";
import { PostDetailPage } from "../../../pages/PostDetailPage.tsx";

export const metadata: Metadata = {
  title: "Post Detail — Hibana Demo FS",
  description: "個別 post の表示画面。static metadata の dogfood (= filesystem-based 版)。",
};

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
