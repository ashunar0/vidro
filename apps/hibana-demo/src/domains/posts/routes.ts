// domain ごとの Hono sub-router。app.ts から `.route("/posts", postsRoutes)` で mount される。
// 設計書「ルートに縛り付けられるのは logic だけ。UI は domain で組織する」を体現:
//   - route は handler 登録の場所
//   - UI component (= PostListPage) は同 domain 内の任意の場所に配置できる
//
// Phase 1 Step 1 minimum: GET /posts だけ。後続 Step で /posts/:id 等を追加。

import { Hono } from "hono";
import PostListPage from "./pages/PostListPage.tsx";
import PostDetailPage from "./pages/PostDetailPage.tsx";
import { getPost, getPosts } from "./service.ts";

export const postsRoutes = new Hono();

postsRoutes.get("/", (c) => {
  const posts = getPosts();
  return c.render(PostListPage, { posts });
});

postsRoutes.get("/:id", (c) => {
  const post = getPost(c.req.param("id"));
  if (!post) return c.notFound();
  return c.render(PostDetailPage, { post });
});
