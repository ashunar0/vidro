import { computed, For, signal } from "@vidro/core";
import { loaderData, submissions } from "@vidro/router";
import type { action, loader } from "./server";

// ADR 0051 dogfood — derive 派楽観更新 + intent pattern + 複数 in-flight。
//
// 主要ポイント:
//   - **canonical store (`data.notes`) には書き込まない**: 楽観行は `subs.value` から
//     derive する。失敗時の rollback コードが不要 (= 書いてないものは消えない)
//   - **複数 form は HTML `<button name="intent" value="...">` で区別**: `submissions()`
//     の string key 引数は廃止。同 route の全 submission を array で取って intent で filter
//   - **複数 in-flight 自然対応**: Add 連打で 3 つの楽観行が並行表示される
//   - **loader 再 revalidate 完了で楽観行が auto-cleanup**: server 戻りで `data.notes`
//     に本物が現れた瞬間、success な submission が array から remove → 楽観行が自然消滅
//
// ADR 0049 痛み B 解消 (= action 後 page-local state が remount で消える) も維持:
//   filter signal / count signal は loader revalidate を跨いで保持される。
//
// dogfood 検証手順 (= ADR 0051 Consequences の 5 シナリオ):
//   1. filter "Vidro" + count 5 + Add → filter / count 維持、新行が in-place 追加
//   2. Add 連打 ("A" → Add → "B" → Add → "C" → Add) → 楽観行 3 つ並列、各々完了で消える
//   3. Delete 並列 (2 行同時) → opacity-50 line-through、loader 戻りで両方消える
//   4. server で throw → 楽観行が消えて data.notes は元のまま (= rollback コードゼロ)

export default function NotesPage() {
  const data = loaderData<typeof loader>();
  const subs = submissions<typeof action>();

  const count = signal(0);
  const filter = signal("");

  const filteredNotes = computed(() =>
    data.notes.filter((n) => n.title.value.toLowerCase().includes(filter.value.toLowerCase())),
  );

  // intent === "create" な in-flight = 楽観行表示用
  const pendingCreates = computed(() =>
    subs.value.filter((s) => s.input.value?.intent === "create" && s.pending.value),
  );

  return (
    <div>
      <h2 class="text-xl font-semibold">Notes</h2>

      <input
        value={filter.value}
        onInput={(e: InputEvent) => {
          filter.value = (e.currentTarget as HTMLInputElement).value;
        }}
        placeholder="絞り込み..."
        class="mt-4 w-full rounded border px-3 py-2"
      />

      {/* debug: filter signal が action 後も維持される目視確認 */}
      <p class="mt-1 text-xs text-gray-500">{`(debug) filter: "${filter.value}"`}</p>

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
