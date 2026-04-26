# 0021 — SSR Phase B Step B-3c-1: ErrorBoundary を server anchor + client renderer 経由

## Status

Accepted — 2026-04-27

## Context

ADR 0020 (Step B-3b) で「ErrorBoundary の anchor 対応 + client renderer 経由化は
B-3c で行う」と決めた。ADR 0019 Consequences には「ErrorBoundary を含む
component は hydrate できない」とあり、ADR 0017 では「server で anchor を
出さない (`isServer` 分岐)」と決めていた。本 ADR で両方を覆し、ErrorBoundary
を hydrate-ready にする。

現状の実装 (B-3b 時点) の問題点:

1. **client mode が renderer 非経由**: `error-boundary.ts` で
   `document.createComment` / `document.createDocumentFragment` を直接呼んで
   いる。HydrationRenderer の cursor を消費せず、universal renderer 設計
   (ADR 0016) からも外れる
2. **server mode が anchor を出さない**: `isServer` 分岐 (ADR 0017) で content
   だけ返す。client が `<!--error-boundary-->` を期待して cursor 消費しようと
   すると、SSR markup に存在しないため tag mismatch
3. **HydrationRenderer の `appendChild` が child 移動を防げない**: anchor +
   fragment 系 primitive で children を新規 fragment に append すると、children
   が target subtree から外れる (DOM tree から消える)

これら 3 点を順に解決すれば、ErrorBoundary は mount / hydrate / server-render
全 mode で renderer 経由の同 shape の出力になる。

## Options

### 論点 1: anchor の値

- **1-a (`<!--error-boundary-->`)**: Router の `<!--router-->` と同 pattern。
  human-readable で debug しやすい
- **1-b (`<!--vN-->` のような短 marker)**: Solid 風、bundle/markup size 削減
- **1-c (`<!--$-->` 等の sigil)**: React 風、衝突リスク低い

### 論点 2: server mode で fragment を返す形

- **2-a (現在の B-3b Router と同じ shape: `[contentNode, anchor]`)**:
  hydrate cursor 順 (post-order) と一致、Router の構造と統一感
- **2-b (`[anchor, contentNode]` 順)**: insert-before 寄り、hydrate cursor
  順と不一致
- **2-c (`[anchor]` だけで content を別途 mount)**: client mode と完全 1:1、
  だが server で content 出力できなくなる (本末転倒)

### 論点 3: client mode の content 評価タイミング

- **3-a (mountChildren を anchor 作成の前に呼ぶ + initial で fallback も即評価)**:
  cursor 順 (content → anchor) と JSX 評価順を一致。children throw 時は
  fallback も同期評価して initial content として fragment に入れる
- **3-b (現状通り anchor 先 → effect 内で children 評価)**: cursor 順と不一致、
  hydrate で mismatch する

### 論点 4: HydrationRenderer の appendChild 挙動

- **4-a (target.contains(child) なら skip)**: child が既に target subtree 内
  にいる場合、fragment への append を skip して元の DOM 位置を維持。
  anchor + fragment 系 primitive の cursor 消費構造で必要
- **4-b (parent.contains(child) で循環チェック)**: 普通の cycle 検出、
  本問題は解決しない
- **4-c (renderer に新 API 追加 e.g. `wrap`/`group`)**: anchor 系 primitive を
  別 API で表現。breaking、過剰

### 論点 5: ADR 0017 / 0019 の扱い

- **5-a (この ADR で部分上書き判断を残す)**: 過去 ADR を編集せず、本 ADR が
  「ErrorBoundary について B-3c-1 で `isServer` 分岐を anchor 出力に変更」
  と明記
- **5-b (過去 ADR を編集して整合)**: 履歴が歪む、過去判断の経緯が消える

## Decision

- 論点 1 → **1-a (`<!--error-boundary-->`)**
- 論点 2 → **2-a (`[contentNode, anchor]`)**
- 論点 3 → **3-a (content 先評価 + 初期 fallback 同期評価)**
- 論点 4 → **4-a (target.contains(child) なら skip)**
- 論点 5 → **5-a (本 ADR で部分上書き)**

## Rationale

**1-a**: Router の `<!--router-->` (ADR 0020) と同 pattern にすることで、
2 種の anchor を debug 時に区別しやすい。bundle size 増加は marker 名称の
文字数差 (`error-boundary` 14 文字、`vN` 2 文字) × 出現回数だが、toy runtime
段階では measurable な差にならない。Show / Switch / For を B-3c-2/3/4 で
追加する際も同 naming convention を踏襲する。

**2-a**: hydrate の cursor は post-order traversal なので「content の中身 →
content 自体 → anchor」の順。fragment.children = `[contentNode, anchor]` で
serialize すると `<content>...</content><!--anchor-->` になり、cursor 順と
一致。client mode の renderer.appendChild も同順で呼ばれる (3-a と整合)。

