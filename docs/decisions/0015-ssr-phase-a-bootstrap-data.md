# 0015 — SSR Phase A: bootstrap data injection で初回 fetch をスキップ

## Status

Accepted — 2026-04-24

## Context

ADR 0014 で prod build が Cloudflare Workers で動くようになり、初回 navigation
は以下の 3 往復を辿っていた:

1. Browser → Worker → `env.ASSETS.fetch` で index.html 取得・返却
2. Browser → asset `index-*.js` (bundle) 取得
3. Browser → Worker `/__loader?path=...` で loader JSON 取得

真の SSR (HTML まで server render) は JSX runtime の isomorphic 化が必要で
大仕事。その前段として、**loader data だけ server で完結させて index.html に
inline する** Phase A を入れ、初回 navigation を 3 → 2 往復に減らす。

HTML render は client 側に残すので、JSX runtime は無改変で済む。Phase B (真の
SSR) に進む時はこの bootstrap data inject は **そのまま流用**され、hydration
時の props 復元源になる。

論点は 5 つ:

1. data injection のフォーマット (JSON script vs `window.__X__` vs 他)
2. navigation / loader / asset の振り分け判定
3. `createServerHandler` の signature 変更
4. dev 側も inject を入れるかどうか
5. wrangler 側の routing 設定 (Worker vs asset 直配信)

## Options

### 論点 1: data injection のフォーマット

- **1-A.** `<script type="application/json" id="__vidro_data">{...}</script>` を
  `</head>` 直前に inject、client は `document.getElementById("__vidro_data").textContent`
  を `JSON.parse` (Next.js の `__NEXT_DATA__` と同じ)
- **1-B.** `<script>window.__VIDRO_DATA__ = {...};</script>` (Remix 式)。
  `</script>` 含みの文字列を escape する必要
- **1-C.** `<meta>` に base64 埋め (長い data で size 増)

### 論点 2: 振り分け判定

- **2-A.** `Accept: text/html` ヘッダを含む request を navigation とみなす
  (Remix / Next / SvelteKit 式)
- **2-B.** URL 末尾に拡張子が無ければ navigation
- **2-C.** `User-Agent` の browser 判定 (脆い)

### 論点 3: `createServerHandler` の signature

- **3-A.** `{manifest}` factory + per-request `(req, ctx?)` で `ctx.assets`
  を注入。module scope で compile を 1 回だけ、per-request で env を渡す
  (Breaking: 現行 `createServerHandler(manifest)` から変更)
- **3-B.** per-request factory で `createServerHandler({manifest, assets})` を
  毎回生成 (compile も毎回、無駄)
- **3-C.** 新関数 `createNavigationHandler` を足して現行は触らない (追加のみ)

### 論点 4: dev 側も inject するか

- **4-A.** prod のみ (Workers Assets + handler が揃う prod 環境で効かせる)、
  dev は vite が index.html を素直に serve、client は従来通り fetch
- **4-B.** dev でも vite middleware で inject して挙動統一

### 論点 5: wrangler の routing

- **5-A.** `run_worker_first = true` (boolean) で全 request を Worker に流し、
  entry が handler → `env.ASSETS.fetch` の順で処理
- **5-B.** `run_worker_first = ["/*", "!/assets/*"]` (glob 配列) で hash 付き
  static だけ Worker skip (wrangler 4.23+ 必要)
- **5-C.** `run_worker_first` 未指定 (default = false) で asset hit は Worker
  を bypass → navigation (`/`) が hit して **Phase A inject が効かない**

## Decision

- 論点 1 → **1-A (JSON script tag)**
- 論点 2 → **2-A (Accept header)**
- 論点 3 → **3-A (breaking: factory + per-request ctx)**
- 論点 4 → **4-A (prod のみ)**
- 論点 5 → **5-A (`run_worker_first = true`)**

### `createServerHandler` の新 signature

```ts
export type ServerContext = {
  assets?: { fetch(request: Request): Promise<Response> };
};

export type ServerHandler = (request: Request, ctx?: ServerContext) => Promise<Response>;

export function createServerHandler(options: {
  manifest: RouteRecord;
  endpoint?: string; // default: "/__loader"
}): ServerHandler;
```

