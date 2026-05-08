// dogfood Form 第 3 周目: AppRouter mode (= `.server.tsx` shell + island form)
// + ADR 0068 同 path co-location action。
//
// 痛み点 2 (= action 1 個のために server.ts) は、ADR 0068 で `index.server.tsx` の
// `action` named export を router が拾うようになったため解消。本ファイル 1 つで
// shell + action + island 設置が完結する (= 第 1 周目の `index.tsx + server.ts` の
// 2 ファイルから 1 ファイル化)。
//
// island form は client schema (zod) で validation するが、server を信用しない
// 原則どおり同じ schema で再 validate する。`@vidro/form` の formControl と同形の
// shape で 422 を返せば PostForm が `setFieldErrors` で field error に流せる。

import { z } from "zod";
import { db } from "../../../data/posts";
import { PostForm } from "./post-form";
import type { Route } from "./+types";

const inputSchema = z.object({
  title: z.string().min(1, "title is required"),
  body: z.string().min(1, "body is required"),
});

export default function NewPost(_: Route.PageProps) {
  return (
    <section>
      <h2 class="text-xl font-semibold">New post</h2>
      <PostForm />
    </section>
  );
}

/**
 * POST /posts/new — ADR 0068 同 path co-location。`index.server.tsx` 内に action
 * export を置くと router の handleAction が candidates に積んで呼んでくれる。
 *
 * island form (PostForm) は JSON body で投げるので `request.json()` で読む。
 * validation 通れば `{ slug }` を JSON で返す (= island 側で受けて navigate)、
 * fail なら 422 + `{ fields }` で formControl.setFieldErrors に流す。
 */
export async function action({ request }: Route.ActionArgs) {
  const raw = (await request.json()) as unknown;
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path[0];
      if (typeof path === "string" && !(path in fields)) fields[path] = issue.message;
    }
    throw new Response(JSON.stringify({ fields }), {
      status: 422,
      headers: { "content-type": "application/json" },
    });
  }
  const post = await db.createPost(parsed.data);
  return { slug: post.slug };
}
