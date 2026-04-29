# ADR 0043 — dev/build pipeline を `@cloudflare/vite-plugin` に統合 (CF 特化の明文化)

- Status: Accepted
- Date: 2026-04-29
- 関連 ADR: 0011, 0012, 0013, 0017, 0018, 0036

## 背景 / 動機

ADR 0012 / 0013 の段階で確立した dev/build pipeline は、`@vidro/plugin` の
`serverBoundary()` が **dev 用 `/__loader` middleware** と **prod 用 2nd-pass
ssr build (`closeBundle` で `dist-server/index.mjs` を生成)** を兼任する形だった。
これにより:

1. **dev は Node の `ssrLoadModule()`、prod は workerd** — runtime が違うので
   dev/prod parity gap があり、Workers 固有の挙動 (CPU time / globals) は
   `wrangler dev` を別ターミナルで立ち上げないと検証できなかった
2. **`wrangler dev` は build 出力 (`dist-server/index.mjs`) を main にしている**
   ため、source 編集ごとに `vp build --watch` を別ターミナルで回す必要があり、
   実質 **2 ターミナル運用** が必須だった
3. **client + worker の HMR が無い** — `wrangler dev` は再起動、`vp dev` は
   CSR-only で SSR を見られない、という二者択一だった

vidro-tutorial で実 app を作り始めた段階で、この DX が決定的に苦しいと判明
(`feedback_dx_first_design.md` で言語化した DX-first 原則)。同時に、CF 特化を
Vidro identity の核として明文化するタイミングだった (北極星 memory)。

## 設計判断

### 1. Vidro は **Cloudflare Workers 特化**を identity の一部として明文化する

runtime-agnostic にせず、**CF Workers 前提の設計判断を取る**ことを公式化。

- `wrangler.toml` を **mandatory** とし、deploy target は CF Workers 単一
- bindings (D1 / KV / R2 / Durable Objects) を将来 first-class に型貫通させる
  方向 (詳細は別 ADR、今回は build pipeline のみ)
- runtime 抽象 layer (Node / Lambda / CF) は持たない。Hono 的透明性 (5 哲学の 1) を
  維持するため、薄い core に shim を増やさない

trade-off: AWS / GCP で動かしたい user は対応外。北極星 memory `target は個人
/hobby/cf 規模感` と整合し、cons は audience に対して not applicable。

### 2. `@cloudflare/vite-plugin` を採用、`viteEnvironment.name = "ssr"` で integrate

Cloudflare 公式の vite plugin を user の `vite.config.ts` に導入する。

```ts
import { cloudflare } from "@cloudflare/vite-plugin";
export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    jsxTransform(),
    routeTypes(),
    serverBoundary(),
  ],
});
```

- dev は **workerd を vite dev server 内に in-process 起動** し、全 request を
  `wrangler.toml` の `main` (= `.vidro/server-entry.ts`) に流す
- HMR は client + worker 両方に効く (vite ネイティブ + CF plugin の worker reload)
- prod は CF plugin が build output を `dist/client/` (静的) + `dist/ssr/` (worker
  bundle + flattened `wrangler.json`) に統合管理する
- `wrangler dev` 不要、`vp dev` 1 本で完結

`viteEnvironment.name = "ssr"` は CF docs の full-stack framework 推奨設定。
Vite の environment API で worker 環境を `ssr` 名に紐付け、Vidro plugin 側の
`this.environment.name === "client"` 判定と整合する。

### 3. `serverBoundary` を security boundary 専任に簡素化

旧実装 (220 行) から、CF plugin と機能が重複する 2 機能を削除:

- ✗ 削除: `configureServer` の `/__loader` Node middleware (workerd が直接 handle)
- ✗ 削除: `closeBundle` の 2nd-pass ssr build (CF plugin が build を統合管理)
- ✓ 残す: `load` hook での **`.server.ts` を client bundle で空 stub に差し替える
  security boundary** (40 行)

