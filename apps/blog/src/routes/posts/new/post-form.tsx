// dogfood 第 11 周目 (2026-05-10、ADR 0076): try/catch boilerplate 撲滅。
//
// 旧 (第 7 周目〜第 10 周目): handleSubmit で
//   try { const { slug } = await createPost({ data }) } catch (err) {
//     if (err instanceof ServerFnValidationError) f.setFieldErrors(err.fields); else throw err;
//   }
// と毎 form 同じ 5 行 + ServerFnValidationError import を user に書かせていた。
// 新 (第 11 周目、ADR 0076): formControl の bind が `name === "ServerFnValidationError"`
// + fields shape を duck-type で自動 catch して setFieldErrors に流すので、user code から
// try/catch も import も消える。throw しっぱなしで OK、想定外 error (network / 500 等) は
// bubble up するので必要なら別途 try/catch する。
//
// 関連 ADR: 0069 (formControl)、0073 (serverFn object slot)、0075 (bind を spread props 化)、
// 0076 (本 ADR、validation error の自動消化)。schema は features/posts/schema、createPost
// は features/posts/server から import (= 第 7 周目 feature-based 切り分け)。

import { formControl } from "@vidro/form";
import { navigate } from "@vidro/router";
import type { PostContentInput } from "../../../features/posts/schema";
import { postContentSchema } from "../../../features/posts/schema";
import { createPost } from "../../../features/posts/server";

export function PostForm() {
  const f = formControl({ schema: postContentSchema });

  const handleSubmit = async (data: PostContentInput): Promise<void> => {
    // ADR 0073: data slot に詰めて渡す。ADR 0076: 422 (= ServerFnValidationError) は
    // bind が自動で setFieldErrors に流すので try/catch 不要、throw しっぱなしで OK。
    const { slug } = await createPost({ data });
    f.reset();
    navigate(`/posts/${slug}`);
  };

  // ADR 0075: bind 戻り値は form props object (= onSubmit + data-vidro-no-intercept
  // marker)。spread で form 全体に注入、router の global form interceptor (ADR 0051)
  // から自動 escape。第 3 周目から第 8 周目まで手書きしてた marker が不要に。
  return (
    <form {...f.bind(handleSubmit)} class="mt-4 space-y-4">
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
