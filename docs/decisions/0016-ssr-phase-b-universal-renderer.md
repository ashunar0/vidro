# 0016 — SSR Phase B: Universal renderer 抽象化 + hydration 戦略方針

## Status

Accepted — 2026-04-24

## Context

ADR 0015 で SSR Phase A (bootstrap data injection) まで済み、次は真の SSR
(Phase B) に入る。Phase A では HTML render を client 任せにしていたので、
`<div id="app">` は空のまま client bundle 起動まで blank だった。Phase B では
server で HTML まで組み立てることで First Contentful Paint を改善する。

現行 JSX runtime (`packages/core/src/jsx.ts`) は `document.createElement` /
`createDocumentFragment` / `createTextNode` / `addEventListener` を直接呼ぶ
「DOM 専用 renderer」として書かれている。Cloudflare Workers には `document`
が存在しないため、そのままでは server で JSX を評価できない。

このため Phase B に入る前に、runtime の rendering 抽象化方針 + hydration 戦略

- server output 形式を一度に決めておく必要がある。Step B-1 (本 ADR) は抽象化
  の I/F を入れるのみで、server renderer / renderToString / hydrate は Step B-2
  以降で実装する。

論点は 6 つ:

1. rendering approach: universal renderer vs linkedom shim vs 専用 renderer
2. server output の中間表現: object tree vs string buffer
3. hydration 戦略: full / fine-grained / islands / resumability
4. Renderer I/F の shape: flat functions vs object methods
5. Renderer の差し替え機構: global module state vs per-call DI
6. effect / onMount の server 側挙動

## Options

### 論点 1: rendering approach

- **1-a (universal renderer)**: DOM 依存を I/F (`createElement` 等) で抽象化し、
  client = `document.*` 呼び出し、server = 独自実装を差し替える
- **1-b (linkedom shim)**: Workers に `linkedom` を bundle して `document` を
  擬似供給、現行 runtime をそのまま動かす
- **1-c (SSR 専用 renderer)**: server 用に JSX runtime を別途実装、client runtime
  と分離する

### 論点 2: server output の中間表現

- **2-a (object tree)**: `{tag, attrs, children}` の JS object tree を組み立て、
  最後に walk して HTML string にする (React/Vue 式)
- **2-b (string buffer)**: HTML string を直接 concat、中間 tree を持たない
  (Solid / Svelte / Astro 式)

### 論点 3: hydration 戦略

- **3-a (full hydration, React)**: client で VDOM を再構築して既存 DOM と diff
- **3-b (fine-grained hydration, Solid)**: DOM は再生成せず、effect と event
  handler だけ既存 DOM に attach
- **3-c (islands, Astro)**: hydrate 対象を `<Island>` で明示、それ以外は静的
- **3-d (resumability, Qwik)**: hydration しない、lazy load で実行再開

### 論点 4: Renderer I/F の shape

- **4-a (flat functions)**: `createElement(tag)` / `appendChild(p, c)` 等を
  top-level export。tree shaking 有利
- **4-b (object methods)**: `renderer.createElement(tag)` の object method 集合。
  複数 renderer の差し替えが素直 (object 参照を swap)

### 論点 5: Renderer の差し替え機構

- **5-a (global module state)**: `let currentRenderer = browserRenderer;`,
  `setRenderer()` で差し替え。h() は module state を参照
- **5-b (per-call DI)**: h(renderer, type, props, children) で毎回渡す
- **5-c (AsyncLocalStorage / Context)**: 非同期 scope 単位で renderer を切り替え

### 論点 6: server 側の effect / onMount 挙動

- **6-a (1 回走らせて捨てる)**: effect body を同期実行、subscribe は行わない。
  onMount は queue に積むが flush しない (実質 no-op)
- **6-b (全て no-op)**: effect body すら走らせない。reactive な初期値は
  component 内で手動で unwrap する必要
- **6-c (server で fully subscribe)**: effect を通常通り subscribe、request が
  返った後に手動 dispose

## Decision

