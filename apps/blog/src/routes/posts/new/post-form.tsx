// dogfood Phase 7' (ADR 0071 + ADR 0072 連動): try/catch + ServerFnValidationError。
// dogfood 第 6 周目 (2026-05-10): schema を ./schema.ts に集約、server.ts と共有。
// dogfood 第 7 周目 (2026-05-10): feature-based 切り分け、schema は features/posts/schema へ移動。
//
// 旧 (Phase 7):
//   - server.ts が CreatePostResult union 戻り値、isOk type predicate で narrow、
//     IDE TS server narrowing 不整合の workaround 多数
// 新 (Phase 7'):
//   - server.ts が validator(schema) で 422 throw、戻り値は `{ slug }` typed
//   - 本 file は `try { const { slug } = await createPost(data) } catch (err) { ... }`
//     で ServerFnValidationError を instanceof で受けて setFieldErrors に流す
// 第 6 周目:
//   - schema 定義は ./schema.ts に切り出し、本 file と server.ts 両方が import
//     (= "別 file 化は将来検討" の TODO を解消、規約のみで解決 = D 案)
// 第 7 周目:
//   - schema は features/posts/schema に集約 (= feature-based 切り分け)、
//     create/update で同 shape の postContentSchema を共有
//   - createPost も features/posts/server から import (routes/ の server.ts は re-export)
//
// `__vidroServerFnStub` (= @vidro/router/client) が 422 + content-type JSON +
// `{fields}` shape を ServerFnValidationError として deserialize する (= ADR 0071
// + ADR 0072 連動)。

import { formControl } from "@vidro/form";
import { navigate } from "@vidro/router";
import { ServerFnValidationError } from "@vidro/router/client";
import type { PostContentInput } from "../../../features/posts/schema";
import { postContentSchema } from "../../../features/posts/schema";
import { createPost } from "../../../features/posts/server";

export function PostForm() {
  const f = formControl({ schema: postContentSchema });

  const handleSubmit = async (data: PostContentInput): Promise<void> => {
    try {
      // ADR 0073: data は data slot に詰める、`{ data }` で渡す。
      const { slug } = await createPost({ data });
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
