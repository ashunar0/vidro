# 0012 — Server boundary (dev): HTTP RPC + client bundle stub

## Status

Accepted — 2026-04-24

## Context

Router の loader (`server.ts` / `layout.server.ts`) は **server 上でのみ実行** され、
DB credential や server-only logic が client bundle に混ざってはいけない。
前 phase までは toy runtime として client 上で loader を直接 invoke していた
(server.ts も client bundle に含まれていた)。Phase "案 B" として、

1. dev server に HTTP endpoint を生やして loader を server 側実行する
2. client bundle から `.server.ts` / `server.ts` / `layout.server.ts` の中身を
   完全に剥がす

の 2 段を入れる。本 ADR は dev 段階 (vite dev + ssrLoadModule 経由) のみを扱い、
prod build (Cloudflare Workers / Node adapter) での server boundary は別 ADR
(B-2) に分ける。

論点は 4 つ:

1. **RPC スタイル**: Remix 式 (route 単位で全 loader を server が並列実行) vs
   tRPC 式 (loader ごとに個別 endpoint)
2. **endpoint 設計**: URL / query の形、response shape
3. **error の往復**: `throw new Error(...)` を loader が投げたとき、どう
   serialize して client に戻し、既存 `ErrorBoundary` / `err.message` 依存
   コードを壊さないか
4. **client bundle 除外の実装**: `resolveId` / `load` / vite environment API の
   どれで stub 化するか

## Options

### 論点 1: RPC スタイル

- **1-A.** Remix 式: Router が navigation ごとに `GET /__loader?path=/users/42`
  を 1 回叩き、server 側が該当 path の全 layer (root / users / :id) の loader を
  `Promise.all` で並列実行、結果を `{ layers: [...] }` で返す
  - client → server の HTTP は 1 route 1 回だけ (waterfall 最小)
  - server 側で loader 並列化を肩代わりするので、client 側 Router のコードが薄くなる
  - endpoint 設計が固定的 (loader 単位のカスタム routing 不可)
- **1-B.** tRPC 式: loader 1 つごとに endpoint、Router が必要な分だけ個別に fetch
  - loader ごとに独立 → 部分 revalidate に将来効く
  - 並列は client 側 Promise.all に戻るので、navigation ごとに N 個の HTTP が飛ぶ
    (HTTP/2 multiplexing 前提でも overhead 上乗せ)
  - endpoint 設計がファイル単位に増える

### 論点 2: endpoint 設計

- **2-A.** `GET /__loader?path=/users/42` → `{ params, layers: [{ data | error }, ...] }`
- **2-B.** `POST /__loader` body=`{ path: "/users/42" }` → 同上
  - GET だと CDN / dev middleware の cache 制御が効きやすいが、loader は mutation
    ではないので GET で問題無し

### 論点 3: error の serialize

- **3-A.** `{ name, message, stack }` plain object で JSON 往復、client 側で
  `new Error(message)` + `.name` / `.stack` 復元 (= hydrate)
  - 既存 `err instanceof Error` / `err.message` / `err.stack` のユーザーコードを
    一切壊さない
  - custom Error subclass の class 情報は剥がれる (name 文字列のみ残る)
- **3-B.** JSON そのまま payload として返す (`{ error: {...raw json} }`)
  - hydrate レイヤーが無い代わりに、ユーザーの `instanceof Error` が false 扱いに
    なる。ErrorBoundary fallback 含め広範囲に影響
- **3-C.** structuredClone / `superjson` / devalue 相当で class 情報も復元
  - 高機能、だが依存増 + toy runtime フェーズには重い

### 論点 4: client bundle 除外の実装

- **4-A.** `load(id, opts)` hook で `opts.ssr === false` かつ basename が
  `server.ts` / `layout.server.ts` / `*.server.{ts,tsx,js,jsx}` なら `"export {}"`
  を返す
  - vite 本体に枝を作らない、plugin 内で完結
  - `import.meta.glob("./routes/**/*.{ts,tsx}")` の動的 import も同じ pipeline を
    通るので、**glob 経由でも中身が stub になる**
  - `enforce: "pre"` で vite 内蔵 loader に先取り
- **4-B.** `configResolved` で vite の glob 解決に介入して glob pattern を
  書き換える
  - ソースを見るだけで除外が判るメリット
  - vite の internal を触るので破壊耐性が低い、glob 以外 (明示 import) には効かない