**3-a**: ErrorBoundary client mode の旧構造 (anchor 先 → effect 内 children)
だと cursor 順違反。content を先に評価することで、mount / hydrate 両方で
renderer の呼び出し順が `createElement(content...)` → `createComment(anchor)`
の順になる。children throw 時は server mode と同じく fallback も同期評価
することで、初期 content の cursor 消費を完了させる。

effect 初回 invocation は initial state を二重 setup しないよう
`initialEffect` フラグで skip。dependency (error.value) は effect body 内で
読まれるため subscribe されており、reset 等の signal 変化で本来の切替 logic
に入る。

**4-a**: anchor + fragment primitive (ErrorBoundary 等) は content を先に
renderer 経由で評価し (= 既存 target Node を cursor 経由で取得)、その後
新規 fragment に append する。この時 child は既に target subtree 内にいる。
`target.contains(child)` を check して skip すれば、元の DOM 位置を維持
できる (= hydrate の意図、DOM 再生成しない)。Show / Switch / For でも同様の
構造になるので汎用的に effective。

**5-a**: ADR 0017 の `isServer` 分岐 (server で anchor 出さない) は
B-3 計画完了前の中間判断。ADR 0019 Consequences (「ErrorBoundary を hydrate
できない」) も B-3a 時点での前提。両方とも本 ADR で更新するが、過去 ADR は
編集しない。

## Consequences

### 完了したこと (B-3c-1 スコープ)

- **`packages/core/src/error-boundary.ts` 改修**:
  - server mode: `try { contentNode = props.children() } catch { ... }` で
    content を sync 評価 → `fragment + content + <!--error-boundary-->` を返す
  - client mode (mount / hydrate 共通): `mountChildren()` を `anchor` 作成
    の前に呼ぶ。children throw 時は `fallbackOwner` + fallback content を
    同期評価して initial content にする。anchor / fragment / appendChild を
    `getRenderer()` 経由に
  - effect の初回 invocation は `initialEffect` フラグで skip (initial state
    既に setup 済み)
- **`packages/core/src/hydration-renderer.ts` の appendChild fix**:
  parent が新規 DocumentFragment かつ `target.contains(child)` なら append
  skip (既存 DOM 位置を維持)
- **テスト**:
  - `core/tests/hydrate.test.ts` に ErrorBoundary を含む subtree の hydrate
    test を 2 件追加 (正常経路 + initial throw 経路)
  - `core/tests/error-boundary.test.ts` 9 件 + `hydrate.test.ts` 9 件
    (前 7 件 + 2 件追加) 全 pass
  - `router/tests/router-ssr.test.ts` 7 件の expectation を
    `<!--error-boundary-->` 込みに更新
  - `router/tests/server-navigation.test.ts` 1 件同上
- **router-demo の SSR markup**:
  `<div id="app"><div ...><h1>...</h1>...<main>...<section>...</section><!--error-boundary--></main></div><!--error-boundary--><!--router--></div>`
  の形になる (leaf + root layout の 2 層 ErrorBoundary anchor + Router anchor)

### server / client bundle への影響

- core bundle: 微増 (initialEffect フラグ + initial fallback 評価ロジック)
- server bundle: 微増 (createServerHandler 経由で server mode が anchor +
  fragment を出す分の serialize 増)
- server markup: ErrorBoundary が登場するごとに `<!--error-boundary-->` が
  1 個ずつ追加される (router-demo 全 route で +2 個)

### 保留事項

- **B-3c-2/3/4**: Show / Switch / For を同 pattern で対応 (各 anchor を
  server で吐く + client renderer 経由)。本 ADR の判断 (1-a / 2-a / 3-a /
  4-a) を踏襲
- **B-4**: Suspense + JSX runtime children getter 化。foldRouteTree の
  inside-out fold 評価順問題はここで解消
- **B-3d**: B-3c 全完了 + B-4 完了後、main.tsx を `mount` → `hydrate` に
  切替えて blink 解消

## ADR 0017 / 0019 の Revisit when 訂正

### ADR 0017 Revisit when

「ErrorBoundary の hydrate 対応」項を **本 ADR で対応済** に更新:

- ~~server mode の `isServer` 分岐 (ADR 0017) を「anchor 出す」に変更~~ → 完了
- ~~client の effect 立ち上げ logic を hydrate 経路でも動くように~~ → 完了

### ADR 0019 Revisit when

「ErrorBoundary の hydrate 対応で」項を **本 ADR で対応済** に更新。
Show / Switch / For は引き続き B-3c-2/3/4 で順次対応。

## 関連 ADR

- 0004: ErrorBoundary primitive 設計 (関数で children 包む API)
- 0016: Universal renderer 抽象 (renderer 経由化の前提)
- 0017: Router server mode + ErrorBoundary `isServer` 分岐 (本 ADR で
  ErrorBoundary 部分を訂正)
- 0019: hydrate primitive (本 ADR で ErrorBoundary 部分を訂正)
- 0020: Router の sync 初期化 + server anchor (B-3b、本 ADR と同 pattern)
- 次: Step B-3c-2 — Show を server anchor + client renderer 経由