判定は **新 vite environment API** (`this.environment.name === "client"`) を
primary、旧 `opts.ssr` を fallback として併用する hybrid:

```ts
const envName = this.environment?.name;
const isClientPass = envName ? envName === "client" : !opts?.ssr;
if (!isClientPass) return null;
```

CF plugin は新 API を使い、worker pass の `name` は `"ssr"` なので stub されない。
旧 plugin (legacy `opts.ssr`) との互換性も保つ。

### 4. build output 構造を `dist/client/` + `dist/ssr/` に集約

旧: `dist/` (client) + `dist-server/` (worker) の 2 階層散らばり
新: `dist/client/` + `dist/ssr/` の **1 親 dir 集約** (Next.js `.next/` 流)

`dist/ssr/wrangler.json` は CF plugin が `wrangler.toml` を flatten して生成し、
そのまま `wrangler deploy dist/ssr` で deploy 可能形になる。

`.gitignore` の `dist-server` entry は削除。

### 5. `esbuild.jsxImportSource` を vite.config で明示する

CF plugin の SSR environment dep scan が esbuild を使うため、tsconfig の
`jsxImportSource: "@vidro/core"` だけでは届かない (tsconfig は tsc 専用)。
明示しないと esbuild が `react/jsx-runtime` を探して dep scan が失敗する。

```ts
esbuild: {
  jsx: "automatic",
  jsxImportSource: "@vidro/core",
},
```

将来的には `@vidro/plugin` 側でこの config を auto-merge する方向 (今は
user 側で書く方が動作の透明性が高いので保留)。

## 実装ファイル

修正:

- `packages/plugin/src/server-boundary.ts` (220 行 → 40 行)
- `packages/plugin/src/route-types.ts` (auto-generated server-entry コメント更新)
- `packages/plugin/src/index.ts` (`ServerBoundaryOptions` 型 export 追加)
- `packages/router/src/server.ts` (handler 冒頭コメントを ADR 0043 反映に更新)
- `apps/vidro-tutorial/package.json` (`@cloudflare/vite-plugin` を `catalog:` で追加)
- `apps/vidro-tutorial/wrangler.toml` (`main` を source path、assets dir を `./dist/client`)
- `apps/vidro-tutorial/vite.config.ts` (`cloudflare()` plugin + `esbuild.jsxImportSource`)
- `.gitignore` (`dist-server` entry 削除)

## trade-off / 代替案検討

### A. runtime-agnostic (Vercel Adapter / Node Adapter / CF Adapter)

却下。設計書 5 哲学の「Hono 的透明性」「引き算のデザイン」と矛盾する抽象 layer
を持つことになり、Vidro の core が肥大化する。北極星 memory `企業採用は狙わ
ない、target は個人/hobby/cf 規模感` とも矛盾。

### B. CF plugin を使わず自前で workerd を vite middleware から呼ぶ

却下。Miniflare / workerd の lifecycle 管理を自前実装するのは保守コスト高、
かつ CF 公式の改善追随が困難。`@cloudflare/vite-plugin` は CF 自身が VoidZero
(Vite+ の作者) と協調して vite environment API に乗せて作っており、信頼でき
る upstream。

### C. dev は今まで通り CSR + middleware、prod だけ CF plugin

却下。dev/prod parity gap が解消されない (本 ADR の動機 1 をそのまま保留する
ことになる)。HMR + SSR 両立の DX 向上が本 ADR の主目的なので、半分だけ採用は
意味がない。

## follow-up

- `@vidro/plugin` の `serverBoundary` から将来 `esbuild.jsxImportSource` を
  auto-merge する option を検討 (user vite.config の boilerplate 削減)
- bindings の型貫通 (D1 / KV / R2 を `loader({env})` に typed で渡す) は別 ADR
- 設計書 (`~/brain/docs/エデン 設計書.md`) の "Primary target: Cloudflare Workers" を
  "**特化** target: Cloudflare Workers" に強化する記述追加 (out-of-scope、別 PR)
