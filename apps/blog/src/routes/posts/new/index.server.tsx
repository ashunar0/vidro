// dogfood Phase 7 (Phase 2c 実証): AppRouter mode page shell。
//
// action 本体は features/posts/server.ts の `createPost` serverFn (= 65th 第 7 周目で features 化)。
// 本 file は default export (= page component) のみの薄い shell。
// island form (post-form.tsx) が `import { createPost } from "../../../features/posts/server"`
// で stub 化された fetch を呼ぶ経路。

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
