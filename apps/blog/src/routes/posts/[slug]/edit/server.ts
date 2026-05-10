// dogfood 第 5 周目 (2026-05-10、ADR 0073): updatePost を `[slug]/edit/` に
// **co-location 復活**。
//
// 旧 (61st、ADR 0072 第 4 周目): F1 (= validator middleware × URL 動的 segment
// 共存不可) を回避するため updatePost を `posts/server.ts` に追い出し、slug を
// schema に詰める形に倒した。本来の co-location が崩れる構造的妥協。
//
// 新 (ADR 0073、流派 1 object slot): `validator: { params, data }` slot に
// 分離されたので、URL `[slug]` を params slot で受けて、body は data slot で
// 受ける形が共存可能になった。`[slug]/edit/` 配下に server function を戻せる。
//
// dogfood 観察:
//   - schema 分離: paramsSchema (= URL 識別子) + dataSchema (= form payload)
//   - handler は `({ params, data }) => ...` で純関数、c (HTTP) を知らない
//   - 404 は `throw new Response(..., { status: 404 })` で server entry が wire 化
//
// 関連 ADR: 0073 = serverFn signature object slot、0067 = +types codegen
// (= Route.PageProps の params 型源)、0068 = action placement (= 同 dir co-location)。

import { serverFn } from "@vidro/router";
import { z } from "zod";
import { db } from "../../../../data/posts";

const paramsSchema = z.object({ slug: z.string().min(1) });
const dataSchema = z.object({
  title: z.string().min(1, "title is required"),
  body: z.string().min(1, "body is required"),
});

export const updatePost = serverFn({
  validator: { params: paramsSchema, data: dataSchema },
  handler: async ({ params, data }) => {
    const updated = await db.updatePost(params.slug, data);
    if (!updated) {
      // 存在しない slug への update は 404 Response throw (= server entry が
      // catch して wire に流す経路、ADR 0070)。client stub 側は !ok で plain Error。
      throw new Response("Not found", { status: 404 });
    }
    return { slug: updated.slug };
  },
});
