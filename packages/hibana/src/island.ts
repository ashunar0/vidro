// @vidro/hibana の island primitive。
// `@vidro/core` の `__VidroIsland` (= Vidro 側 ADR 0060 で実装した marker emit + registry push 機構)
// を再利用して、Hibana の user-facing API として薄く wrap する。
//
// Step 2 (= Phase 1 Step 2): user が `Counter.island.tsx` 内で
//   export default defineIsland(Counter, "Counter")
// と書く temporary scaffolding。Step 3 で Vite plugin が `.island.tsx` import を
// 自動 wrap するようになったら、defineIsland は internal helper として残る予定
// (= user が直接呼ぶ必要なくなる)。詳細 = docs/roadmap-hibana.md。
//
// 合流ポイント: memory `project_hibana_vidro_interaction` の #2 = island 機構の共有。
// 重複実装を避け、Vidro の `__VidroIsland` を shared kernel として再利用する。

import { __VidroIsland, h } from "@vidro/core";

type IslandComponent<P> = (props: P) => Node | Promise<Node>;

/**
 * island component を marker emit + registry push 込みで wrap する。
 *
 * 戻り値は wrapped function: 引数 props を受け取って Node を返す関数。これは
 * 元 component とインターフェースが同じなので、JSX 内で透過的に使える:
 *   const Counter = defineIsland(CounterBase, "Counter")
 *   <Counter initial={0} />   // ← marker 込み SSR される
 *
 * server-side:
 *   - `__VidroIsland` 経由で `<!--vi-Counter-1-start:{"initial":0}-->...content...<!--vi-Counter-1-end-->`
 *     marker を emit
 *   - `<script>(window.__vidroIslandHydrate||=[]).push({key, name, seq})</script>` を発行
 *
 * client-side (= hydrate runtime から呼ばれた時):
 *   - `__VidroIsland` は `isServer === false` を見て children thunk を invoke
 *   - 結果として `h(component, props)` がそのまま evaluate される (= 通常の reactive render)
 *
 * @param component wrap 対象の component 関数 (= 純粋な JSX function)
 * @param name client 側 registry で lookup する key (= function 名と一致させると分かりやすい)
 */
export function defineIsland<P extends Record<string, unknown>>(
  component: IslandComponent<P>,
  name: string,
): (props: P) => Node {
  // h() 第 3 引数は children として props.children に届く。`__VidroIsland` は thunk
  // 形式で children を受け取る前提なので、`() => h(component, props)` で包む。
  // 型は h() の ComponentFn shape と Hibana の IslandComponent shape のあいだに変換が
  // 要るので境界で cast (= packages/hibana/src/index.ts の renderer 内 cast と同じ理屈)。
  return (props: P): Node => {
    return h(__VidroIsland as never, { name, props } as never, () =>
      h(component as never, props as never),
    ) as Node;
  };
}
