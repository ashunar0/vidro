import { computed, For, signal, signalify } from "@vidro/core";
import { loaderData, submission } from "@vidro/router";
import type { action, loader } from "./server";

// ADR 0049 dogfood — 痛み B (= action 後 page-local state が remount で reset される)
// の構造解消を実機検証する page。
//
// **Before (38th 末)**: data は plain object で渡るので、action 後の loader 再実行で
// page を remount → filter signal / count signal が消える。仕方なく filter は URL
// (`?q=...`) に backing する hack を入れていた (= readFilterFromURL / writeFilterToURL)。
//
// **After (39th, ADR 0049)**: loaderData() で取った store は同 page revalidate で
// 維持される (Router が swap せず diff merge する)。よって:
//   - filter signal だけで filter 状態が action 後も維持される (URL backing 不要)
//   - count signal も同様に維持される
//   - submission の cumulative state (`Adding...` → `Added: ...`) も維持される
//
// dogfood 手順:
//   1. filter input に "Vidro" と打つ
//   2. count ボタンを 5 回くらい押す (count = 5)
//   3. "新しい note" を入力して Add
//   4. **期待**: filter input は "Vidro" のまま、count は 5 のまま、notes 末尾に
//      新 note が in-place で append される (= page remount してない証拠)

export default function NotesPage() {
  const data = loaderData<typeof loader>();
  const subCreate = submission<typeof action>("create");

  const count = signal(0);
  // ADR 0049 後は plain signal だけで OK (= URL backing 撤去済)。
  const filter = signal("");
  const filteredNotes = computed(() =>
    data.notes.filter((n) => n.title.value.toLowerCase().includes(filter.value.toLowerCase())),
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

      {/* debug: filter signal が action 後も維持されることを目視確認 */}
      <p class="mt-1 text-xs text-gray-500">{`(debug) filter: "${filter.value}"`}</p>

      <ul class="mt-2 space-y-1">
        <For each={filteredNotes.value}>
          {(n) => <li class="rounded border px-3 py-2">{`#${n.id.value}: ${n.title.value}`}</li>}
        </For>
      </ul>

      <button
        type="button"
        onClick={() => count.value++}
        class="mt-4 rounded bg-gray-200 px-3 py-1 hover:bg-gray-300"
      >
        {`Click me (${count.value})`}
      </button>

      <form
        method="post"
        {...subCreate.bind()}
        onSubmit={(e: SubmitEvent) => {
          // ADR 0050 dogfood: 楽観更新 (= server 往復を待たず client store に即 append)。
          // plain Note を `signalify` で Store<Note> に昇格してから push する流儀。
          // `data.notes.push({ id: -Date.now(), title })` は TS error
          // (= push 引数は Store<Note> を要求) → ADR 0050 の痛みの起点。
          //
          // 注意: 楽観 -Date.now() と server 戻り (= 本物 id) は ADR 0049 の id-keyed
          // reconcile で別エントリ扱い → flicker / 重複表示する。これは ADR 0050 の
          // scope 外で、declarative 楽観更新 API (= 別 ADR γ 候補) で扱う宿題。
          const fd = new FormData(e.currentTarget as HTMLFormElement);
          const titleField = fd.get("title");
          const title = typeof titleField === "string" ? titleField.trim() : "";
          if (title) {
            data.notes.push(signalify({ id: -Date.now(), title }));
          }
          // submit 自体は subCreate.bind() の handler に任せる (= preventDefault しない)
        }}
        class="mt-4 flex gap-2"
      >
        <input
          name="title"
          placeholder="新しい note のタイトル"
          class="flex-1 rounded border px-3 py-2"
        />
        <button
          type="submit"
          disabled={subCreate.pending.value}
          class="rounded bg-blue-500 px-4 py-2 text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-blue-300"
        >
          {subCreate.pending.value ? "Adding..." : "Add"}
        </button>
      </form>
    </div>
  );
}
