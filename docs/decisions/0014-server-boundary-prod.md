# 0014 — Server boundary (prod): route manifest + 2nd pass ssr build + SPA fallback

## Status

Accepted — 2026-04-24

## Context

ADR 0012 で dev 側 (`vite dev` + `ssrLoadModule`) の `/__loader` RPC と client
bundle stub が整った。**prod build を Cloudflare Workers に乗せるための
"B-2" フェーズ** として、以下を実装する:

1. 動的 fs walk ができない prod 環境向けに、`.server.ts` / `layout.server.ts`
   を **静的 import で固めた route manifest** を build 時に生成する
2. dev の `/__loader` middleware で使っている loader 並列実行ロジックを、
   WinterCG fetch handler として dev / prod の両方で使い回せる形に切り出す
3. `vp build` を **client + server の 2 pass** にし、Workers で直接実行できる
   `dist-server/index.mjs` を 1 コマンドで生成する
4. client bundle (SPA) + server bundle (loader endpoint) を Cloudflare Workers
   Assets の `not_found_handling = "single-page-application"` と組み合わせ、
   1 つの Worker が navigation / static / loader を全部さばけるようにする

CSR only の現段階では Worker は「static に hit しない request = SPA
fallback」の受け皿でもある。SSR 実装時はこの受け皿が HTML render に差し替わる
(entry の骨格は共通)。

論点は 5 つ:

1. prod の route manifest をどう静的化するか
2. dev / prod で loader 実行ロジックを共有する形
3. client / server の 2 pass build の自動化手段
4. server entry template の位置付け (誰が書く / 完全固定 / 拡張点)
5. SPA fallback の責務 (Worker 側 vs wrangler 側)

## Options

### 論点 1: route manifest の静的化

- **1-A.** `routeTypes()` plugin (ADR 0011) を拡張し、`.vidro/route-manifest.ts`
  として **`server.ts` / `layout.server.ts` を静的 import + `RouteRecord`**
  を export する形で emit。tsx 系は stub (`() => Promise.resolve({})`)
- **1-B.** 別 plugin (`routeManifest()`) を新設、routeTypes() と二段構え
- **1-C.** dev と同じく runtime で `import.meta.glob()` を使う
  (prod でも vite が静的 import に inline してくれる)

### 論点 2: loader 実行ロジックの共有

- **2-A.** `@vidro/router` に `/server` subpath を生やし、`createServerHandler(manifest): (req: Request) => Promise<Response>`
  を WinterCG fetch handler として export。dev (vite middleware) は
  Node req/res を `Request`/`Response` に変換してから呼ぶ
- **2-B.** `@vidro/plugin` 内に handler 実装を持ち、router は client 側
  だけに専念
- **2-C.** dev と prod で別実装 (DRY 違反だが自由度高)

### 論点 3: 2 pass build の自動化

- **3-A.** `serverBoundary()` の `closeBundle` hook で vite の programmatic
  `build()` を呼んで 2nd pass を実行。`build.ssr` が立ってる時は即 return
  で再帰阻止
- **3-B.** user が `vp build && vp build --mode server` を 2 回叩く
- **3-C.** 環境変数 `VIDRO_SSR=1` で条件分岐する script を README に掲載

### 論点 4: server entry template

- **4-A.** plugin が `.vidro/server-entry.ts` を **完全固定 generate**
  (SolidStart / SvelteKit / Nuxt の adapter 式)
- **4-B.** scaffold 方式 (初回だけ `src/entry.server.ts` に吐いて user が owns)
  — Remix 式
- **4-C.** user が自分で fetch handler を書く (Hono、TanStack Start、素の Workers)
- **4-D.** entry は隠し、`hooks.server.ts` のような副次 API で extension
  (SvelteKit / Astro 式)

### 論点 5: SPA fallback の責務

- **5-A.** entry 内で分岐: `/__loader` は handler、それ以外は `env.ASSETS.fetch(request)`
  に委譲。wrangler 側は `not_found_handling = "single-page-application"` +
  `binding = "ASSETS"` のみ
- **5-B.** wrangler 側で `run_worker_first = ["/__loader", "/__loader/*"]`
  を指定、entry は `{ fetch: createServerHandler(routeManifest) }` のまま
  3 行で済ませる

## Decision

- 論点 1 → **1-A (`routeTypes()` に合成)**
- 論点 2 → **2-A (`@vidro/router/server` として export)**
- 論点 3 → **3-A (`closeBundle` で programmatic 2nd pass)**
- 論点 4 → **4-A (plugin が完全固定 generate)**。将来 user 拡張欲が出たら
  `src/entry.server.ts` があればそちらを優先する **A with C override** に
  移行、もしくは **4-D (hooks)** 併用で受ける
- 論点 5 → **5-A (entry 側で分岐 + `env.ASSETS.fetch` fallback)**

