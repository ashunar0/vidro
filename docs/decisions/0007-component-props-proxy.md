# 0007 — Component props を Proxy でラップして A 方式を境界まで貫く

## Status

Accepted — 2026-04-24

## Context

A 方式 JSX transform (ADR 0005 で前提になっている) は JSX 式 `{expr}` を
`() => expr` に書き換える。DOM element の attribute では `applyProp` が関数を
見て effect 内で呼ぶため、`<div class={cond}>` が期待通り reactive に動いていた。

一方 component 境界では `h()` が props をそのまま渡していたため、A 方式の
「`{expr}` は読むたびに評価される値」という規約が component 境界で切れていた。

`@vidro/router` 実装中に `<Router routes={routes} />` が **関数として** Router
に届く問題で発覚。最初は Router 側で `typeof === "function"` を peek する
workaround で凌いだが、これは regression を含む根本設計の論点。

両立したい性質:

- 既存 DSL `{signal.value}` 一本 — ユーザーに `()` を書かせない
- intrinsic / component で attribute の扱いが対称
- ユーザーが書いた arrow (event handler / render callback / fallback factory) は
  関数のまま component に届く

## Options

### (A) transform 側で大文字始まり (component) の attribute を wrap しない

- Pros: ユーザー書いた値がそのまま届く、workaround 不要
- Cons:
  - reactive props を渡すたび `<Counter count={() => signal.value} />` と
    明示 arrow が必要 → A 方式の「`{expr}` だけで reactive」旨味が半減
  - intrinsic と component で `{cond}` の意味が変わる → ユーザーが要素名の大小で
    reactivity を判断する必要 (A 方式の対称性破壊)

### (B) `h()` 側で props を受ける時 `typeof === "function"` なら peek

- Pros: 最小変更
- Cons: **reactive が完全に死ぬ** (peek した時点で値が固定)。却下。

### (C) ユーザー側で `props.count()` と明示呼び出し

- Pros: Solid 式、reactivity 維持
- Cons:
  - intrinsic: `class={signal.value}` / component: `value={signal.value}` →
    内部では `props.value()` 呼び出し、という **ユーザー DSL の二重化**
  - 型も `() => number` になるので直感から遠い

### (D) Solid 式 Proxy props + transform marker

- transform で `{expr}` を `_reactive(() => expr)` に変換し、runtime helper
  `_reactive` が marker property (`__vidroReactive = true`) を付与
- `h()` 側で component props を Proxy でラップ、getter access 時に marker 付き
  関数だけを呼び出して展開、`on*` / `children` / marker 無し関数は素通す
- ユーザーが書いた arrow literal (marker 無し) と transform 生成関数を区別できる
- Pros:
  - A 方式の規約を component 境界でも貫通 (intrinsic と対称)
  - ユーザー DSL はそのまま (`value={signal.value}` で OK)
  - Solid で確立された pattern
  - JS 意味論を壊さない、JSX 仕様内の拡張
- Cons:
  - Proxy オーバーヘッド (getter 1 hop)
  - **"don't destructure props" 制約**: `const { count } = props` は getter が
    1 度しか走らず reactivity が死ぬ (Solid と同じ制約)
  - 既存 primitive (Match / Show / For) の内部実装が「props を値コピー保存」方式
    だと初回評価で固定されるため refactor が必要

## Decision

**(D) Solid 式 Proxy + transform marker** を採用する。

実装:

1. `@vidro/core` に `_reactive<T>(fn: () => T): () => T` を追加。marker property を
   セットして同じ関数を返す internal helper (underscore prefix)。
2. `h()` で `type === "function"` の場合、props を Proxy でラップ:
   - `children` key: 素通し (render callback / Node / 多態)
   - `on*` key: 素通し (event handler)
   - marker 付き関数: 呼び出して展開 → reactive 値
   - それ以外: raw 返却
3. vite plugin の transform で `{expr}` を `_reactive(() => expr)` に書き換え、
   ファイル先頭に `import { _reactive } from "@vidro/core"` を自動 inject。
4. 既存 primitive (Match / Show / For) を「effect 内で毎回 `props.xxx` を読む」
   形に refactor。descriptor / local 変数に値コピーして保存するのは禁止。

## Rationale

### A 方式の完成形であって、無理やりじゃない

A 方式を選んだ時点で「`{expr}` は読むたびに評価される値」という規約が JSX 全体に
敷かれている。intrinsic は `applyProp` で守られていたが、component は実装が漏れて
いただけ。Proxy + marker はこの規約を **component 境界まで貫通させる工事** であり、
A 方式の必然の実装詳細。

RSC 的な「設計の根幹と矛盾する機能を後付けする」タイプの無理やりとは真逆で、
**根幹を貫くための compiler ↔ runtime 契約**。

### "transform 生成 reactive" と "user arrow value" は本質的に別物

JS runtime から見ると両者 `typeof === "function"` だが、意味論は別:

- transform 生成: 「この値は毎回評価されるべき」 (reactive 意味論)
- ユーザー arrow: 「関数そのものを値として渡す」 (value 意味論)

区別が runtime で不可能なのは表現の問題であって、意味の問題ではない。Marker で
明示的に区別するのは曖昧さの解消であって魔法ではない。

### Svelte 的魔法ではない

- JS の意味論を拡張しない (`let x = 0` が reactive になる、のような改変なし)
- ユーザーコードは標準 JSX のまま (独自構文ゼロ)
- TypeScript / lint / formatter がそのまま動く
- 変換範囲は JSX 式の `{}` 内のみ

ユーザーが明示的に知る必要があるのは **"don't destructure props"** のみ。これは
Solid が運用実績のある制約で、メンタルモデル「props は reactive な値 → 値コピーに
すると追従が切れる」で自然に導ける。

### Signal 直渡し (`when={signal}`) は非推奨へ

既存の primitive は `Signal<T> | (() => T) | T` の 3 形式を受けて `readWhen`
helper で分岐していた。Proxy 化後は `props.when` が毎回評価される T 型になるので、
ユーザーは `when={signal.value}` 形式に統一。`when={signal}` は transform で
`_reactive(() => signal)` になり Signal instance (truthy) で固定される → 正しく
動かない。これは A 方式の対称性と噛み合う方向 (`.value` 記法で統一)。

## Consequences

- `Match` / `Show` / `For` の `readWhen` / `readEach` helper は削除、props 型は
  `T` のみ (Signal / function 形式は受けなくなる)
- 既存コードで `when={() => ...}` と arrow 明示してた箇所は `when={...}` に直す
  (website: App.tsx の Switch/Match、Stopwatch の `when={running}` → `when={running.value}`)
- ユーザー向けドキュメント (将来) に "don't destructure props" と
  "`when={signal.value}` 形式で書く" を明記する必要あり
- Proxy のオーバーヘッドが component ごとに 1 hop 発生。fine-grained reactivity
  なので component re-render は無いため許容範囲と判断
- vite plugin の transform は `_reactive` import の auto inject 責務を持つ →
  将来 `@vidro/plugin` 的なパッケージに切り出す動機が強くなった

## Revisit when

- Proxy オーバーヘッドがプロファイリングで実害になった時 — 静的解析で
  reactive / static を区別して一部 props だけ proxy 経由にする等の最適化
- ユーザーが "don't destructure props" に繰り返し引っかかる状況が出た時 —
  `splitProps` 的な helper を追加して refactor 支援
- Suspense + children getter 化 (roadmap B-4) を実装する時 — children の proxy
  展開ルールを再設計する可能性
