// dogfood 第 11 周目 (2026-05-10、ADR 0076): try/catch boilerplate 撲滅。
//
// 旧 (第 5 周目〜第 10 周目): post-form と同じく handleSubmit に try/catch +
// ServerFnValidationError instanceof + setFieldErrors の 5 行 boilerplate。
// 新 (第 11 周目、ADR 0076): formControl が validation error を自動 catch するので
// try/catch も `@vidro/router/client` import も消える。
//
// 第 5 周目以前の構造的変化:
//   1. server.ts が **co-location 復活** (= `posts/[slug]/edit/server.ts`)、
//      import 元が `../../server` → `./server` に変わる
//   2. schema は **data slot 専用** (= `{ title, body }` のみ)、slug は URL params
//      経由なので schema からも defaultValues からも撤去
//   3. `<input type="hidden" {...f.field("slug")} />` 撤去 (= URL params で完結)
//   4. 呼出形: `await updatePost(data)` → `await updatePost({ params: { slug }, data })`
//   5. (第 6 周目) schema は ./schema.ts に切り出し、本 file の重複 z.object() 撤去
//   6. (第 7 周目) schema を features/posts/schema に移動、create/update で同 shape の
//      postContentSchema を共有 (= feature-based)。updatePost も features/posts/server から import
//
// formControl の data slot と wire の data slot が **同名で一貫**するのが ADR 0069 +
// ADR 0073 連動の利点。schema 共有 (= 第 6 周目) で「同じ z.object を 2 度書く」も解消。

import { formControl } from "@vidro/form";
import { navigate } from "@vidro/router";
import type { Post } from "../../../../data/posts";
import type { PostContentInput } from "../../../../features/posts/schema";
import { postContentSchema } from "../../../../features/posts/schema";
import { updatePost } from "../../../../features/posts/server";

export function EditPostForm({ post }: { post: Post }) {
  // formControl は data slot 用、defaultValues は post まるごと渡す
  // (第 12 周目で規約格上げ → 第 13 周目 ADR 0078 で型保証化)。
  // schema (= postContentSchema、title + body) は keyof T で限定された field のみ
  // pick して seed、Post 型の余計 field (id / slug / createdAt 等) は ADR 0078 の
  // ValidDefaults<T, D> 制約で「source ⟷ schema overlap が 1 個でもあれば許可」と
  // して明示的に通る (= title/body overlap で素通り、typo 単独や全 field rename は
  // build error 化されるので silent breakage 防止)。
  // hydrate 後に signal が空文字で DOM を上書きする問題を defaultValues で回避
  // (= ADR 0069 + 第 4 周目発見の経路)。
  const f = formControl({
    schema: postContentSchema,
    defaultValues: post,
  });

  const handleSubmit = async (data: PostContentInput): Promise<void> => {
    // ADR 0073: params slot に URL 識別子 (slug)、data slot に form payload。
    // ADR 0076: 422 は bind が自動で setFieldErrors に流す。
    // ADR 0077: 422 以外 (= network/500/business) は bind の onError option で受けて
    // f.setFormError に流す経路、handler 自体は throw 任せで OK (= 内部 try/catch を
    // 書くと bind の自動 catch chain を bypass する不整合があるため)。
    const { slug } = await updatePost({ params: { slug: post.slug }, data });
    navigate(`/posts/${slug}`);
  };

  // ADR 0075: bind 戻り値が form props object、spread で marker (= router intercept
  // escape) と onSubmit を同時注入。post-form.tsx と同じ pattern。
  return (
    <form
      {...f.bind(handleSubmit, {
        // ADR 0077: validation 以外の error (= network/500/business) を formError に流す。
        // 再試行 / redirect / Sentry 通知等の business decision はこの onError 内で書き分ける。
        onError: (err) =>
          f.setFormError(err instanceof Error ? err.message : "Something went wrong"),
      })}
      class="mt-4 space-y-4"
    >
      {/* ADR 0077: form-level error 表示 (= rhf formState.errors.root 相当)。 */}
      {f.formError.value && (
        <p class="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {f.formError.value}
        </p>
      )}

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