- **4-C.** vite 6 の Environment API (`this.environment.name === 'client'`) で判定
  - forward-looking、将来 2nd env 対応で自然
  - vite-plus が wrap してる vite の version 依存が強くなる (stable API ではない
    可能性)

## Decision

- 論点 1 → **1-A (Remix 式、路線単位 bulk RPC)**
- 論点 2 → **2-A (`GET /__loader?path=...`)**
- 論点 3 → **3-A (plain object + hydrateError で Error インスタンス復元)**
- 論点 4 → **4-A (`load` hook + `enforce: "pre"`、basename 判定)**

### 公開 API

`@vidro/plugin`:

```ts
import { serverBoundary } from "@vidro/plugin";

// vite.config.ts
export default defineConfig({
  plugins: [jsxTransform(), routeTypes(), serverBoundary()],
});
```

options は最小限:

```ts
export type ServerBoundaryOptions = {
  /** routes ディレクトリ (vite root 相対)。default: "src/routes" */
  routesDir?: string;
};
```

### endpoint: `GET /__loader?path=<pathname>`

#### 成功レスポンス (200)

```json
{
  "params": { "id": "42" },
  "layers": [
    { "data": { "users": [...] } },     // layouts[0] (outer)
    { "data": { "user": {...} } }       // leaf
  ]
}
```

- `layers` は外 (root layout) → 内 (leaf) の順。Router 側 `loaderResults` 並びと一致
- 各 layer は `{ data }` または `{ error: SerializedError }` の排他
- loader 未定義の layer は `{ data: undefined }` (空オブジェクト相当)

#### エラーレスポンス

- loader が throw: **200** を返し、該当 layer に `{ error: { name, message, stack } }`
  を入れる (層別外側伝播で上位 error.tsx が使われるため、HTTP ステータスは成功)
- endpoint 自体の問題 (`path` 欠落 / 予期せぬ crash): **4xx / 5xx** + `{ error }`
  を返す。Router 側は outer catch で default error 表示にフォールバック
  (**root error.tsx までは伝播しない**)

### client bundle stub

client 環境 (SSR 以外) で以下の id を `load` が受けたら `"export {}"` を返す:

- basename が `server.ts`
- basename が `layout.server.ts`
- 末尾が `.server.{ts,tsx,js,jsx}` (将来の `.server.ts` 規約用の保険)

SSR (`opts.ssr === true`) は pipeline を通して実体を読ませる。
`serverBoundary` middleware は `/__loader` で `server.ssrLoadModule(absPath)` を
叩くので、そこから先は SSR pipeline に乗り、stub にはならない。

### error の hydrate

Router 側:

```ts
function hydrateError(raw: unknown): Error {
  if (raw && typeof raw === "object" && "message" in raw) {
    const obj = raw as { name?: string; message?: string; stack?: string };
    const err = new Error(obj.message ?? "Unknown error");
    if (obj.name) err.name = obj.name;
    if (obj.stack) err.stack = obj.stack;
    return err;
  }
  return new Error(String(raw));
}
```

既存 `err instanceof Error` / `err.message` / `err.stack` 依存コードは
無改変で動く。custom Error subclass (例: `class HttpError extends Error`) は
`name` の文字列だけ残り、`instanceof HttpError` は false になる。
toy runtime 段階では許容し、本格対応は prod build (B-2) で devalue 系を検討。

## Rationale

### 論点 1: 1-A (Remix 式)

- 並列 fetch の本体を **server 側が肩代わり** することで、client は 1 route =
  1 HTTP に収まり、waterfall が HTTP レベルで発生しない。これは設計書 3.7 の
  「layer 並列 fetch」の最も素直な実装
- tRPC 式 (loader 単位) は部分 revalidate / optimistic update が効くようになるが、
  それは navigation とは別軸の要求 (action / mutation 側)。loader の navigation
  fetch は layer bulk で良い
- endpoint 1 本に集約することで、serverBoundary plugin の実装が
  compileRoutes + matchRoute + Promise.all の素直な 3 ステップで閉じる

### 論点 2: 2-A (GET + query)

- loader = read-only (by convention) なので GET で問題無し
- path を query string に乗せる形式は middleware で `req.url` から直接引けて
  middleware 実装が最小

### 論点 3: 3-A (plain object + hydrate)

- **既存コードを壊さない** が最優先。Router / ErrorBoundary / error.tsx は
  すべて `err.message` / `err instanceof Error` を前提に書かれており、
  hydrate で Error インスタンスを復元すれば無改変で動く
