// dogfood 第 5 周目 (2026-05-10、ADR 0073): edit form island を object slot wire に migration。
//
// 構造的変化:
//   1. server.ts が **co-location 復活** (= `posts/[slug]/edit/server.ts`)、
//      import 元が `../../server` → `./server` に変わる
//   2. schema は **data slot 専用** (= `{ title, body }` のみ)、slug は URL params
//      経由なので schema からも defaultValues からも撤去
//   3. `<input type="hidden" {...f.field("slug")} />` 撤去 (= URL params で完結)
//   4. 呼出形: `await updatePost(data)` → `await updatePost({ params: { slug }, data })`
//
// formControl の data slot と wire の data slot が **同名で一貫**するのが ADR 0069 +
// ADR 0073 連動の利点 (= schema 共有経路は別 ADR、現状は file 内重複定義)。

import { formControl } from "@vidro/form";
import { navigate } from "@vidro/router";
import { ServerFnValidationError } from "@vidro/router/client";
import { z } from "zod";
import type { Post } from "../../server";
import { updatePost } from "./server";

// data slot 用 schema (= title + body)。slug は URL params 経由なので含めない。
const schema = z.object({
  title: z.string().min(1, "title is required"),
  body: z.string().min(1, "body is required"),
});

export function EditPostForm({ post }: { post: Post }) {
  // formControl は data slot 用、defaultValues も title + body のみ。
  // hydrate 後に signal が空文字で DOM を上書きする問題を defaultValues で回避
  // (= ADR 0069 + 第 4 周目発見の経路)。
  const f = formControl({
    schema,
    defaultValues: { title: post.title, body: post.body },
  });

  const handleSubmit = async (data: z.infer<typeof schema>): Promise<void> => {
    try {
      // ADR 0073: params slot に URL 識別子 (slug)、data slot に form payload。
      const { slug } = await updatePost({ params: { slug: post.slug }, data });
      navigate(`/posts/${slug}`);
    } catch (err) {
      if (err instanceof ServerFnValidationError) {
        f.setFieldErrors(err.fields);
        return;
      }
      throw err;
    }
  };

  // post-form.tsx と同じ理由で `data-vidro-no-intercept` で router の form delegation
  // を bypass する (= ADR 0051 capture submit と二重 POST 衝突回避)。
  return (
    <form onSubmit={f.bind(handleSubmit)} data-vidro-no-intercept class="mt-4 space-y-4">
      <div>
        <label class="block text-sm font-medium" for="title">
          Title
        </label>
        <input
          id="title"
          type="text"
          {...f.field("title")}
          class="mt-1 w-full rounded border border-gray-300 px-3 py-2"
        />
        {f.error("title").value && (
          <p class="mt-1 text-sm text-red-600">{f.error("title").value}</p>
        )}
      </div>

      <div>
        <label class="block text-sm font-medium" for="body">
          Body
        </label>
        <textarea
          id="body"
          rows={6}
          {...f.field("body")}
          class="mt-1 w-full rounded border border-gray-300 px-3 py-2"
        />
        {f.error("body").value && <p class="mt-1 text-sm text-red-600">{f.error("body").value}</p>}
      </div>

      <button
        type="submit"
        disabled={() => f.pending.value}
        class="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {f.pending.value ? "Saving..." : "Save changes"}
      </button>
    </form>
  );
}
