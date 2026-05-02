import { computed, effect, For, signal } from "@vidro/core";
import { Link, loaderData, revalidate, searchParams, submissions } from "@vidro/router";
import type { action, loader } from "./server";

// ADR 0051 dogfood — derive 派楽観更新 + intent pattern + 複数 in-flight。
// ADR 0052 dogfood — searchParams() 経由 filter (= URL ↔ signal sync、Path Y)。
// ADR 0053 dogfood — server-side filter + paginate (= loader が `request.url` から
//                    `?page=` / `?q=` を読む経路)。
//
// 主要ポイント:
//   - **canonical store (`data.notes`) には書き込まない**: 楽観行は `subs.value` から
//     derive する。失敗時の rollback コードが不要 (= 書いてないものは消えない)
//   - **複数 form は HTML `<button name="intent" value="...">` で区別**: `submissions()`
//     の string key 引数は廃止。同 route の全 submission を array で取って intent で filter
//   - **複数 in-flight 自然対応**: Add 連打で 3 つの楽観行が並行表示される
//   - **loader 再 revalidate 完了で楽観行が auto-cleanup**: server 戻りで `data.notes`
//     に本物が現れた瞬間、success な submission が array から remove → 楽観行が自然消滅
//   - **filter / paginate は server-side**: ADR 0053 で loader が `request.url` を受け
//     取れるようになったので、`?q=Vidro&page=2` を server で filter+paginate して
//     `data.notes` には slice 済の subset だけ届く。client-side filter は廃止
//   - **`<Link href="?page=N">` は path Y の dogfood**: searchParam 変化で loader 自動
//     再 fire は **しない**。下の `effect(() => { sp.q.value; sp.page.value; revalidate(); })`
//     が user 側 explicit な bind 経路。
//
// dogfood 検証手順 (本セッション = ADR 0053):
//   1. /notes 直打ち → page 1 (items 1-5) が pre-rendered HTML で表示
//   2. /notes?page=2 直打ち → page 2 (items 6-10) が pre-rendered HTML
//   3. Next click → URL `?page=2` 更新 → revalidate() → server fetch → diff merge で in-place 更新
//   4. ブラウザ戻るボタン (popstate) → URL 戻り → revalidate() → server fetch → 戻る
//   5. filter "Vidro" 入力 → URL `?q=Vidro` + page=1 reset → server で filter 適用された slice
//   6. filter + page 2 で Delete 実行 → 同 URL (search 維持) で revalidate → page 2 の残り表示

export default function NotesPage() {
  const data = loaderData<typeof loader>();
  const subs = submissions<typeof action>();
  const sp = searchParams<{ q?: string; page?: string }>();

  const count = signal(0);

  // intent === "create" な in-flight = 楽観行表示用
  const pendingCreates = computed(() =>
    subs.value.filter((s) => s.input.value?.intent === "create" && s.pending.value),
  );

  // ADR 0052 path Y dogfood: searchParam 変化を loader 再 fire に user 側 explicit に bind。
  // - 初回 mount 後の effect 実行は bootstrap data があれば既に最新なので skip
  // - 以降は q / page どちらかが変わるたびに revalidate() で server fetch
  // - typing は debounce 無し (= localhost なら即時、production で気になれば user 側で debounce)
  let skipFirstRevalidate = true;
  effect(() => {
    void sp.q.value;
    void sp.page.value;
    if (skipFirstRevalidate) {
      skipFirstRevalidate = false;
      return;
    }
    void revalidate();
  });

  // 現 page index (1-based)。server 側で clamp 済の値が data.page で来る前提だが、
  // typing 中の momentary な乖離 (= URL は ?page=2、data はまだ ?page=3 の戻り) でも
  // UI が壊れないよう sp.page.value からも raw 値を読む。
  const currentPage = computed(() => {
    const raw = Number(sp.page.value ?? "1");
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
  });

  // pagination link 用 href builder。q を保ったまま page だけ変える。
  // page=1 のときは ?page= を省略して綺麗な URL にする (search 全削除なら "")。
  const buildHref = (page: number): string => {
    const params = new URLSearchParams();
    if (sp.q.value !== undefined && sp.q.value !== "") params.set("q", sp.q.value);
    if (page > 1) params.set("page", String(page));
    const qs = params.toString();
    return qs ? `?${qs}` : "/notes";
  };

  return (
    <div>
      <h2 class="text-xl font-semibold">Notes</h2>

      <input
        value={sp.q.value ?? ""}
        onInput={(e: InputEvent) => {
          // ADR 0052: 空文字を `undefined` に倒すと URL から `q=` が完全削除される。
          // ADR 0053: filter 変更時は page=1 にリセット (= 検索結果の先頭を見せる UX)。
          const v = (e.currentTarget as HTMLInputElement).value;
          sp.q.value = v === "" ? undefined : v;
          sp.page.value = undefined;
        }}
        placeholder="絞り込み..."
        class="mt-4 w-full rounded border px-3 py-2"
      />

      {/* debug: searchParams が URL と同期更新される目視確認 */}
      <p class="mt-1 text-xs text-gray-500">
        {`(debug) ?q=${sp.q.value ?? "(none)"} page=${sp.page.value ?? "(1)"} / total=${data.totalPages.value}`}
      </p>

      <ul class="mt-2 space-y-1">
        <For each={data.notes}>
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

      {/* pagination UI (ADR 0053 + 0054 dogfood)。ADR 0054 で <Link href> / <Link class>
          が `() => string` 関数渡しに対応したので、currentPage に追従する dynamic href
          を Link で書ける。pointer-events-none で disabled 相当を表現 (a 要素には
          disabled 属性が無いため)。Pathname は変わらないので Path Y → effect が
          revalidate() を発火 → server-side で paginate → diff merge で in-place 更新。 */}
      <nav class="mt-4 flex items-center gap-3 text-sm">
        <Link
          href={() => buildHref(currentPage.value - 1)}
          class={() =>
            `rounded border px-3 py-1 ${
              currentPage.value <= 1 ? "pointer-events-none opacity-30" : "hover:bg-gray-100"
            }`
          }
        >
          Prev
        </Link>
        <span class="text-gray-600">{`Page ${data.page.value} / ${data.totalPages.value}`}</span>
        <Link
          href={() => buildHref(currentPage.value + 1)}
          class={() =>
            `rounded border px-3 py-1 ${
              currentPage.value >= data.totalPages.value
                ? "pointer-events-none opacity-30"
                : "hover:bg-gray-100"
            }`
          }
        >
          Next
        </Link>
      </nav>

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