- custom Error subclass の情報喪失は toy runtime の制約として受容。設計書 3.8
  の「Error 階層」が具体化した段階で、devalue 等の structured clone 系を
  B-2 で再検討

### 論点 4: 4-A (load hook + pre)

- vite の `load` hook は plugin 間で順序制御が効き、`enforce: "pre"` にすると
  vite 内蔵の file-serving loader より先に match する。今回は **glob 展開後の
  動的 import も load pipeline を通る** ことに依存しており、この性質は vite の
  安定 API 上にある
- `resolveId` を使わないのは、id が絶対パスで来る場合と相対で来る場合の両方を
  吸収する必要があり、load 側で basename / suffix 判定する方が単純
- Environment API (4-C) は forward-looking だが、`opts.ssr` (vite 5 系で安定) の
  方が互換性が広い。vite 6 への移行で壊れたら切り替え

## Consequences

### 実装

- `packages/plugin/src/server-boundary.ts`:
  - dev middleware で `/__loader` endpoint を expose
  - `collectRouteModules(routesDirAbs, server)` で `.server.ts` / `.layout.server.ts`
    は `server.ssrLoadModule(absPath)` を lazy loader に、その他 (index.tsx
    等) は stub loader に
  - `runLoader` で各 layer を Promise.all
  - `load` hook + `enforce: "pre"` で client 側 `.server.ts` / `server.ts` /
    `layout.server.ts` を `"export {}"` に stub
  - error は `SerializedError = { name, message, stack }` で serialize
- `packages/router/src/router.tsx`:
  - `runServerLoader` を廃止し、`fetchLoaders(pathname)` で `/__loader` を 1 回叩く
  - `hydrateError` で plain object → Error インスタンス復元
  - 既存 `err.message` / `instanceof Error` 依存コードは無改変で動く
- apps 側 `vite.config.ts` で `serverBoundary()` を plugin リストに追加

### 制約・既知の課題

- **dev only**: prod build (vite ssr build + adapter) の対応は B-2 で別 ADR
- **custom Error subclass の class 情報が剥がれる**: plain object 往復のため
  `instanceof CustomError` が false になる。`name` 文字列は保持されるので判別は
  可能。本格対応は devalue / superjson / structuredClone で B-2 時に検討
- **`.server.ts` を明示 import しても build error にならない (silent stub)**:
  client 側で `import { db } from "./db.server"` と書いても `db` は `undefined`
  になり、使った瞬間に runtime error。`案 C` (明示 import エラー化) は将来の
  拡張余地として残す
- **root error.tsx までの層別伝播が endpoint 5xx では効かない**: endpoint 自体が
  5xx を返すケース (path 欠落等) は Router の outer catch で default error 表示
  になる。plugin 側で loader 失敗を HTTP 500 ではなく 200 + layers 全 error 埋め
  で返すことで層別伝播を効かせる拡張は次段階

### 設計書への影響

- 3.3「Server/Client boundary」を「dev 側のみ実装済み」として格上げ
- 拡張子規約は設計書だと `.server.ts` / `.client.ts` / `.ts` だが、現状の Vidro は
  route convention 上 `server.ts` / `layout.server.ts` の basename 規約も併用。
  stub 判定はこの **両方** に効かせる (保険で `*.server.*` も)

## Revisit when

- **prod build 対応 (B-2)**: vite ssr build で server bundle を作り、Cloudflare
  Workers / Node adapter で `/__loader` を handle する。現 dev middleware の
  routesDir walk を build 時に static に固める (compiled route manifest)
- **custom Error subclass を保持したくなった時**: plain object 往復を devalue
  / superjson 相当に差し替え。B-2 と同時期になる見込み
- **action (mutation) を足した時**: `/__loader` は GET のまま、`/__action`
  のような対で POST を足す。tRPC 式の「endpoint 単位」とのハイブリッドに寄る
- **部分 revalidate が必要になった時**: 現状は navigation 単位で全 layer を
  再 fetch。`useNavigation` 的な API で特定 layer だけ invalidate する要求が
  出たら endpoint を layer 単位に細分化するか、query param で layer 指定を足す
- **明示 import エラー化 (案 C) が欲しくなった時**: `.server.ts` を直接 import
  した場合に build を落とすには、`load` で warning ではなく throw する / vite
  build でのみ fail させる / lint rule を別途用意する、の 3 択。toy runtime 段階
  では silent stub で十分という判断