- 論点 1 → **1-a (universal renderer)**
- 論点 2 → **2-a (object tree) from v1、将来 2-b (string buffer) へ reshape**
- 論点 3 → **3-b (fine-grained hydration)**
- 論点 4 → **4-b (object methods)**
- 論点 5 → **5-a (global module state)**
- 論点 6 → **6-a (1 回走らせて捨てる)**

### Renderer I/F (packages/core/src/renderer.ts)

```ts
export type Renderer<N = unknown, E extends N = N, T extends N = N> = {
  createElement(tag: string): E;
  createText(value: string): T;
  createFragment(): N;
  createComment(value: string): N;
  appendChild(parent: N, child: N): void;
  setAttribute(el: E, key: string, value: string): void;
  removeAttribute(el: E, key: string): void;
  /** value / checked / selected など DOM property として扱うべき prop */
  setProperty(el: E, key: string, value: unknown): void;
  setClassName(el: E, value: string): void;
  assignStyle(el: E, style: Record<string, unknown>): void;
  /** reactive text の値更新 (初回生成は createText) */
  setText(textNode: T, value: string): void;
  addEventListener(el: E, type: string, handler: EventListener): void;
};

let currentRenderer: Renderer = browserRenderer;
export function setRenderer(r: Renderer): void {
  currentRenderer = r;
}
export function getRenderer(): Renderer {
  return currentRenderer;
}
```

browserRenderer は `document.*` を呼ぶだけの薄い wrapper。`h()` 内の DOM 依存は
全部 `getRenderer()` 経由に書き換える。Node 型は `unknown` で緩く持ち、browser
実装では実 DOM Node が入る形になる。

### effect / onMount の server 挙動 (将来 server renderer 実装時)

- **effect**: `effect(fn)` は body を同期で 1 回実行、observer 登録せずに dispose
  する。Signal の `.value` を読んで `setText` / `setAttribute` を 1 回書けば、
  renderer tree にその時点の値が焼き付く。以後 Signal が変化しても追従しない
- **onMount**: `flushMountQueue()` が呼ばれないので queue に積まれたまま捨てる
- **Signal**: `.value` の読み書きは普通に動く (getter が値を返すだけ)。書き換え
  が発生しても subscribers が空なので何も起きない
- **addEventListener**: server renderer は no-op (handler を受け取って捨てる)

判定の仕組みは Step B-2 で決める。現行 effect は `observer.ts` の
`currentObserver` を使っているので、server モード時だけ subscription 経路を
skip する flag を足すか、renderer 側が effect を「登録しない」モードで包むか。

## Rationale

### 論点 1: universal renderer (1-a)

- linkedom shim (1-b) は「動かすだけ」の最小変更だが、Vidro の設計哲学
  (fine-grained reactivity + Hono 的透明性) と bundle size 圧縮の両方に逆行。
  SSR bundle に数百 kB の DOM shim を持ち込むのは toy runtime 段階でも過剰
- SSR 専用 renderer (1-c) は client / server で JSX runtime が二重管理になり
  DRY 違反。Vidro の 5 哲学「型貫通」にも反する (同じ JSX が同じ interface
  で両側動く保証が欲しい)
- universal renderer (1-a) は Solid / SolidStart で実証済みのパターン。
  hydration (fine-grained) と自然に接続する

### 論点 2: object tree (2-a) — ただし v1 のみ、v2 で string buffer に移行

- 技術的正解は string buffer (2-b)。Solid / Svelte / Astro が採用する方式で、
  Hono 的透明性 (output が HTML string そのもの) と bundle size / 速度の
  すべてで勝る。Cloudflare Workers 前提なら尚更
- しかし Step B-1 (renderer 抽象化) を string buffer で書き始めると、
  JSX transform の評価順に強く依存する落とし穴がある:
  - `<div {...spreadProps}>` のような attribute 後付け、reactive slot の初回
    評価順、children と attr の評価タイミング、すべてが buffer のカーソル
    位置と一致してないと HTML が崩れる
  - debug が効きにくい (tree なら console.log で構造が見える、buffer は壊れた
    string しか残らない)
