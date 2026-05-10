// dogfood Path 4 delete button island (2026-05-10、61st session)。
//
// 第 3 周目までは `<form action="/posts/[slug]/delete" method="post">` で resource
// route 経由 (= ADR 0068)。第 4 周目で delete も Path 4 に統一するため island 化。
//
// 痛み点新規発見 (= memory 候補):
//   - 一覧 page は async server component (= 全行 SSR) なのに、行ごとに小さい
//     island 1 個を埋め込む形になる。JS payload は increment 分のみ (= ADR 0069
//     partial hydration の効果) だが、行が n 個あると island instance も n 個。
//   - form delegation (= 旧 resource route 経路) は JS なしでも動いた (= progressive
//     enhancement)。Path 4 化すると JS 必須に倒れる。trade-off。
//   - 一覧から削除 → 一覧再読込が欲しいので navigate(window.location.pathname) で
//     re-fetch する hack。標準 invalidate primitive 未実装、ADR 0073 候補。

import { ServerFnValidationError } from "@vidro/router/client";
import { revalidate } from "@vidro/router";
import { signal } from "@vidro/core";
import { deletePost } from "./server";

export function DeleteButton({ slug }: { slug: string }) {
  const pending = signal(false);

  const handleClick = async () => {
    if (pending.value) return;
    if (!confirm("Delete this post?")) return;

    pending.value = true;
    try {
      await deletePost({ slug });
      // 削除後に現 route の loader を再 fire して一覧を更新。`navigate(samePath)` は
      // signal の Object.is ガードで no-op するので使えない (= dogfood 第 4 周目発見)。
      // ただし async server component (= 本一覧 page) で revalidate が効くかは別途
      // 検証要、効かなければ window.location.reload() に倒す。
      await revalidate();
    } catch (err) {
      // delete 入力は { slug } 1 field、validator 失敗は実質起きない (= URL から
      // 来る前提) けど捕まえておく。
      if (err instanceof ServerFnValidationError) {
        console.error("[delete] validation:", err.fields);
        return;
      }
      throw err;
    } finally {
      pending.value = false;
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={() => pending.value}
      class="text-red-600 hover:underline disabled:opacity-50"
    >
      {pending.value ? "Deleting..." : "Delete"}
    </button>
  );
}
