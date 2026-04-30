import { computed, For, signal } from "@vidro/core";
import { submission, type PageProps } from "@vidro/router";
import type { action, loader } from "./server";

// C-4: filter state を URL params (`?q=xxx`) に backing する手書き implementation。
// Vidro はまだ useSearchParams 系 API が無いので window 直叩きで実装。
// 効果: page remount (= action 後) でも URL から復元 → filter 維持。
//
// 注意: SSR は URL search params を読まない (loader API が params のみで request 不在)
// ため、reload で ?q=xxx 付きの URL を直接開くと server markup と client init が
// ズレる可能性あり。今回の dogfood は client navigate / action 経路に絞って
// 体感する形 (= 純粋な client-only state persistence の demo)。
function readFilterFromURL(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("q") ?? "";
}

function writeFilterToURL(value: string): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  if (value) params.set("q", value);
  else params.delete("q");
  const qs = params.toString();
  const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  // pushState でなく replaceState: 1 タイプ毎に history entry を増やさない
  window.history.replaceState(null, "", newUrl);
}

export default function NotesPage({ data }: PageProps<typeof loader>) {
  const subCreate = submission<typeof action>("create");

  const count = signal(0);
  // 初期値を URL から読む。page remount のたびに再 init されるが、URL が同じ値で
  // 残っている (writeFilterToURL で update 済) ので結果として filter が「残る」。
  const filter = signal(readFilterFromURL());
  const filteredNotes = computed(() =>
    data.notes.filter((n) => n.title.toLowerCase().includes(filter.value.toLowerCase())),
  );

  return (
    <div>
      <h2 class="text-xl font-semibold">Notes</h2>

      <input
        value={filter.value}
        onInput={(e: InputEvent) => {
          const value = (e.currentTarget as HTMLInputElement).value;
          filter.value = value;
          writeFilterToURL(value);
        }}
        placeholder="絞り込み..."
        class="mt-4 w-full rounded border px-3 py-2"
      />

      {/* debug: filter signal が typing で更新されるか確認 */}
      <p class="mt-1 text-xs text-gray-500">{`(debug) filter: "${filter.value}"`}</p>

      <ul class="mt-2 space-y-1">
        <For each={filteredNotes.value}>
          {(n) => (
            // 注: B-4 待ちの Vidro 現状制約 → template literal で 1 dynamic slot に圧縮
            <li class="rounded border px-3 py-2">{`#${n.id}: ${n.title}`}</li>
          )}
        </For>
      </ul>

      <button
        type="button"
        onClick={() => count.value++}
        class="mt-4 rounded bg-gray-200 px-3 py-1 hover:bg-gray-300"
      >
        {`Click me (${count.value})`}
      </button>

      <form method="post" {...subCreate.bind()} class="mt-4 flex gap-2">
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