- 現実解: **v1 は object tree で書き、挙動正しさを確定してから v2 で string
  buffer に reshape**。Renderer I/F は両方の実装が同じ shape でハマるよう
  設計済みなので、外側 (jsx.ts / component 書き手) への影響なく差し替え可能
- Suspense / streaming との相性は string buffer でも成立する (Solid が証明
  済み。placeholder + 後送り script で out-of-order resolve)。「tree 必須」
  論は誤認だった

### 論点 3: fine-grained hydration (3-b)

- Vidro は fine-grained reactivity + invoke-once を哲学に据えている。これは
  Solid と同根で、hydration も同じ道筋が必然:
  - component は 1 回しか評価しない → VDOM 再構築 (3-a) する道具がない
  - effect が DOM 直書き換え → diff (3-a) する道具もない
- Islands (3-c) は補助的に `<Island>` を将来追加できる余地として残すが、toy
  runtime 段階で最初から islands を要求するのは overkill
- Resumability (3-d) は TTI で神だが、serialize 規約 (`$()` boundary) が
  複雑で Vidro の「AI-native 規約」「型貫通」に摩擦を増やす。AI が境界を
  誤認識して壊しやすい。現段階では採用しない

### 論点 4: object methods (4-b)

- flat functions (4-a) は tree shaking 有利だが、Renderer を差し替える設計
  では複数実装を object 参照として swap するのが素直
- `const r = getRenderer(); r.createElement(...)` と local alias を取れば、
  関数呼び出しの overhead もほぼ消える (JIT が object method inline 化)
- Phase C (streaming) で renderer instance が scope 別に複数存在するように
  なった時、object reference の swap で扱える方が将来対応が楽

### 論点 5: global module state (5-a)

- Cloudflare Workers は **1 request 1 isolate (single-threaded)** で、global
  state の交錯は起きない。最もシンプルな方式で十分
- per-call DI (5-b) は h() の signature が崩れる (JSX transform の出力にも
  影響)
- AsyncLocalStorage (5-c) は同一 isolate 内で複数 request を並列処理する
  Node / Deno での使用が想定される。Workers primary target なら過剰
- setRenderer() を navigation 処理の入口で呼び、navigation 完了後に元に戻す
  (defensive reset) で十分

### 論点 6: effect は 1 回走らせて捨てる (6-a)

- reactive な初期値 (`{count.value}`) を HTML に焼き付けるには、effect body
  を 1 回は実行する必要がある。`body 実行 + subscribe なし` が最適解
- 6-b (effect すら走らせない) は、component 内で reactive slot を手動
  unwrap する必要があり、書き味が client と乖離する (同じ JSX で
  universal に動かない = 1-a の意図に反する)
- 6-c (server で fully subscribe) は dispose 忘れでメモリリーク、Workers
  では fatal

## Consequences

### 実装

#### Step B-1 (本 ADR で着地):

- `packages/core/src/renderer.ts` を新設
  - Renderer 型 export
  - browserRenderer object (`document.*` wrapper)
  - setRenderer / getRenderer module state
- `packages/core/src/jsx.ts` を書き換え
  - `document.createElement` → `getRenderer().createElement`
  - `createDocumentFragment` → `createFragment`
  - `createTextNode` → `createText`
  - `createComment` → `createComment` (renderer 経由)
  - `parent.appendChild` → `getRenderer().appendChild`
  - `el.setAttribute` / `removeAttribute` → renderer 経由
  - `el.className = ...` → `setClassName`
  - `Object.assign(el.style, ...)` → `assignStyle`
  - `(el as any)[key] = value` → `setProperty`
  - `text.data = ...` → `setText`
  - `el.addEventListener` → renderer 経由
- `mount()` 内の `target.appendChild(node)` / `node.parentNode?.removeChild(node)`
  は DOM 具体を扱う boundary なので **renderer 経由にしない** (target が
  Element 固定、mount は client only の API)
