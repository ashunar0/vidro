# ADR 0031 — SSR Phase C Step C-1+C-2 streaming SSR (shell + tail)

- Status: Accepted
- Date: 2026-04-27
- Phase: C-1 (renderToReadableStream API) + C-2 (Suspense boundary を後追い fill)

## 背景

Phase B-5c (ADR 0030) で `renderToStringAsync` が 2-pass blocking SSR として落ち
着いた。`bootstrapKey` 付き createResource を server で resolve してから markup を
焼くので blink は無いが、**全 resource resolve まで 1 byte も flush できない** —
TTFB は最も遅い fetch に律速される。

本 ADR は Phase C の最小スコープとして、shell (Suspense 外側) を即時 flush + 各
Suspense boundary を後追いで埋める形の streaming SSR を導入する。

## 採用方針 (要約)

- **streaming model**: shell + tail (out-of-order の簡易版)
  - shell flush 後、全 resource を `Promise.allSettled` で待ってから boundary
    fill chunk を順次 enqueue。out-of-order full streaming (resolve 順 flush) は
    将来の最適化候補
- **新 API**: `@vidro/core/server` から `renderToReadableStream(fn)` を export。
  WinterCG `ReadableStream<Uint8Array>` を返す
- **Suspense server mode 拡張**: streaming context があるとき
  - children を 1 度評価して fetcher を集める (markup は捨てる)
  - shell には `<!--vb-${id}-start-->fallback<!--vb-${id}-end--><!--suspense-->`
    の comment marker pair で fallback を囲んで出す
  - boundary registry に `{id, childrenFactory}` を保存
  - tail で resolved scope の元 children を再 render → `<template>` + fill script
- **bootstrap data**: shell には router 部分のみ (`pathname/params/layers`) を
  `<script id="__vidro_data" type="application/json">` で inject。resources は
  全 resolve 後に inline patch script (`__vidroSetResources(...)`) で書き加え
- **inline runtime**: `__vidroFill(id)` / `__vidroSetResources(r)` は core が
  `VIDRO_STREAMING_RUNTIME` として export、router/server の `<head>` に 1 回
  inject (~600B)
- **hydration**: 段階 hydration はやらない。default の DOMContentLoaded 待ち
  (`<script type="module">` の defer 動作) で全 chunk 受信後に 1 回 hydrate

## 論点と決定

### 論点 1: streaming model

- 案 A: out-of-order full (React 18 / Solid 風) — resolve 順に boundary fill
- 案 B: in-order — Suspense は resolve まで block、shell の旨味だけ取る
- **案 C (採用): shell + tail** — shell 即 flush、全 resolve 後に boundary 連続
  flush

採用理由:

- toy として実装が一番シンプル (resolve 順管理 + per-boundary 個別 await が要らない)
- TTFB / FCP のメリット (shell + fallback が即時表示) は確保できる
- out-of-order full は将来の最適化として `pending_rewrites` に記録

### 論点 2: API 形

`renderToReadableStream(fn): ReadableStream<Uint8Array>`

- caller (router/server.ts) は shell prefix (head + body + `<div id="app">`) を先に
  enqueue → core stream を pipe → shell suffix (`</div></body></html>`) を末尾 enqueue
- core が「app shell + bootstrap resources patch + boundary fills」だけを担当する
  形で責務分離。`<div id="app">` の境界は core は知らない

### 論点 3: Suspense server mode の動作分岐

Suspense の `renderer.isServer` 分岐は streaming context の有無で 2 経路:

| context                   | 動作                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `getCurrentStream()` あり | boundary 化: children 評価で fetcher 収集 + fallback を `<!--vb-${id}-start/end-->` comment marker pair で囲む |
| `getCurrentStream()` なし | 既存 (renderToStringAsync 内 / B-5b) — children を sync 評価して直吐き                                         |

これにより `renderToStringAsync` 経路 (= 既存テスト) は無変更で動き続ける。

### 論点 4: boundary anchor の形

- 案 A: `<div data-vidro-boundary="b0">fallback</div>` — fill 時に `outerHTML` を
  template content と差し替え or `replaceWith(template.content)`
- 案 B: `<!--vb-${id}-start-->fallback<!--vb-${id}-end-->` — React 18 風 comment
  marker pair

**案 B 採用**。理由は **hydrate cursor 整合**。client mode の Suspense は
fragment + `<!--suspense-->` anchor を返す。SSR 出力を `<div>` ラッパーにすると
client 側 fragment 出力と DOM 構造が乖離して hydrate cursor が壊れる。comment
marker なら fill 時に start/end も remove できるので、fill 完了後の DOM は
`children markup<!--suspense-->` となり client fragment 出力と整合する。

`__vidroFill` は `document.createNodeIterator(SHOW_COMMENT)` で start/end を
linear scan して取得し、間の sibling を template content と差し替える。anchor
querySelector が使えない代わりに NodeIterator 1 走査で済む (boundary 数 N に
対し O(全 comment 数 × N)、toy では十分)。

### 論点 5: bootstrap data の段階送り

- 案 A: shell に空の `__vidro_data` (resources field 抜き) を inject、resolve 後
  に inline patch script で `__vidro_data` の textContent を上書き
- 案 B: shell + 各 boundary chunk と一緒に partial bootstrap を出す
  (resources["k"] を逐次追加)
- 案 C: 全 resources 揃ってから 1 個の `<script id="__vidro_data">` を出す

**案 A 採用**。理由:

- Router の `readBootstrapData()` は module load 時に呼ばれるが、main.tsx は
  `<script type="module">` の defer 動作で DOMContentLoaded 待ち = streaming 完了
  待ち。だから patch script が boundary fill より前に到達してれば必ず間に合う
