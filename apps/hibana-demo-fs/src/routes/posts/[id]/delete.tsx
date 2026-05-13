// POST /posts/:id/delete = delete + /posts へ redirect。
// HTML form の method は POST のみなので、DELETE method ではなく POST + 別 path で表現する (= Rails 流)。
// default export 無し file (= POST named export のみ) は @vidro/hibana/fs vite plugin が許容する形に改修済 (第 25 周目 dogfood)。

import { createRoute } from "@vidro/hibana/fs";
import { deletePost } from "../../../domains/posts/service.ts";

export const POST = createRoute((c) => {
  const id = c.req.param("id")!;
  if (!deletePost(id)) return c.notFound();
  return c.redirect("/posts");
});