handler 内の分岐:

1. `/__loader` endpoint → 従来通り loader JSON
2. `Accept: text/html` + `ctx.assets` あり → navigation処理:
   a. `gatherRouteData(pathname, compiled)` で全 layer loader を並列実行
   b. `ctx.assets.fetch(new Request(origin + "/index.html"))` で index.html 取得
   c. `</head>` 直前に `<script type="application/json" id="__vidro_data">{...}</script>`
   を inject (JSON 内の `<` は `<` に escape)
   d. 200 + `text/html` で返却
3. それ以外 → 404 (entry 側で `env.ASSETS.fetch` に委譲)

### entry template (Phase A 対応版)

```ts
import { createServerHandler } from "@vidro/router/server";
import { routeManifest } from "./route-manifest";

type Env = { ASSETS?: { fetch: (request: Request) => Promise<Response> } };
const handler = createServerHandler({ manifest: routeManifest });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await handler(request, { assets: env.ASSETS });
    if (response.status !== 404) return response;
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not Found", { status: 404 });
  },
};
```

### Router 側の consume

module load 時に 1 回だけ `__vidro_data` を読んで `bootstrapData` に保持、
初回 `fetchLoaders(pathname)` で pathname 一致時に consume:

```ts
let bootstrapData = readBootstrapData();

async function fetchLoaders(pathname) {
  if (bootstrapData && bootstrapData.pathname === pathname) {
    const boot = bootstrapData;
    bootstrapData = null; // consume
    return boot.layers.map(hydrate);
  }
  const res = await fetch(`/__loader?path=${encodeURIComponent(pathname)}`);
  // ... 従来経路
}
```

`bootstrapData.pathname` は `window.location.pathname` を module 読み込み時に
snap する。`el.remove()` で DOM からも剥がす (2 度読み防止)。

### wrangler.toml

```toml
[assets]
directory = "./dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = true
```

`run_worker_first = true` で全 request を Worker 経由にする。entry が handler
→ `env.ASSETS.fetch` の 2 段で振り分けるので、static asset も正しく配信される。
新しい wrangler (4.23+) では `run_worker_first = ["/*", "!/assets/*"]` で
static だけ Worker skip できる (microbenefit)。

## Rationale

### 論点 1: 1-A (JSON script)

- `<` escape だけで XSS 安全。`</script>` を含む任意の文字列が入っても壊れない
- client 側は `JSON.parse(el.textContent)` 1 行で取れる
- Next.js `__NEXT_DATA__` と同じ形で、将来引き継ぎやすい

### 論点 2: 2-A (Accept header)

- Browser の navigation は必ず `Accept: text/html` を送る (HTTP 仕様上も)
- API client (fetch / XHR) は `Accept: application/json` か none なので自然に
  除外される
- 拡張子判定は `/users/1.txt` のような未定義 extension 付き path を誤判定しうる

### 論点 3: 3-A (factory + per-request ctx)

- compile は manifest 固定なら **module scope で 1 回だけ**が最適。per-request
  factory (3-B) だと navigation ごとに compileRoutes が走って無駄
- `ctx.assets` は per-request (Cloudflare Workers は `env` を `fetch(req, env)`
  で渡す設計)。factory で固定できない
- 新関数追加 (3-C) は API 表面が増える + dev/prod で別経路になって DRY 崩れる
- 現行 `createServerHandler` の呼び出し元は plugin の dev middleware + 生成
  template のみで、breaking 影響が狭い

### 論点 4: 4-A (prod のみ)

- dev の client-side fetch は vite の HMR と相性が良く、遅くない。Phase A の
  体感改善は prod の cold start で最大化する
- vite の `transformIndexHtml` hook で per-request inject を入れるのは可能
  だが、plugin 実装が増える + dev 独自経路が生まれる
- Phase B (真の SSR) で dev / prod の inject / render を揃える時に再検討する

### 論点 5: 5-A (`run_worker_first = true`)

- default (`false`) は asset hit を Worker 経由しない = navigation (`/`) で
  index.html が直接返り **inject が効かない** (実測した)
