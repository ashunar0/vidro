// domain ごとの Hono sub-router。app.ts から `.route("/posts", postsRoutes)` で mount される。
// 設計書「ルートに縛り付けられるのは logic だけ。UI は domain で組織する」を体現:
//   - route は handler 登録の場所
//   - UI component (= PostListPage) は同 domain 内の任意の場所に配置できる
//
// CRUD dogfood (第 25 周目): create / update / delete を server-only で実装、validation は zod safeParse、
// 失敗時は同 page を values + errors 込みで再 render、成功時は redirect (= Rails 流 / "Pure server" 案 A)。

import { Hono } from "hono";
import type { z } from "zod";
import { hibanaLayout } from "@vidro/hibana";
import PostListPage from "./pages/PostListPage.tsx";
import PostDetailPage from "./pages/PostDetailPage.tsx";
import PostNewPage from "./pages/PostNewPage.tsx";
import PostEditPage from "./pages/PostEditPage.tsx";
import { PostsLayout } from "./layouts/PostsLayout.tsx";
import { createPost, deletePost, getPost, getPosts, updatePost } from "./service.ts";
import { postInputSchema } from "./schema.ts";

// zod ZodError → form field name → message map に変換する素朴 helper。
// 同 field に複数 issue が来た場合は最初の 1 件のみ採用 (= 表示も 1 field 1 行で十分)。
// Hibana に validation helper が無いので route file ごとに inline で書く形 = dogfood で痛みになったら util / pack に retreat。
const fieldsFromZodError = (err: z.ZodError): Record<string, string> => {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && !(key in fields)) fields[key] = issue.message;
  }
  return fields;
};

// chain 形式で書く理由 (= Hono の TS 型 inference 要件):
//   - `c.req.param("id")` の path param 型を narrow するため
//   - 将来 hc<typeof postsRoutes> で RPC client 型接続するため
//   - middleware を `.use(...)` で chain に組み込むと c.var の型流入が handler に届くため
// 文として分けると Hono の builder pattern が型を引き継げず inference が切れる。
//
// `.use("*", hibanaLayout(PostsLayout))` で /posts/* 配下に scoped layout を追加。
// app.ts 側で AppLayout が先に push されてるので、stack = [AppLayout, PostsLayout] となり、
// renderer は <AppLayout><PostsLayout><Page/></PostsLayout></AppLayout> に組む。
//
// route 順序: `/new` を `/:id` より前に書く (= Hono は登録順マッチ、後置だと `:id` に吸われる)。
export const postsRoutes = new Hono()
  .use("*", hibanaLayout(PostsLayout))
  .get("/", (c) => {
    const posts = getPosts();
    return c.render(PostListPage, { posts });
  })
  .get("/new", (c) => c.render(PostNewPage, {}))
  .post("/", async (c) => {
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
  })
  .get("/:id/edit", (c) => {
    const post = getPost(c.req.param("id"));
    if (!post) return c.notFound();
    return c.render(PostEditPage, { post });
  })
  .post("/:id/delete", (c) => {
    const id = c.req.param("id");
    if (!deletePost(id)) return c.notFound();
    return c.redirect("/posts");
  })
  .post("/:id", async (c) => {
    const id = c.req.param("id");
    const existing = getPost(id);
    if (!existing) return c.notFound();
    const form = await c.req.formData();
    const raw = {
      title: form.get("title")?.toString() ?? "",
      excerpt: form.get("excerpt")?.toString() ?? "",
    };
    const result = postInputSchema.safeParse(raw);
    if (!result.success) {
      return c.render(PostEditPage, {
        post: existing,
        values: raw,
        errors: fieldsFromZodError(result.error),
      });
    }
    updatePost(id, result.data);
    return c.redirect(`/posts/${id}`);
  })
  .get("/:id", (c) => {
    const post = getPost(c.req.param("id"));
    if (!post) return c.notFound();
    return c.render(PostDetailPage, { post });
  });
