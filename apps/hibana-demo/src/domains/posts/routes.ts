// domain ごとの Hono sub-router。app.ts から `.route("/posts", postsRoutes)` で mount される。
// 設計書「ルートに縛り付けられるのは logic だけ。UI は domain で組織する」を体現:
//   - route は handler 登録の場所
//   - UI component (= PostListPage) は同 domain 内の任意の場所に配置できる
//
// Phase 1 Step 1 minimum: GET /posts だけ。後続 Step で /posts/:id 等を追加。

import { Hono } from "hono";
import { hibanaLayout } from "@vidro/hibana";
import PostListPage from "./pages/PostListPage.tsx";
import PostDetailPage from "./pages/PostDetailPage.tsx";
import { PostsLayout } from "./layouts/PostsLayout.tsx";
import { getPost, getPosts } from "./service.ts";

// chain 形式で書く理由 (= Hono の TS 型 inference 要件):
//   - `c.req.param("id")` の path param 型を narrow するため
//   - 将来 hc<typeof postsRoutes> で RPC client 型接続するため
//   - middleware を `.use(...)` で chain に組み込むと c.var の型流入が handler に届くため
// 文として分けると Hono の builder pattern が型を引き継げず inference が切れる。
//
// `.use("*", hibanaLayout(PostsLayout))` で /posts/* 配下に scoped layout を追加。
// app.ts 側で AppLayout が先に push されてるので、stack = [AppLayout, PostsLayout] となり、
// renderer は <AppLayout><PostsLayout><Page/></PostsLayout></AppLayout> に組む。
export const postsRoutes = new Hono()
  .use("*", hibanaLayout(PostsLayout))
  .get("/", (c) => {
    const posts = getPosts();
    return c.render(PostListPage, { posts });
  })
  .get("/:id", (c) => {
    const post = getPost(c.req.param("id"));
    if (!post) return c.notFound();
    return c.render(PostDetailPage, { post });
  });
