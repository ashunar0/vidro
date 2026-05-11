// @vidro/hibana/internal — Hibana の internal runtime helper。
//
// user-facing ではない。`@vidro/hibana/vite` plugin の transform hook が `.island.tsx` の
// default export を auto-wrap する時に、ここから `defineIsland` を import して使う:
//
//   // user 書く:
//   export default function Counter({ initial }: { initial: number }) { ... }
//
//   // vite plugin が transform 後:
//   import { defineIsland as __hibana_defineIsland } from "@vidro/hibana/internal";
//   export default __hibana_defineIsland(function Counter(...), "Counter");
//
// user は `@vidro/hibana/internal` を直接 import しない。Phase B-1 までは `@vidro/hibana`
// から defineIsland を re-export していたが、user 語彙から完全に消すために Phase B-2 で
// internal entry に移動した。
//
// 合流ポイント: memory `project_hibana_vidro_interaction` の #2 = island 機構の共有。
// 重複実装を避け、Vidro の `__VidroIsland` を shared kernel として再利用する。

import { __VidroIsland, h } from "@vidro/core";

type IslandComponent<P> = (props: P) => Node | Promise<Node>;

/**
 * island component を marker emit + registry push 込みで wrap する。
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
 * @param name client 側 registry で lookup する key (= filename と一致させる、plugin が自動付与)
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
