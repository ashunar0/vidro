# 0019 — SSR Phase B Step B-3a: hydrate primitive + JSX transform 強化

## Status

Accepted — 2026-04-26

## Context

ADR 0018 (Step B-2c) で `createServerHandler` が renderToString を統合し、
navigation response の `<div id="app">` に SSR markup を inject するように
なった。Step B-3 のゴールは「SSR で焼かれた DOM を **再生成せず** に effect /
event listener を attach する」hydrate primitive を入れて、`mount` (fresh
render) と対比立てること。

ところが Vidro の JSX runtime は **invoke-once 関数 call** で組まれており、
Solid 式の template clone モデルではない。`<div>hi</div>` の評価は jsx.ts の
`appendChild` ヘルパーで `"hi"` を受けてから `r.createText("hi")` を呼ぶため、
renderer の call 順は:

```
createElement("span")  ← span 自身が先
createText("hi")        ← その text は h() の **後** で生まれる
createElement("div")
```

target DOM の post-order traversal は `text → span → div`。span と text の
順序が逆になり、cursor based hydrate ができない (text が span より後で作られる
ため、cursor が text の位置にあるときに createElement("span") が呼ばれて
mismatch)。

問題は **JSX evaluation 順** に起因する。primitive child / dynamic child を
**h() の引数として先に解決する** ように JSX transform を強化すれば、call 順は
post-order と一致する。これが B-3a の前提条件 = transform 拡張が要る。

## Options

### 論点 1: transform の対象範囲

- **1-a (JSX child position のみ)**: JSXText (`<div>hi</div>` の "hi") を
  `_$text("...")`、JSXExpressionContainer (`<div>{expr}</div>`) を
  `_$dynamicChild(() => expr)` に書き換える。attribute 位置 (`class={expr}`)
  は今の `_reactive` のまま
- **1-b (全 transform を統一)**: attribute も含めて全部 helper 経由 (例:
  `_$attr(...)`)。runtime の `applyProp` は分岐を簡素化できるが、attribute は
  hydration の post-order と無関係なのでメリット薄

### 論点 2: helper API shape

- **2-a (個別 helper: `_$text`, `_$dynamicChild`)**: 静的 / 動的で別関数。
  transform 側が JSXText / JSXExpressionContainer で使い分ける
- **2-b (統合 helper: `_$child(value | thunk)`)**: 1 つの helper が peek 判定
  をするので、transform はラフ (全部 `_$child(() => value)` でくるむ)

### 論点 3: jsx.ts `appendChild` ヘルパーの後方互換

- **3-a (Node only に simplify、breaking)**: transform 経由なら helper で
  Node に解決済みなので、`appendChild(parent, primitive)` 経路は削除
- **3-b (両方サポート、deprecated コメント)**: transform 経由が default、
  手書き `h("div", null, "literal")` (tests / 既存 pattern) は従来動作で残す

### 論点 4: HydrationRenderer の cursor 構造

- **4-a (target を一度 post-order で flatten、index で前進)**: 配列 + index、
  実装単純
- **4-b (stateful walker: 現在 Node を hold、消費 → 次へ進む)**: lazy だが状態
  管理が細かい
- **4-c (parent / childIndex stack)**: 親子関係を保ちながら進む。tag mismatch
  の recovery 余地はあるが overengineered

### 論点 5: mismatch policy

- **5-a (Solid 同等)**: text 違い → console.warn + override、tag 違い → throw、
  attribute 同値 skip、property は idempotent 上書き
- **5-b (panic 全部)**: 何が違っても throw、recovery 不可
- **5-c (silent override)**: 全部黙って上書き。観測しにくい

### 論点 6: B-3a の対象範囲

- **6-a (シンプル component のみ)**: signal / computed / effect / event /
  dynamic text / dynamic attribute。ErrorBoundary / Show / Switch / For /
  Router は B-3a 対象外
- **6-b (Show / Switch / For を含める)**: anchor + fragment-based primitive を
  hydrate に対応。anchor の comment marker を server で吐く必要があり、追加
  論点が大きい
- **6-c (Router まで含める)**: Router の client mode を sync 初期化に書き換える
  必要があり、別 ADR に分離すべき大改造

## Decision

- 論点 1 → **1-a (JSX child position のみ)**
- 論点 2 → **2-a (個別 helper)**
- 論点 3 → **3-b (両方サポート)**
- 論点 4 → **4-a (post-order flatten + index)**
- 論点 5 → **5-a (Solid 同等)**
- 論点 6 → **6-a (シンプル component のみ)**

## Rationale

**1-a**: attribute 位置は `applyProp` 内で effect 化されるので、call 順とは
無関係 (DOM は createElement の後に setAttribute される、と decoupled な call
順で OK)。child 位置だけが post-order 制約を必要とする。範囲を絞ることで
transform の追加 logic は `JSXText` visitor 1 個 + `JSXExpressionContainer`
visitor の child position 分岐だけで済む。

