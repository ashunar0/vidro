// ADR 0060 dogfood — Client Component (= island)。`.tsx` (default 拡張子) なので
// 両側実行: server で SSR 焼き、client で hydrate。`.server.tsx` から JSX で参照
// されると jsx-transform が `<__VidroIsland>` で wrap → SSR で marker emit、
// client で `setupIslandHydration` (router) が hydrateRange 経由で hydrate する。
//
// 受け取った `initial` props で signal を起動、click で increment。Vidro fine-grained
// reactivity のミニマル demo + partial hydration が動いてる証拠としての visible UI。

import { signal } from "@vidro/core";

export function LikeButton({ initial }: { initial: number }) {
  const count = signal(initial);
  return (
    <button
      type="button"
      onClick={() => count.value++}
      class="rounded bg-pink-100 px-3 py-1 text-pink-700 hover:bg-pink-200"
    >
      ♥ Like ({count.value})
    </button>
  );
}
