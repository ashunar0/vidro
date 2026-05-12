// GET /posts の handler。route file 側に metadata + handler、page は別 file。
//
// 解 a (= 第 21 周目): route file 側 `export const metadata` を c.render 時に attach。
// 機構は @vidro/hibana/fs の createFsApp の wrapper が c.var.hibanaRouteMetadata に積み、
// hibana() middleware の renderer がここを優先して読む (= ADR 0079 Component.metadata より優先)。

import type { MetadataFn } from "@vidro/hibana";
import { createRoute } from "@vidro/hibana/fs";
import type { Post } from "../../../src/domains/posts/schema.ts";
import { getPosts } from "../../../src/domains/posts/service.ts";
import { PostListPage } from "../../../src/pages/PostListPage.tsx";

export const metadata: MetadataFn<{ posts: Post[] }> = ({ posts }) => ({
  title: `Posts (${posts.length})`,
  description: "Hibana demo (fs) の posts 一覧。ADR 0080 候補の filesystem-based dogfood。",
  meta: [{ property: "og:title", content: `Posts (${posts.length})` }],
  link: [{ rel: "canonical", href: "/posts" }],
});

export default createRoute((c) => {
  const posts = getPosts();
  return c.render(PostListPage, { posts });
});
