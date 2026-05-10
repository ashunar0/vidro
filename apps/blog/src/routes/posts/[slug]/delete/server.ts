// dogfood 第 5 周目 (2026-05-10、ADR 0073): deletePost を `[slug]/delete/` に
// **co-location 復活** + ADR 0068 の resource route (= server.ts 単独 dir 認識) を活用。
//
// 旧 (61st、ADR 0072): F1 回避で `posts/server.ts` に集約。slug を data schema に
// 詰めて handler 第 1 引数で受ける形、URL は `/posts/deletePost` (= dyn segment 不在)。
//
// 新 (ADR 0073): URL `[slug]` を params slot で受ける、URL は
// `/posts/[slug]/delete/deletePost` で本来の co-location 復活。data slot は不要
// (= 削除は params 1 個だけで済む)。
//
// design notes:
//   - `[slug]/delete/` は **`server.ts` のみ持つ resource route** (= ADR 0068)、
//     `index.server.tsx` 不在で OK。HTTP POST だけ accept される、GET は 404 (=
//     `routeTypes()` の boundary mapping で分岐)。
//   - delete-button.tsx (= row island) から `await deletePost({ params: { slug } })`
//     で呼ぶ、戻り値 `{ ok: true }` typed。
//
// 関連 ADR: 0073 = serverFn object slot、0068 = action placement + resource route。

import { serverFn } from "@vidro/router";
import { z } from "zod";
import { db } from "../../../../data/posts";

const paramsSchema = z.object({ slug: z.string().min(1) });

export const deletePost = serverFn({
  validator: { params: paramsSchema },
  handler: async ({ params }) => {
    const deleted = await db.deletePost(params.slug);
    if (!deleted) {
      throw new Response("Not found", { status: 404 });
    }
    return { ok: true as const };
  },
});
