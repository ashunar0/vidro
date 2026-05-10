// dogfood 第 4 周目 (2026-05-10、61st session): edit page も Path 4 に移行。
//
// 旧 (= ADR 0068 action 経路):
//   - server.ts に loader (prefill) + action (formData parse) 両方
//   - index.tsx で loaderData() + submission() (= Remix mode)
// 新 (= Path 4 + validator):
//   - prefill は async server component で `await db.postBySlug(slug)` 直書き
//   - form は edit-form.tsx の island、`await updatePost({slug, title, body})` 呼び出し
//   - server function は ../../server.ts に集約 (= URL [slug] と validator の衝突回避)
//
// 痛み点新規発見: validator middleware が `next([parsed.data])` で args 全 override
// するため URL 動的 segment と共存できず、serverFn を [slug] dir の上に動かす羽目に。
// 詳細は ../../server.ts の comment + memory `project_validator_multi_arg_blocker` 候補。

import { db } from "../../server";
import type { Route } from "./+types";
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
