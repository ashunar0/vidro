// dogfood Phase 7 (Phase 2c 実証): AppRouter mode の island form。
//
// 旧: `fetch("/posts/new", { ... })` を手書き、ADR 0068 同 path action と JSON
//     wire で対話
// 新: `import { createPost } from "./server"` で stub 化された fetch を呼ぶ
//     (= ADR 0070 Phase 2c 経路、bundler が serverBoundary で stub generation)
//
// `createPost` は server side では `serverFn` の handler、client bundle では
// `__vidroServerFnStub("/posts/new/createPost")` に置換されてる。引数 1 個 (=
// input) を渡すと body に JSON 配列で詰められて POST、result が JSON で戻る。
//
// validation 失敗 (= server 側 zod safeParse 不一致) は throw でなく
// `{ ok: false, fields }` 戻り値として received、formControl.setFieldErrors に
// 流す。同 schema 定義は server.ts 側にもあって重複している (= Phase 6
// `@vidro/zod` validator middleware で解消候補)。

import { formControl } from "@vidro/form";
import { navigate } from "@vidro/router";
import { z } from "zod";
import { createPost, type CreatePostResult } from "./server";

const schema = z.object({
  title: z.string().min(1, "title is required"),
  body: z.string().min(1, "body is required"),
});

export function PostForm() {
  const f = formControl({ schema });

  const handleSubmit = async (data: z.infer<typeof schema>): Promise<void> => {
    // 型は server.ts から explicit に annotation する (= IDE TS server が
    // serverFn の return 型推論で union を 1 branch に narrow する事象を観測した
    // ため、堅実に固定。CLI tsc は通るが IDE 起因の差異も含めて回避)。
    const result: CreatePostResult = await createPost(data);
    if (result.ok) {
      f.reset();
      navigate(`/posts/${result.slug}`);
      return;
    }
    f.setFieldErrors(result.fields);
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
