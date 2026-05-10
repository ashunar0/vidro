// ADR 0058 + 0060 流儀: `.server.tsx` (component) と `server.ts` (logic) の責務分離。
// 本 server.ts は `.server.tsx` から直 import される server-only helper の re-export と、
// 動的 segment より上に置きたい server function (= updatePost / deletePost) を兼ねる。
//
// dogfood discovery (= 2026-05-10、61st session): validator middleware は
// `next([parsed.data])` で args 全 override する設計のため、URL 動的 segment と
// 共存できない。`/posts/[slug]/edit/server.ts` 配下に updatePost を置くと URL
// `[slug]` 引数と body 引数の二重渡しが必要、冷静に醜い。よって serverFn を
// `[slug]` の一つ上 (= ここ) に移し、slug を input schema に含める形にした。
// URL は `/posts/updatePost` / `/posts/deletePost` で動的 segment 不在、validator
// が body 全体を parse → handler は `(input)` 1 引数で受ける。
//
// trade-off: createPost は `posts/new/server.ts` で update/delete は `posts/server.ts`
// と位置不揃いになる。「server function は API endpoint であって page route と 1:1
// である必要はない」という Path 4 本来の哲学に沿うので、不揃いは ok と判断。

import { serverFn } from "@vidro/router";
import { validator } from "@vidro/zod";
import { z } from "zod";
import { db } from "../../data/posts";

export { db } from "../../data/posts";
export type { Post } from "../../data/posts";

// update 用 schema: slug を含めて 1 input にまとめる。slug は URL identifier
// として variable、title/body は実 column に流す。
const updateSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1, "title is required"),
  body: z.string().min(1, "body is required"),
});

export const updatePost = serverFn(
  validator(updateSchema),
  async (input: z.infer<typeof updateSchema>) => {
    const updated = await db.updatePost(input.slug, { title: input.title, body: input.body });
    if (!updated) {
      // 存在しない slug への update は 404 Response throw (= server entry が catch
      // して wire に流す経路、ADR 0070)。stub 側は !ok で plain Error に降りる。
      throw new Response("Not found", { status: 404 });
    }
    return { slug: updated.slug };
  },
);

// delete 用 schema: slug 1 個だけ。validator を通す意義は薄い (= 必須 check 程度)
// が、Path 4 統一感のため同 pattern で書く。空 string ガードだけは効く。
const deleteSchema = z.object({
  slug: z.string().min(1),
});

export const deletePost = serverFn(
  validator(deleteSchema),
  async (input: z.infer<typeof deleteSchema>) => {
    const deleted = await db.deletePost(input.slug);
    if (!deleted) {
      throw new Response("Not found", { status: 404 });
    }
    return { ok: true as const };
  },
);
