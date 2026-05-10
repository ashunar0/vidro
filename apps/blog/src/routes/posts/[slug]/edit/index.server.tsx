// dogfood 第 4 周目 (2026-05-10、61st session): edit page も Path 4 に移行。
// dogfood 第 7 周目 (2026-05-10): db は data/posts.ts を直 import (= routes/posts/server.ts hub 撤去)。
//
// 旧 (= ADR 0068 action 経路):
//   - server.ts に loader (prefill) + action (formData parse) 両方
//   - index.tsx で loaderData() + submission() (= Remix mode)
// 中継 (= Path 4 + validator):
//   - prefill は async server component で `await db.postBySlug(slug)` 直書き
//   - form は edit-form.tsx の island、`await updatePost({slug, title, body})` 呼び出し
//   - server function は ../../server.ts (= db re-export hub 経由) に集約
// 新 (= 65th 後半):
//   - routes/posts/server.ts (= db re-export hub) を撤去、db は data/posts.ts を直 import
//   - server function は features/posts/server.ts に集約 (= features 化、commit 48f039c)
//   - re-export 用 routes/<dir>/server.ts も撤去 (= commit 871f5e5)

import type { Route } from "./+types";
import { db } from "../../../../data/posts";
import { EditPostForm } from "./edit-form";

export default async function EditPost({ params }: Route.PageProps) {
  const post = await db.postBySlug(params.slug);
  if (!post) {
    // SSR 段階で 404 throw。server entry が catch して 4xx response に流す経路。
    throw new Response("Not found", { status: 404 });
  }

  return (
    <section>
      <h2 class="text-xl font-semibold">Edit post</h2>
      <p class="mt-1 text-xs text-gray-500">slug: {post.slug}</p>
      <EditPostForm post={post} />
    </section>
  );
}