- `packages/core/src/index.ts` で `setRenderer` / `getRenderer` / `Renderer` 型
  を export
- browserRenderer 本体は **export しない** (public API を小さく保つ、Step B-2
  で stringRenderer を書く時に対で export を検討)

#### Step B-2 以降 (本 ADR の範囲外):

- server renderer (object tree 版) 実装
- `renderToString(jsx)` を `@vidro/router/server` に追加
- `createServerHandler` の navigation 分岐に `renderToString` を挿入
- effect の「1 回走らせて捨てる」モード実装 (Signal の subscribe 経路を skip)
- onMount の server 挙動 (queue 捨て)
- hydration API (`hydrate(fn, target)`) の実装
- hydration marker (`<!--#N-->` or `data-hk`) の発行と consume
- Playwright で FCP 改善確認 + hydration 正常動作確認

#### Step B-3 以降 (性能・完成度):

- object tree → string buffer への reshape (v2)
- Suspense + streaming (Phase C の範囲)

### 動作確認 (Step B-1 のみ)

client 挙動が一切変わらないことを確認:

- `vp check` (packages/core)
- `vp test` (packages/core) — 既存失敗 13 件は pre-existing、増えないこと
- `vp pack` (packages/core) で dist を再ビルド
- `apps/router-demo` で `vp build` + `wrangler dev` → Playwright で全 route
  正常描画、reactive 更新 (counter click 等) が動くこと
- `apps/website` で `vp dev` → Playwright で従来通り

### 制約・既知の課題

- **renderer global state の交錯**: server renderer と browser renderer を
  同一 isolate で並列に使わないこと。Cloudflare Workers では前提成立するが、
  Node / Deno adapter (将来) では AsyncLocalStorage への移行が必要になる
  可能性
- **v1 object tree の速度**: string buffer に比べて一時 object allocation が
  多い。toy runtime 段階では許容、ベンチで実測できたら v2 に移行
- **Renderer API の表面**: object methods 12 個は多め。必要になったら merge
  検討 (e.g. setAttribute / setProperty / setClassName を 1 つの `setProp` に
  統合 — ただし内部分岐の複雑さが増すので現状は分けたまま)
- **effect の subscribe 経路 skip**: 実装は Step B-2 で決める。`observer.ts`
  に mode flag を足す / effect 関数に server mode を渡す / renderer 側が
  effect を別 factory で包む、のいずれか。API 影響の最小な経路を採る
- **hydration marker の形**: Step B-2 / B-3 で決定。comment (`<!--v$N-->`)
  か attribute (`data-hk="N"`) か、あるいは両方併用。Solid は comment 派

### 設計書への影響

- 設計書「Rendering model」章に **Universal renderer** のサブセクション追加
- Phase A / B / C の 3 段階ロードマップを設計書に反映 (memory
  `project_ssr_phases` と突き合わせ)
- Hydration は fine-grained 方針で統一、Islands は将来追加余地として明記

## Revisit when

- **Step B-2 (server renderer 実装) 着手時**: 本 ADR の Decision が server
  側実装にどう落ちるかを実証。object tree の allocation 量が体感できるほど
  重いなら Step B-2 内で string buffer に前倒し
- **object tree → string buffer 移行時 (v2)**: 新 ADR 0017 (仮) で移行の
  Before / After と計測結果を残す
- **Node / Deno adapter を書く時**: global renderer state を AsyncLocalStorage
  に載せるか再検討。単一 request 単位の切り替えが並列呼び出しで破綻する場合
- **Islands architecture が必要になった時**: `<Island>` primitive を足し、
  fine-grained hydration との棲み分けを設計書と ADR で明文化
- **Qwik 型 resumability を再検討する時**: AI coding agent が serialize 境界
  を理解できる DX が整い、Vidro の「AI-native 規約」と両立する方式が見えた時
- **Renderer I/F の method が増える時**: 例えば SVG namespace / `createElementNS`
  が必要になったら `createElement(tag, namespace?)` に shape 変更、または
  `createSvgElement` を追加
