// dogfood Phase 7' (ADR 0071 + ADR 0072 連動): try/catch + ServerFnValidationError。
//
// 旧 (Phase 7):
//   - server.ts が CreatePostResult union 戻り値、isOk type predicate で narrow、
//     IDE TS server narrowing 不整合の workaround 多数
// 新 (Phase 7'):
//   - server.ts が validator(schema) で 422 throw、戻り値は `{ slug }` typed
//   - 本 file は `try { const { slug } = await createPost(data) } catch (err) { ... }`
//     で ServerFnValidationError を instanceof で受けて setFieldErrors に流す
//
// `__vidroServerFnStub` (= @vidro/router/client) が 422 + content-type JSON +
// `{fields}` shape を ServerFnValidationError として deserialize する (= ADR 0071
// + ADR 0072 連動)。同 schema 定義は server.ts 側にも残る (= 別 file 化は将来検討、
// ADR 0072 dream code 整合)。

import { formControl } from "@vidro/form";
import { navigate } from "@vidro/router";
import { ServerFnValidationError } from "@vidro/router/client";
import { z } from "zod";
import { createPost } from "./server";

const schema = z.object({
  title: z.string().min(1, "title is required"),
  body: z.string().min(1, "body is required"),
});

export function PostForm() {
  const f = formControl({ schema });

  const handleSubmit = async (data: z.infer<typeof schema>): Promise<void> => {
    try {
      const { slug } = await createPost(data);
      f.reset();
      navigate(`/posts/${slug}`);
    } catch (err) {
      if (err instanceof ServerFnValidationError) {
        f.setFieldErrors(err.fields);
        return;
      }
      throw err;
    }
  };

  // formControl で fetch を直接呼ぶ form は router の form delegation (= window
  // capture submit listener、ADR 0051) と衝突して二重 POST になるため
  // `data-vidro-no-intercept` で bypass する (= 第 3 周目の DX 痛み、
  // Phase 2c でも引き続き同じ問題)。formControl が自動でこの marker を
  // 付ける拡張は将来検討。
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
        {f.pending.value ? "Submitting..." : "Create post"}
      </button>
    </form>
  );
}