### 生成物 (`.vidro/`)

`routeTypes()` は以下を emit する (ADR 0013 に従い `.vidro/` 配下):

- `.vidro/routes.d.ts` — `RouteMap` augmentation (ADR 0011)
- `.vidro/route-manifest.ts` — `server.ts` / `layout.server.ts` の静的 import
  を並べた `RouteRecord` (tsx 系は stub)
- `.vidro/server-entry.ts` — 以下の固定 template

```ts
import { createServerHandler } from "@vidro/router/server";
import { routeManifest } from "./route-manifest";

type Env = { ASSETS?: { fetch: (request: Request) => Promise<Response> } };

const loaderHandler = createServerHandler(routeManifest);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__loader")) {
      return loaderHandler(request);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not Found", { status: 404 });
  },
};
```

### `@vidro/router/server`

`createServerHandler(manifest, { endpoint? })` が dev / prod 共通の
WinterCG fetch handler を返す:

- 入力: `Request`
- `/__loader` 以外は 404 を返す (entry が assets fallback に回す前提)
- `/__loader?path=<pathname>` で matchRoute + 各 layer の loader を
  `Promise.all` で並列実行 (ADR 0012 と同じ response shape: `{params, layers}`)
- error serialize は plain object (`{name, message, stack}`) 往復、
  Router 側で hydrateError により `Error` インスタンスに復元 (ADR 0012)

### `serverBoundary()` の 2 pass build

`closeBundle` hook で以下の条件で vite の programmatic `build()` を呼ぶ:

- `config.command === "build"` (dev / preview は対象外)
- `config.build.ssr` が **未設定** (= 2nd pass 本体で再発火しても抜ける)

inline config:

```ts
{
  build: {
    ssr: ".vidro/server-entry.ts",
    outDir: "dist-server",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: { output: { entryFileNames: "index.mjs", format: "esm" } },
  },
  ssr: { target: "webworker", noExternal: true },
  resolve: { conditions: ["workerd", "worker", "browser"] },
}
```

`configFile` は未指定 → user の `vite.config.ts` を自動検出させて
`jsxTransform()` / `routeTypes()` を 2nd pass でも有効にする。
`noExternal: true` で Workers 向けに全 inline。

### wrangler 設定 (user 側で書く、Vidro 関与しない)

`apps/router-demo/wrangler.toml`:

```toml
name = "router-demo"
main = "./dist-server/index.mjs"
compatibility_date = "2026-04-17"

[assets]
directory = "./dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
```

Vidro はこれを自動生成しない。YAGNI、かつ user の deploy 設定は Vidro の
責務外。

## Rationale

### 論点 1: 1-A (routeTypes に合成)

- `routes/` を walk するのは ADR 0011 と全く同じ。plugin を分けると walk /
  watcher を 2 回書くことになり DRY 違反
- prod 向けの manifest と dev 向けの `routes.d.ts` は 1:1 で対応しており、
  同じ plugin が 2 つの出力を持つ方が watch trigger も揃って素直

### 論点 2: 2-A (router に server subpath)

- loader 実行本体 (compile + match + Promise.all + serialize) は **router の
  domain**。plugin にあると、dev middleware と prod server entry で同じ
  logic が `@vidro/plugin` に依存する形になり、責務が逆転する
- WinterCG fetch handler として切り出すことで、Cloudflare Workers の
  `export default { fetch }` 規約と一致。Node / Deno / Bun でも同じ handler
  が動く

### 論点 3: 3-A (closeBundle で 2nd pass)

- `vp build` 1 コマンドで両 bundle が出る UX が最短
- `build.ssr` フラグで再帰阻止が成立するので、追加 state を持たずに済む
- user は vite の programmatic build API を意識する必要が無い (plugin 内
  閉じ)

### 論点 4: 4-A (plugin が完全固定 generate)

- toy runtime 段階では **「Hono 的透明性」より「規約 > 設定」を優先**。
  entry を user に書かせると、単純なアプリでも最低 5 行のボイラープレートを
  強いることになり YAGNI 的に重い
- 将来 user が前処理 (auth middleware 等) を差したくなったら、`src/entry.server.ts`
  があればそちらを優先する A with C override で逃げ道を残せる。さらに
  規約的 extension が欲しければ 4-D (hooks) を足す
- SolidStart / SvelteKit / Nuxt も adapter で隠す方針。Vidro の default は
  それらに倣う

### 論点 5: 5-A (entry で `env.ASSETS.fetch` fallback)

- wrangler 側を **"一般的な SPA 設定"** に留められる (Vidro 特有の pattern
  指定不要)。`/__loader` は Vidro 内部実装の詳細であり、user の deploy 設定に
  漏らさない方が良い (将来 endpoint 変更しても wrangler 書き換え不要)
