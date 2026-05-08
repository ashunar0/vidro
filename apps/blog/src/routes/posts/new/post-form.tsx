// dogfood Form 第 3 周目: client island (`.tsx` = 両側実行)。
// `.server.tsx` 内 (`./index.server.tsx`) から JSX で参照されると jsx-transform が
// `<__VidroIsland>` で wrap し、SSR で marker emit + registry push、client で
// hydrate される (ADR 0060)。
//
// ADR 0069 dogfood: formControl({ schema }) で client form を fine-grained に制御。
// zod schema で validation、handler は parsed data を受け取って fetch する形。
// submission registry を使わないので submission() の per-route slot 不整合
// (= 痛み点 1) が構造的に発生しない。

import { formControl } from "@vidro/form";
import { navigate } from "@vidro/router";
import { z } from "zod";

const schema = z.object({
  title: z.string().min(1, "title is required"),
  body: z.string().min(1, "body is required"),
});

export function PostForm() {
  const f = formControl({ schema });

  // user fn は parsed data を受け取る。fetch / encoding は user 自由 (ADR 0069 §論点 8)。
  // 同 path co-location action (= ADR 0068 path: index.server.tsx の action export) に
  // JSON で投げる。422 は server validation fail として fieldError に流す。
  const handleSubmit = async (data: z.infer<typeof schema>) => {
    const res = await fetch("/posts/new", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      // handleAction の plain value 経路は `{ actionResult, loaderData }` で wrap して
      // 返す (= ADR 0037 R-min)。formControl は wire format に責務を持たないので、
      // 受信側 (= 本 island) が actionResult を取り出す。
      const body = (await res.json()) as { actionResult: { slug: string } };
      f.reset();
      navigate(`/posts/${body.actionResult.slug}`);
      return;
    }
    if (res.status === 422) {
      const body = (await res.json()) as { fields?: Record<string, string> };
      f.setFieldErrors(body.fields ?? {});
    }
  };

  // formControl で fetch を直接呼ぶ form は router の form delegation (= window
  // capture submit listener、ADR 0051) と衝突して二重 POST になる (= 1 つ目は
  // urlencoded で送られ action の `request.json()` が parse fail で 500)。
  // `data-vidro-no-intercept` で router delegation を bypass、formControl.bind の
  // onSubmit だけが走る形にする (= dogfood 第 3 周目で発見した DX 痛み、ADR 0069
  // formControl が自動でこの marker を付ける拡張は将来検討)。
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
        {/* `<p>` を常時出して reactive text の中身が空なら CSS `empty:hidden` で隠す。
             条件付き thunk (= `{() => err && <p>...</p>}`) は SSR/hydrate で
             VNode 構造が揃わず cursor mismatch するため避ける */}
        <p class="mt-1 text-sm text-red-600 empty:hidden">{f.error("title").value}</p>
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
        <p class="mt-1 text-sm text-red-600 empty:hidden">{f.error("body").value}</p>
      </div>

      {/* button text の thunk reactive 化は memory `project_jsx_runtime_contract_pending`
           の通り JSX runtime 側に SSR/hydrate cursor 整合の限界があるため、disabled だけ
           reactive にして text は static で書く (= submit 中の visible feedback は
           opacity だけ)。Vidro 機構の限界点記録 */}
      <button
        type="submit"
        disabled={() => f.pending.value}
        class="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
      >
        Create post
      </button>
    </form>
  );
}
