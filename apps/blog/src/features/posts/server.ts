// dogfood 第 8 周目 (2026-05-10): read 系も serverFn 化。
//
// 旧 (第 7 周目): write 系 (create/update/delete) のみ serverFn 化、read は
// routes/.server.tsx から `await db.postsAsync()` 直叩き。
// 新 (第 8 周目): read 系 (listPosts / getPost) も serverFn 化、page は
// `await listPosts()` のように feature API のみで data 取得。db 直叩きを
// apps 配下から排除 (= memory `project_layer_separation_principle` の
// 「Next.js 的 db.x() 直叩きは Vidro anti-pattern」と整合)。
//
// SSR (= server component 内) で `await listPosts()` した時、HTTP loopback は
// 発生しない: server-boundary plugin は client bundle pass でのみ stub に
// 差し替えるため、server build / dev SSR では internalForm が直 invoke される。
// client side (island) からも `/features/posts/listPosts` で fetch 可能、
// read endpoint としても副産物で出る (auth は handler 内で必要なら追加)。
//
// 戻り値の null 扱いの asymmetry:
//   - write 系 (updatePost / deletePost): 存在しない slug → 404 throw (= client
//     state と DB の divergence、recover できないので 404)
//   - read 系 (getPost): null をそのまま return (= URL ミス想定、page 側で
//     「Post not found」UI を出す方が user-friendly、UX 維持)
//
// 関連 ADR: 0073 (= serverFn object slot)、0066 (= async server component native)。

import { serverFn } from "@vidro/router";
import { db } from "../../data/posts";
import { postContentSchema, slugParamsSchema } from "./schema";

export const listPosts = serverFn({
  handler: async () => {
    return db.postsAsync();
  },
});

export const getPost = serverFn({
  validator: { params: slugParamsSchema },
  handler: async ({ params }) => {
    return db.postBySlug(params.slug);
  },
});

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
