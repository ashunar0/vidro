// GET /posts の handler。route file 側に metadata + handler、page は別 file。
//
// 解 a (= 第 21 周目): route file 側 `export const metadata` を c.render 時に attach。
// 機構は @vidro/hibana/fs の createFsApp の wrapper が c.var.hibanaRouteMetadata に積み、
// hibana() middleware の renderer がここを優先して読む (= ADR 0079 Component.metadata より優先)。

import type { MetadataFn } from "@vidro/hibana";
import { createRoute } from "@vidro/hibana/fs";
import { fieldsFromZodError } from "@vidro/zod";
import type { Post } from "../../domains/posts/schema.ts";
import { postInputSchema } from "../../domains/posts/schema.ts";
import { createPost, getPosts } from "../../domains/posts/service.ts";
import { PostListPage } from "../../pages/PostListPage.tsx";
import PostNewPage from "../../pages/PostNewPage.tsx";

// 第 27 周目 (= ADR 0083、F6 解消): inline 重複を `@vidro/zod` の sibling 共用 helper に置換。

export const metadata: MetadataFn<{ posts: Post[] }> = ({ posts }) => ({
  title: `Posts (${posts.length})`,
  description: "Hibana demo (fs) の posts 一覧。ADR 0080 候補の filesystem-based dogfood。",
  meta: [{ property: "og:title", content: `Posts (${posts.length})` }],
  link: [{ rel: "canonical", href: "/posts" }],
});

// GET /posts = posts 一覧
export default createRoute((c) => {
  const posts = getPosts();
  return c.render(PostListPage, { posts });
});

// POST /posts = create
// filesystem-based 版は named export で method 別 handler を表現する (= packages/hibana fs.ts + vite.ts 改修済)。
// 失敗時の同 page 再 render は c.render(PostNewPage, {...}) を使う = route と page が 1:1 でなく、handler の自由度で page を選べる。
export const POST = createRoute(async (c) => {
  const form = await c.req.formData();
  const raw = {
    title: form.get("title")?.toString() ?? "",
    excerpt: form.get("excerpt")?.toString() ?? "",
  };
  const result = postInputSchema.safeParse(raw);
  if (!result.success) {
    return c.render(PostNewPage, {
      values: raw,
      errors: fieldsFromZodError(result.error),
    });
  }
  const post = createPost(result.data);
  return c.redirect(`/posts/${post.id}`);
});