**2-a**: 静的 string と動的 thunk は意味論が違う。`_$text("hi")` は単純に
`createText` するだけ、`_$dynamicChild(() => count.value)` は peek + Array/Node
判定 + effect attach がいる。1 つの helper で兼ねると runtime で typeof
判定が増えてコストもあいまいさも増す。

**3-b**: 既存 test (router-ssr.test.ts、render-to-string.test.ts) は手書き
`h("h1", null, "Hello")` パターンで動いており、breaking change で全部書き換える
工数 vs 後方互換 path を runtime に残す軽コストを比較すれば後者。手書き JSX は
transform 経由じゃないので post-order 違反を起こすが、これは hydrate モードで
使わなければ問題ない。tests は server / client mount モードでしか使ってない。

**4-a**: cursor を 1 回 collect する O(N) は target subtree のサイズに比例。
toy runtime の段階では十分。stateful walker は state の正しさを担保するのが
微妙に面倒で、「何の見返りがあるか」が見えない。

**5-a**: Solid (および React 18) のデファクト。text mismatch は warn にとどめて
画面を壊さない、tag mismatch は recovery 不能だから throw、attribute は
idempotent。どれも理にかなっている。

**6-a**: ErrorBoundary 等の anchor + fragment primitive を hydrate するには
**server で anchor comment を出す** + **client で comment を target cursor から
消費する** 仕組みが要る。今の renderToString は server mode で
anchor / fragment を一切出さない (ADR 0017 ErrorBoundary `isServer` 分岐)
ので、B-3a でこれをひっくり返すのは Router の hydrate と同等の重さ。Step B-3b
以降に分割する。

## Consequences

- **transform 拡張で全 .tsx の出力が変わる**: helper import (`_$text`,
  `_$dynamicChild`) が増える、JSX literal text が JSXExpressionContainer に
  なる。既存の SSR / mount 経路は意味論的に等価なので動作不変だが、bundle
  size は微増 (helper call 分)
- **手書きの `h(..., "literal")` は post-order 違反のまま**: hydrate モードで
  使うと cursor mismatch する。tests / 既存 pattern では mount / renderToString
  でしか使わないので問題なし。ドキュメント上「hydrate 対象は transform 経由
  の JSX に限る」と明記
- **ErrorBoundary / Show / Switch / For / Router を含む component は hydrate
  できない**: anchor / fragment primitive が cursor を狂わせる。B-3b 以降の
  課題として `project_pending_rewrites` に touchpoint を残す
- **`<For>` の dynamic array は hydrate 対象外**: server で fold した時点で
  array は静的展開されているが、client の `<For>` は anchor + reactive 切替
  で mismatch する
- **mount / hydrate の対比 API**: `mount(fn, target)` は fresh render (target
  の既存 children を `replaceChildren` で空にしてから appendChild)、
  `hydrate(fn, target)` は既存 DOM を消費する。`apps/router-demo/src/main.tsx`
  は当面 mount のまま (Router が hydrate 非対応)。Step B-3b で hydrate に切替

## Revisit when

- Step B-3b (Router の hydrate 対応) で:
  - Router の client mode を sync 初期化に書き換える (bootstrap data + resolved
    modules を client 側でも事前取得 → renderServerSide と同じ sync fold)
  - ErrorBoundary / Show / Switch / For の anchor を server でも吐く形に
    renderer を拡張するか、別 hydration marker (`<!--v$N-->`) を導入する
  - apps/router-demo の `main.tsx` を `hydrate` に切替えて blink 解消
- Show / Switch / For の hydrate 対応で:
  - server renderer に anchor comment 出力モードを追加 (B-3a では isServer
    で anchor / fragment を出さない方針だった)
  - client の primitive (show.ts / switch.ts / for.ts) を hydrate モードで
    cursor から anchor を消費する形に対応
- ErrorBoundary の hydrate 対応で:
  - server mode の `isServer` 分岐 (ADR 0017) を「anchor 出す」に変更
  - client の effect 立ち上げ logic を hydrate 経路でも動くように
- 手書き `h(..., "literal")` を deprecate するなら:
  - lint rule で警告 → transform 強制
  - render-to-string.test.ts / router-ssr.test.ts の手書き JSX を
    `_$text` 経由に書き換え

## 関連 ADR

- 0007: A 方式 transform の component 境界貫通 (この拡張の前提)
- 0016: Universal renderer 抽象 (Renderer interface に hydration mode を
  乗せる土台)
- 0017: Router server mode + ErrorBoundary `isServer` 分岐 (anchor を
  server で吐かない方針 — B-3b で revisit)
- 0018: createServerHandler 統合 + mount の fresh render 化 (mount ↔ hydrate
  対比の前段)
- 次: Step B-3b — Router を sync 初期化 + anchor primitive の hydrate 対応