- 案 B は per-boundary key 追跡が複雑、案 C は shell に bootstrap (router 部分も)
  載せられないので Router の sync 初期化が壊れる

### 論点 6: hydration 段階性

- 段階 hydration (boundary fill ごとに該当部分だけ hydrate) は実装が大きい:
  - HydrationRenderer の cursor を boundary 単位に切り出す必要
  - Resource constructor が late-arriving bootstrap value を引き受ける mechanism
- **採用**: 全 chunk 受信後に 1 回 hydrate。toy は `<script type="module">` の defer
  動作を活用、main.tsx は無変更で済む
- 段階 hydration は将来の最適化として `pending_rewrites` に記録

### 論点 7: ネスト Suspense

- 内側 Suspense は streaming context 解除済みの boundary-pass で再 render される
  ため、**内側は既存 (renderToStringAsync 互換) 動作で children 直吐き**
- これで OK な理由: 外側 boundary が tail で fill される時点で全 resource は
  resolve 済 → 内側 Suspense の children も hit 経由で markup 完成 → blink なし
- 内側 Suspense を **個別の chunk** として後追い flush したいなら out-of-order
  full 化が必要 (将来案件)

### 論点 8: boundary-pass の renderer / Owner

- `renderToString(b.childrenFactory)` を boundary-pass で呼ぶ。これは新しい Owner
  - serverRenderer setRenderer + ResourceScope は外側 (caller) が wrap で active
- streaming context は **解除** (= boundary-pass で内側 Suspense が boundary 化
  しないように)
- onMount は server で flush しない (renderToString の既存挙動)

### 論点 9: error handling

- shell-pass throw → core の `start(controller)` 内で起こる。toy minimum では
  `controller.error(err)` で stream を中断 (response 既に開始済みなので Phase A
  degrade はやらない)。実用化時は shell-pass を sync 段階で先行実行して
  try/catch で degrade する 2 段階 API に再設計する余地あり (将来案件)
- boundary-pass throw → 該当 boundary の fill を skip (start/end marker と
  fallback はそのまま表示、client が hydrate 後に refetch すれば回復)。個別
  boundary の error 通知は将来案件

## 実装ステップ

| Step | 内容                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C-1a | `packages/core/src/streaming-scope.ts` 新規 — `StreamingContext` + `runWithStream` + `getCurrentStream`                                                                  |
| C-1b | `packages/core/src/render-to-string.ts` に `renderToReadableStream(fn)` 追加 — shell + bootstrap patch + boundary chunks を enqueue                                      |
| C-1c | `packages/core/src/server.ts` に `renderToReadableStream` を re-export                                                                                                   |
| C-2a | `packages/core/src/suspense.ts` に streaming branch 追加 — `getCurrentStream()` 取得時のみ boundary 化                                                                   |
| C-2b | `packages/router/src/server.ts` の `handleNavigation` を streaming 経路に切替 — `renderToStringAsync` → `renderToReadableStream` で response body を `ReadableStream` に |
| C-2c | inline runtime (`__vidroFill` / `__vidroSetResources`) を `VIDRO_STREAMING_RUNTIME` として export、router/server.ts が `<head>` に inject (core stream は #app 中身のみ) |
| test | `packages/core/tests/render-to-readable-stream.test.ts` 新規 (jsdom + chunk 連結 → DOM 検証)                                                                             |
| 実機 | router-demo の `users/[id]` で wrangler + Playwright、shell + fallback 即表示 → posts fill を確認                                                                        |

## 最適化候補 (将来)

`memory/project_pending_rewrites.md` に追記する:

- **out-of-order full streaming**: resolve 順に boundary を flush。重い fetch が
  軽い fetch を block しなくなる。Suspense + ResourceScope に「per-boundary
  fetcher 群」の対応が必要
- **段階 hydration**: boundary fill のたびに該当部分を hydrate。Resource
  constructor が late-arriving bootstrap を引き受ける mechanism + HydrationRenderer
  の partial cursor 化
- **boundary anchor 統合**: client mode の Suspense `<!--suspense-->` anchor と
  streaming SSR の `<!--vb-${id}-start/end-->` を 1 種類に揃える (現状は
  `__vidroFill` で start/end remove 後に `<!--suspense-->` 1 個だけ残る形)
- **per-boundary partial bootstrap**: boundary chunk と一緒に該当 resource の
  bootstrap も出す (起点 boundary だけ早く hydrate 可能に)
- **error 通知**: boundary-pass で throw した場合に client へ通知して refetch /
  fallback 維持を選ぶ
- **CPU**: 1-pass 化 (VNode mutation で fetcher 待ちで穴埋め) — ADR 0030 論点 2

## 影響範囲

- `@vidro/core`: 新ファイル `streaming-scope.ts`、`render-to-string.ts` に追加
  関数、`suspense.ts` の `isServer` 分岐に `if (stream)` 追加、`server.ts` re-export
- `@vidro/router`: `server.ts` の `handleNavigation` のみ書き換え。loader gather
  / preload / data injection 順序は変更なし
- `apps/router-demo`: 変更不要 (main.tsx は既に hydrate)。`users/[id]` の Suspense
  - createResource を実機検証台に流用

## トレードオフ

- 採用案 (shell + tail): 実装シンプル、TTFB / FCP 改善あり、段階 hydration なし
- 不採用案 (out-of-order full): 完全な streaming 体験、ただし実装大幅増 — 後で
  上書きしやすいよう `StreamingContext` の API は per-boundary 拡張余地を残しておく
