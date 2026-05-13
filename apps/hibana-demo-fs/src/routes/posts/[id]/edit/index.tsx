// GET /posts/:id/edit = edit form を post の現在値で初期描画。
// POST /posts/:id (= update) は ../index.tsx の `export const POST` 側にある。

import type { Metadata } from "@vidro/hibana";
import { createRoute } from "@vidro/hibana/fs";
import { getPost } from "../../../../domains/posts/service.ts";
import PostEditPage from "../../../../pages/PostEditPage.tsx";

export const metadata: Metadata = {
  title: "Edit Post",
  description: "post の編集 form。",
};

export default createRoute((c) => {
  const post = getPost(c.req.param("id")!);
  if (!post) return c.notFound();
  return c.render(PostEditPage, { post });
});
