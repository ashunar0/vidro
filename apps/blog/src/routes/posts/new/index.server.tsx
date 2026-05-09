// dogfood Phase 7 (Phase 2c 実証): AppRouter mode page shell。
//
// action は ./server.ts の `createPost` serverFn に移行 (ADR 0070 Phase 2c)。
// 本 file は default export (= page component) のみの薄い shell に戻る。
// island form (post-form.tsx) が `import { createPost } from "./server"` で
// stub 化された fetch を呼ぶ経路。

import { PostForm } from "./post-form";
import type { Route } from "./+types";

export default function NewPost(_: Route.PageProps) {
  return (
    <section>
      <h2 class="text-xl font-semibold">New post</h2>
      <PostForm />
    </section>
  );
}