- SSR を後で足す時、else 分岐が `env.ASSETS.fetch` から `renderHTML(request)`
  に差し替わるだけで、entry 骨格は共通。**CSR 期間の暫定ではなく SSR 移行後も
  残る形**
- Worker 起動 overhead は Cloudflare では ~1ms、asset hit で Worker が呼ばれ
  ないことの benefit は microbenefit

## Consequences

### 実装

- `packages/router/src/server.ts` — `createServerHandler(manifest)` を
  export (ADR 0012 の `runLoader` / `serializeError` をここに移動、Step 1.2)
- `packages/router/package.json` の exports に `./server` subpath 追加、
  `vp pack` を multi-entry (`src/index.ts src/server.ts`) に
- `packages/plugin/src/route-types.ts`
  - `.vidro/route-manifest.ts` 生成 (Step 1.1)
  - `.vidro/server-entry.ts` 生成 (Step 1.3)
- `packages/plugin/src/server-boundary.ts`
  - dev middleware を `createServerHandler` 経由に差し替え (Step 1.2)
  - `closeBundle` hook で 2nd pass ssr build (Step 1.3)
- `apps/router-demo/wrangler.toml` — user サンプル、Vidro 関与しない

### 動作確認 (Step 1.4)

`vp build` → `wrangler dev --port 8788` 起動 → curl + Playwright で
全 route 回帰:

- `/__loader?path=/users/1` → 200 + `{params, layers}` (success)
- `/__loader?path=/users/999` → 200 + leaf error (3 layers、層別伝播)
- `/__loader?path=/broken-loader` → 200 + layout error
- `/__loader` (no path) → 400
- `/other` (Worker 経由 endpoint 外) → assets fallback で index.html
- `/assets/*.js` → asset 直接返却
- `/users/5` の fresh load (SPA fallback → client JS → loader fetch) → ユーザー
  詳細まで正常描画

### 制約・既知の課題

- **SSR 未実装**: Worker が HTML を render しないので、初回表示までに
  index.html → client JS → loader fetch の 3 往復がある。SSR 実装時に entry
  の else 分岐が HTML render に差し替わる
- **`env.ASSETS` の型**: entry template は `type Env = { ASSETS?: ... }` の
  ad-hoc 型で済ませている。Cloudflare 固有の bindings を増やし始めたら
  user に `Env` を定義させる拡張点になる
- **wrangler.toml は user が書く**: Vidro は deploy 設定に関与しない。
  `main` / `[assets]` の最小構成を ADR に載せることで指針は示す
- **Node.js compat flags 未設定**: 現状の router-demo は `fetch()` のみ使い
  Workers native で完結するが、loader で Node API が必要になったら user が
  `compatibility_flags = ["nodejs_compat"]` を入れる必要あり
- **server entry template 固定**: user が拡張 (auth middleware 等) を差し
  たくなった時は **A with C override** (`src/entry.server.ts` があればそれを
  優先) か **hooks** で受ける。どちらも未実装、具体要求が出たら足す
- **closeBundle の再帰阻止**: 2nd pass も同じ user vite.config.ts を読む
  ので、`jsxTransform()` / `routeTypes()` / `serverBoundary()` が全て再実行
  される。`config.build.ssr` で抜けるのは `serverBoundary()` 側の closeBundle
  だけで、`routeTypes()` の generate は 2nd pass でも動く (冪等なので無害)

## Revisit when

- **SSR を実装する時**: entry template の else 分岐を `env.ASSETS.fetch` から
  `renderHTML(request)` に差し替え。manifest の tsx 系 stub を実 import に
  昇格 (index.tsx / layout.tsx / error.tsx / not-found.tsx を server 側でも
  load できるように)。SSR pipeline は `@vidro/router/server` の別 handler
  として追加、entry は `createServerHandler` と合わせて両対応
- **Cloudflare 以外の adapter が必要になった時**: Node (Hono/Express)、Deno、
  Bun、Vercel Edge、Netlify Edge、AWS Lambda@Edge 等。WinterCG fetch handler
  なのでほぼ wrap だけで済む。adapter package (`@vidro/adapter-node` 等)
  を切り出すか、user が自分で薄く書くかは要件次第
- **custom Error subclass を保持したくなった時**: ADR 0012 の hydrateError
  は plain object 往復。devalue / superjson 相当で class 情報を保持できる
  ようにする
- **user が entry を拡張したくなった時**: `src/entry.server.ts` があれば
  plugin の auto-generate より優先する A with C override を入れる。
  もしくは `hooks.server.ts` 的な副次 API で middleware chain を受ける
- **wrangler 設定を自動生成したくなった時 (NG 方向だが)**: user が自分で
  書く負担が大きくなった場合、`wrangler.toml` template を `.vidro/` に
  吐く option を付ける可能性。ただし deploy 設定は user 領域というのが
  現状の方針 (個人開発の CLAUDE.md にも YAGNI)
