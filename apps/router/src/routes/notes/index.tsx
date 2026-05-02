import { computed, For, signal } from "@vidro/core";
import { loaderData, searchParams, submissions } from "@vidro/router";
import type { action, loader } from "./server";

// ADR 0051 dogfood — derive 派楽観更新 + intent pattern + 複数 in-flight。
// ADR 0052 dogfood — searchParams() 経由 filter (= URL ↔ signal sync、Path Y)。
//
// 主要ポイント:
//   - **canonical store (`data.notes`) には書き込まない**: 楽観行は `subs.value` から
//     derive する。失敗時の rollback コードが不要 (= 書いてないものは消えない)
//   - **複数 form は HTML `<button name="intent" value="...">` で区別**: `submissions()`
//     の string key 引数は廃止。同 route の全 submission を array で取って intent で filter
//   - **複数 in-flight 自然対応**: Add 連打で 3 つの楽観行が並行表示される
//   - **loader 再 revalidate 完了で楽観行が auto-cleanup**: server 戻りで `data.notes`
//     に本物が現れた瞬間、success な submission が array から remove → 楽観行が自然消滅
//   - **filter は URL 反映 (= searchParams.q)**: `/notes?q=Vidro` 直打ちで pre-filtered
//     HTML が server 側で生成される。input 入力は replaceState で URL 同期、history は
//     汚さない (= ephemeral state)
//
// ADR 0049 痛み B 解消 (= action 後 page-local state が remount で消える) も維持:
//   count signal は loader revalidate を跨いで保持される。filter は searchParams
//   経由になったので signal の同 page 永続性は不要 (= URL 自体が永続化媒体)。
//
// dogfood 検証手順:
//   ADR 0051 (5 シナリオ):
//     1. filter "Vidro" + count 5 + Add → filter / count 維持、新行が in-place 追加
//     2. Add 連打 ("A" → Add → "B" → Add → "C" → Add) → 楽観行 3 つ並列、各々完了で消える
//     3. Delete 並列 (2 行同時) → opacity-50 line-through、loader 戻りで両方消える
//     4. server で throw → 楽観行が消えて data.notes は元のまま (= rollback コードゼロ)
//   ADR 0052 (5 シナリオ):
//     5. /notes?q=Vidro 直打ち → filter 適用済で表示 (= server で initial state 構築)
//     6. filter input typing → URL の ?q= が同期更新 (replaceState、history 汚さない)
//     7. ブラウザ戻るボタン → /notes は同 path 履歴を積まないので「前 page」へ戻る (= 仕様)
//     8. sp.q.value = "" || undefined で URL から q が完全削除されるか目視
//     9. SSR 整合: client hydrate 時に signal の値が server と一致 (mismatch なし)

export default function NotesPage() {
  const data = loaderData<typeof loader>();
  const subs = submissions<typeof action>();
  const sp = searchParams();

  const count = signal(0);

  const filteredNotes = computed(() =>
    data.notes.filter((n) =>
      n.title.value.toLowerCase().includes((sp.q.value ?? "").toLowerCase()),
    ),
  );

  // intent === "create" な in-flight = 楽観行表示用
  const pendingCreates = computed(() =>
    subs.value.filter((s) => s.input.value?.intent === "create" && s.pending.value),
  );

  return (
    <div>
      <h2 class="text-xl font-semibold">Notes</h2>

      <input
        value={sp.q.value ?? ""}
        onInput={(e: InputEvent) => {
          // ADR 0052: 空文字を `undefined` に倒すと URL から `q=` が完全削除される。
          // 残したい (= `?q=` を保持) なら value をそのまま代入。dogfood では削除側を採用。
          const v = (e.currentTarget as HTMLInputElement).value;
          sp.q.value = v === "" ? undefined : v;
        }}
        placeholder="絞り込み..."
        class="mt-4 w-full rounded border px-3 py-2"
      />

      {/* debug: searchParams.q が URL と同期更新される目視確認 */}
      <p class="mt-1 text-xs text-gray-500">{`(debug) ?q=${sp.q.value ?? "(none)"}`}</p>

      <ul class="mt-2 space-y-1">
        <For each={filteredNotes.value}>
          {(n) => {
            // 各 note 行が「自分が delete 中か」を subs から peek。複数 delete 並列でも
            // 各行が独立に判定される (= ADR 0051 derive 派の per-item UX)。
            const isDeleting = computed(() =>
              subs.value.some(
                (s) =>
                  s.input.value?.intent === "delete" &&
                  s.input.value?.id === String(n.id.value) &&
                  s.pending.value,
              ),
            );
            return (
              <li
                class={`flex items-center justify-between rounded border px-3 py-2 ${
                  isDeleting.value ? "opacity-50 line-through" : ""
                }`}
              >
                <span>{`#${n.id.value}: ${n.title.value}`}</span>
                {/* note ごとに小さい delete form。intent + id を hidden で持つ。 */}
                <form method="post" class="ml-2">
                  <input type="hidden" name="id" value={String(n.id.value)} />
                  <button
                    name="intent"
                    value="delete"
                    class="rounded bg-red-100 px-2 py-1 text-sm text-red-700 hover:bg-red-200"
                  >
                    Delete
                  </button>
                </form>
              </li>
            );
          }}
        </For>

        {/* 楽観行: in-flight な create を server 戻り前に仮表示 */}
        <For each={pendingCreates.value}>
          {(s) => {
            const title = s.input.value?.title;
            const titleStr = typeof title === "string" ? title : "";
            return (
              <li class="rounded border border-dashed px-3 py-2 italic opacity-50">
                {`#?: ${titleStr} (...adding)`}
              </li>
            );
          }}
        </For>
      </ul>

      <button
        type="button"
        onClick={() => count.value++}
        class="mt-4 rounded bg-gray-200 px-3 py-1 hover:bg-gray-300"
      >
        {`Click me (${count.value})`}
      </button>

      {/* 全体の create form。submit 時に Router が intercept して action へ送る。 */}
      <form method="post" class="mt-4 flex gap-2">
        <input
          name="title"
          placeholder="新しい note のタイトル"
          class="flex-1 rounded border px-3 py-2"
        />
        <button
          name="intent"
          value="create"
          class="rounded bg-blue-500 px-4 py-2 text-white hover:bg-blue-600"
        >
          Add
        </button>
      </form>
    </div>
  );
}
