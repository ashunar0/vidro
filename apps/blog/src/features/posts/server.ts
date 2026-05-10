// dogfood 第 7 周目 (2026-05-10): feature-based 切り分け。
//
// 旧 (第 6 周目): routes 各 dir (new / [slug]/edit / [slug]/delete) に server.ts を
// 配置、各々で serverFn 本体を持つ。
// 新 (第 7 周目): write 系 serverFn 本体を本 file に集約、routes 側は 1 行
// re-export だけ持つ wire boundary に縮める。
//
// wire 規約は依然 router の compileRoutes (= routes/ scan) で決まる:
//   - routes/posts/new/server.ts          -> POST /posts/new/createPost
//   - routes/posts/[slug]/edit/server.ts  -> POST /posts/[slug]/edit/updatePost
//   - routes/posts/[slug]/delete/server.ts -> POST /posts/[slug]/delete/deletePost
//
// 本 file の serverFn は **配置に依存しない**: plugin の transform は callee 名で
// stub を作るので、import 元 module path は wire path に影響しない。だから
// routes/ から re-export すれば wire は成立、features/ 配下に置いても問題なし。
//
// 関連 ADR: 0073 (= serverFn object slot)、0068 (= action placement)。

import { serverFn } from "@vidro/router";
import { db } from "../../data/posts";
import { postContentSchema, slugParamsSchema } from "./schema";

export const createPost = serverFn({
  validator: { data: postContentSchema },
  handler: async ({ data }) => {
    const post = await db.createPost(data);
    return { slug: post.slug };
  },
});

export const updatePost = serverFn({
  validator: { params: slugParamsSchema, data: postContentSchema },
  handler: async ({ params, data }) => {
    const updated = await db.updatePost(params.slug, data);
    if (!updated) {
      // 存在しない slug への update は 404 Response throw (= server entry が
      // catch して wire に流す経路、ADR 0070)。
      throw new Response("Not found", { status: 404 });
    }
    return { slug: updated.slug };
  },
});

export const deletePost = serverFn({
  validator: { params: slugParamsSchema },
  handler: async ({ params }) => {
    const deleted = await db.deletePost(params.slug);
    if (!deleted) {
      throw new Response("Not found", { status: 404 });
    }
    return { ok: true as const };
  },
});