- wrangler 4.1.0 (ローカルで pin) は `run_worker_first` が boolean のみ
  受け入れる。glob 配列は 4.23+ 必要
- `true` で全 request を Worker に通しても、hash 付き asset は
  `env.ASSETS.fetch` 経由で 1 ms 以内に返るので overhead は無視できる
- 将来 wrangler を上げたら glob 配列 (5-B) で micro-optimize できる

## Consequences

### 実装

- `packages/router/src/server.ts`
  - `createServerHandler({manifest, endpoint?})` に breaking change
  - `gatherRouteData(path, compiled)` を内部共有関数として分離
  - navigation handler 追加 (`injectBootstrapData` で `</head>` 直前に inject)
- `packages/router/src/router.tsx`
  - module scope で `readBootstrapData()` を 1 回呼ぶ
  - `fetchLoaders` 先頭で `bootstrapData` を consume
- `packages/plugin/src/route-types.ts`
  - `renderServerEntry()` の template を新 signature 対応 (per-request ctx)
- `packages/plugin/src/server-boundary.ts`
  - dev middleware も新 signature (`createServerHandler({manifest})`) に追従、
    `ctx` は渡さない (dev の index.html serve は vite 本体に任せる)
- `apps/router-demo/wrangler.toml`
  - `run_worker_first = true` 追加

### 動作確認 (Playwright)

- `/users/5` fresh load → `/__loader` fetch **0 件**、User 5 詳細描画
- `/users/999` fresh load → `/__loader` fetch **0 件**、layer error 表示
- `/does-not-exist` fresh load → `/__loader` fetch **0 件**、404 表示
- 同 session 内の link click (`/users/1`) → `/__loader` fetch **1 件** (bootstrap
  consume 後は従来経路)
- `/assets/*.js` → 200 application/javascript (Worker 経由でも static 配信)

### 制約・既知の課題

- **Phase A は HTML body を render しない**: `<div id="app"></div>` は空で
  返り、client JS が起動するまで blank。First Contentful Paint は Phase A
  では改善しない。Phase B で renderToString を実装すると blank が解消
- **Accept header を持たない fetch (curl 等) は navigation 判定されない**:
  brower-external からの hit は handler が 404 を返し、entry の assets
  fallback 経路に回る。index.html が返るので表示は可能だが inject は効かない
- **bootstrap data の pathname 一致判定**: `window.location.pathname` と
  module load 時点の path を比較する。popstate や replaceState で path が
  すでに変わってる unusual case では consume されず fetch 経路に fallback
- **run_worker_first = true の overhead**: static asset も Worker 経由になる
  が、Cloudflare の Worker startup は ~1 ms で体感差は無い。glob 配列
  (wrangler 4.23+) への切り替えは後で検討
- **dev 側は inject 無し**: dev で開発してる間は client-side fetch がデフォ
  挙動で、prod と挙動差がある。Phase B で揃える

### 設計書への影響

- 3.7「Loader と並列 fetch」の章に「Phase A: bootstrap data injection」
  サブセクションを足す
- 真の SSR 実装は 3.x「Rendering model」の isomorphic 化が前提条件、として
  設計書の未決セクションにフィードバック

## Revisit when

- **Phase B (真の SSR) に着手する時**: JSX runtime を isomorphic 化、
  `renderToString(jsx)` を `@vidro/router/server` に追加、entry template の
  navigation 分岐に挿入。Phase A の bootstrap data inject は **そのまま残す**
  (hydration 時の props 復元源)
- **Accept header を使わない client (モバイル native) がメインターゲットに
  なった時**: 判定を拡張子ベースと併用する mode を足す
- **wrangler を 4.23+ に上げる時**: `run_worker_first` を glob 配列に変えて
  hash 付き asset だけ Worker skip。microbenefit だが Worker invocation 数が
  下がる (課金インパクト)
- **bootstrap data が大きくなり過ぎた時**: 100KB 超で TTFB に影響し始める。
  必要なら layer 別に stream (Phase C) か、loader 結果の size guard を plugin
  で付ける
- **custom Error subclass を保持したくなった時**: ADR 0014 と同じく、plain
  object 往復を devalue / superjson に差し替え (serialize / hydrate 両側)
