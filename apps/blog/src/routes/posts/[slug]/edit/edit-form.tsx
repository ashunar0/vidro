// dogfood Path 4 edit form island (2026-05-10、61st session)。
//
// post-form.tsx (= create) と同 pattern。違いは:
//   1. post: Post を props で受け取る (= async server component から prefill)
//   2. schema に slug 含める (= URL 動的 segment 回避、server.ts と対応)
//   3. submit 後の navigate 先が post.slug 経由
//   4. formControl({ defaultValues }) で prefill — 第 4 周目発見の痛み解消経路。
//      旧経路 (= input に value={post.title} 直指定 + textarea children) は
//      hydrate 後に signal value="" が DOM を上書きして空に倒れる + submit 時
//      formControl が空 snapshot を validate して 422 に落ちる、という二重バグ。
//      defaultValues で signal を eager 初期化することで両方解消、ADR 0069 拡張。

import { formControl } from "@vidro/form";
import { navigate } from "@vidro/router";
import { ServerFnValidationError } from "@vidro/router/client";
import { z } from "zod";
import type { Post } from "../../server";
import { updatePost } from "../../server";

const schema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1, "title is required"),
  body: z.string().min(1, "body is required"),
});

export function EditPostForm({ post }: { post: Post }) {
  const f = formControl({
    schema,
    defaultValues: { slug: post.slug, title: post.title, body: post.body },
  });

  const handleSubmit = async (data: z.infer<typeof schema>): Promise<void> => {
    try {
      const { slug } = await updatePost(data);
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
      {/* slug は URL identifier、user に編集させない hidden field。 */}
      <input type="hidden" {...f.field("slug")} />

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
