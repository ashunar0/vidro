# ADR 0039 — For / Show / Switch の reactive source 統一

- Status: Accepted
- Date: 2026-04-27
- 関連 ADR: 0022 (Show anchor), 0023 (Switch anchor), 0024 (For anchor),
  0025 (children getter)

## 背景 / 動機

For の `each` / Show の `when` / Match の `when` は **reactive source** (= signal
変化に追従する値) として扱いたいが、以前は型 / runtime 共に「plain value」または
「`() => T` 関数」しかサポートしておらず、**Signal を直接渡せない**状態だった:

```tsx
const cond = signal(true);
<Show when={cond}>...</Show>; // ❌ TS2740 + runtime: cond は object なので常に truthy
const items = signal([1, 2, 3]);
<For each={items}>...</For>; // ❌ TS2740 + runtime: each.length が undefined
```

memo 通り 12 件の test がこの理由で fail (`Signal<T[]> is not assignable to T[]`、
`Signal<unknown>` を `when` に渡すと常に truthy)。回避策として `() => cond.value`
の関数 wrap が必要だったが、Vidro の "signal-as-value" 体験 (= 配列や signal を
そのまま prop に渡したい) と一貫性が取れていなかった。

## 設計判断

**reactive source の概念を core に追加**し、3 形式を全て受ける形に統一する:

```ts
export type ReactiveSource<T> = T | (() => T) | Signal<T>;

export function readReactiveSource<T>(source: ReactiveSource<T>): T {
  if (source instanceof Signal) return source.value;
  if (typeof source === "function") return (source as () => T)();
  return source as T;
}
```

意味論:

| 形式        | 例                      | 挙動                                              |
| ----------- | ----------------------- | ------------------------------------------------- |
| `T`         | `[1, 2, 3]` / `true`    | 静的、subscribe しない                            |
| `() => T`   | `() => count.value > 0` | Solid 流 Accessor、関数内 signal 読みで subscribe |
| `Signal<T>` | `signal(...)`           | Vidro 流、`.value` 経由で subscribe               |

`readReactiveSource` を effect 内で呼べば、(2)(3) は signal 依存として自動
subscribe される (effect の observer が `.value` getter / 関数内 signal 読みを拾う)。

### 適用範囲 (本 ADR スコープ)

- `For.each`: `T[]` → `ReactiveSource<T[]>`
- `Show.when`: `unknown` → `ReactiveSource<unknown>`
- `Match.when`: `unknown` → `ReactiveSource<unknown>`

`Switch` は `children` 経由で Match descriptor を受けるだけなので変更なし。
Match 側で readWhen 経由 `readReactiveSource` を 1 回挟む形で吸収。

### 既存 API 互換

`T | () => T` (= 旧 API) は新 union の subset なので、user code 変更不要。
plain value 直渡しと関数渡しは引き続き動く。Signal 直渡しが新規追加。

### Solid との対応

- Solid: Accessor (`() => T`) 一択
- Vidro: Signal direct accept も追加 (`count.value` 表記の延長として `count` を
  そのまま渡せる)

利点: user code の noise 削減 (`<Show when={count}>` で OK、`when={() => count.value}`
書かなくていい)。trade-off: Signal を「object としての値」として when に渡したい
case (= signal 自体の存在性で truthy 判定したい) は出来なくなる (= 普通そんな
ユースケースはない)。

## 実装

### 新規

- `packages/core/src/reactive-source.ts` — `ReactiveSource<T>` 型 +
  `readReactiveSource(source)` helper
- `packages/core/src/index.ts` から `readReactiveSource` / `ReactiveSource` を
  re-export (user-defined component で再利用できるよう public)

### 修正

- `for.ts` — `each: ReactiveSource<T[]>` 型、server / initial / effect 全 path で
  `readReactiveSource(props.each)` 経由
- `show.ts` — `when: ReactiveSource<unknown>` 型、`typeof === "function"` 分岐を
  `readReactiveSource` に統一
- `switch.ts` — `Match.when: ReactiveSource<unknown>` 型、`MatchDescriptor.readWhen`
  内で `readReactiveSource(props.when)` を呼ぶ。Switch 側の `typeof w === "function"`
  ガードは不要になり削除 (readWhen が resolved value を返すため)

## 検証

### test

- `for.test.ts` 8/8 pass (旧 fail 8 件全て解消)
- `show.test.ts` 7/7 pass (旧 fail 1 件解消)
- `switch.test.ts` 7/7 pass (旧 fail 3 件解消)
- core 全体 224/224 pass
- workspace 全体 255/255 pass (= memo 12 件 fail が完全解消)

### TS check

- 旧 12 errors (`Signal<T[]>` not assignable to `T[]` / `unknown[]`、`'item' is of
type 'unknown'` 等) が全消失
- 新規 lint warning ゼロ

## Trade-off / 残課題

### Show の when が Signal<unknown> なので generics 化なし

Show は元々 `when: unknown` で TypeScript 上の generics を持たない。本 ADR でも
`ReactiveSource<unknown>` のままで、Signal の inner type を narrow する仕組みは
入れない (= toy 段階の minimum)。

### B-4 (children getter 化の inactive eager 評価) は別案件

memo が「For/Show/Switch test 失敗は B-4 案件」と書いていたが、実際はこの 12 件
fail は **reactive source 不足** が原因だった (B-4 とは別)。B-4 (= JSX runtime
の inactive branch 遅延評価) は別 ADR で取り組む宿題として残る (= demo の
template literal 回避が要らなくなる効果)。

### `instanceof Signal` の bundle 影響

`readReactiveSource` 内で `Signal` class 本体を import するため、bundle に Signal
class が必ず入る (= 旧 factory 経由のみだと tree-shake 余地があった)。実用上
factory 経由でも Signal class は入るので影響なし。

## 結論

- 12 件 pre-existing test fail を 1 commit で解消
- `<Show when={cond}>` / `<For each={items}>` のような Vidro 流の素直な書き方が
  動くようになり、`() => count.value` の関数 wrap が不要に
- `ReactiveSource<T>` を public 型として export し、user-defined component でも
  同じ pattern が使える土台ができた

次のステップ:

- B-4 (JSX runtime の children getter 化) は依然宿題、Phase 4 や R-mid-3 着地後の
  クリーンナップ Phase で着手
