// "reactive source" の統一 read helper (For の each / Show の when / Match の when 等で使う)。
//
// Solid は Accessor (`() => T`) 一択だが、Vidro は signal-as-value 体験 (= `count.value`
// 表記を統一していくため Signal を直接 prop に渡せる) を 1st-class で支える。
// 結果として 3 形式を全て受ける形になる:
//
//   1. plain T          — 静的値、reactive 追従なし
//   2. () => T          — Solid 流 Accessor
//   3. Signal<T>        — Vidro 流、`.value` 経由で reactive subscribe される
//
// effect 内で `readReactiveSource(source)` を呼べば、(2)/(3) は signal 依存として
// 自動 subscribe される (effect の observer が `.value` getter / 関数内の signal 読みを拾う)。
// (1) は subscribe しないので signal 連動は起きない (= 設計通り、static value)。

import { Signal } from "./signal";

/** prop で受ける reactive source の union 型。`T | () => T | Signal<T>`。 */
export type ReactiveSource<T> = T | (() => T) | Signal<T>;

/**
 * source を 3 形式から resolve する。effect 内で呼べば:
 *   - Signal<T> → `.value` で reactive subscribe
 *   - () => T   → 関数内の signal 読みで reactive subscribe
 *   - T         → そのまま (subscribe なし)
 */
export function readReactiveSource<T>(source: ReactiveSource<T>): T {
  if (source instanceof Signal) return source.value;
  if (typeof source === "function") return (source as () => T)();
  return source as T;
}
