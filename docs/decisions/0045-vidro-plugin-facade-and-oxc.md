# ADR 0045 — `vidro()` plugin facade と OXC 移行で vite.config.ts を 1 plugin に

- Status: Accepted
- Date: 2026-04-29
- 関連 ADR: 0011 (route-types), 0013 (.vidro/ output dir), 0043 (CF vite plugin 統合), 0044 (boot helper)

## 背景 / 動機

`apps/core/` (`@vidro/core` だけ使う CSR テンプレ) を起点に「使う側視点」で
vite.config.ts を書いた結果、19 行の中に **3 つの懸念** が同居していた:

```ts
export default defineConfig({
  esbuild: {
    // (1) JSX transform を Vidro に向ける
    jsx: "automatic",
    jsxImportSource: "@vidro/core",
  },
  resolve: {
    alias: {
      // (2) dep-scan の `react/jsx-runtime`
      "react/jsx-runtime": "@vidro/core/jsx-runtime",
      "react/jsx-dev-runtime": "@vidro/core/jsx-dev-runtime",
    },
  },
  plugins: [jsxTransform()], // (3) A 方式 transform
});
```

比較対象:

```ts
// React (5 行)
import react from "@vitejs/plugin-react";
export default defineConfig({ plugins: [react()] });

// Solid (5 行)
import solidPlugin from "vite-plugin-solid";
export default defineConfig({ plugins: [solidPlugin()] });
```

「使う側」が `react/jsx-runtime` の alias を書かされるのは抽象漏れ。React/Solid
の plugin は同じ問題に当たらない理由を確認したところ:

- `vite-plugin-solid` は babel-preset-solid で `solid-js/h/jsx-runtime` を直接
  import する code を出力。`esbuild.jsx` も alias も触らない
- `@vitejs/plugin-react` は **OXC** を前提に `oxc: { jsx: { runtime: 'automatic',
importSource: opts.jsxImportSource } }` を `config()` hook で push

→ Vidro 側も同じ流儀 (FW plugin 1 個で全部畳む) に揃えるべき。さらに、現行の
`esbuild.jsx` 設定は vite-plus 0.1.x で deprecation 警告が出ていた:

```
[vite+] warning: `esbuild` option was specified by "vidro-jsx-transform" plugin.
  This option is deprecated, please use `oxc` instead.
```

vite-plus が既に Rolldown/OXC ベースに切替済で、`oxc.jsx.{runtime, importSource}`
で正攻法に書ける状態だったことが発覚。`react/jsx-runtime` alias の workaround は
不要になっていた。

## 設計判断

### 1. `vidro()` を `@vidro/plugin` の主役 export にする

```ts
// CSR template (apps/core/)
plugins: [vidro()]

// Router + SSR + CF (apps/router-demo/)
plugins: [
  cloudflare({ viteEnvironment: { name: "ssr" } }),
  vidro({ router: true }),
],
```

`vidro()` は plugin 配列を返す facade で、内部構成:

| option                 | 含まれる plugin                                        |
| ---------------------- | ------------------------------------------------------ |
| `vidro()`              | `jsxTransform()`                                       |
| `vidro({router:true})` | `jsxTransform()` + `routeTypes()` + `serverBoundary()` |

`router` は `boolean | RouteTypesOptions & ServerBoundaryOptions` で、object を
渡せば advanced 設定 (`routesDir` 等) も通る。

### 2. `jsxTransform()` の `config()` hook で OXC 設定を内包

旧 `esbuild.jsx + jsxImportSource + resolve.alias` 3 点 → 新 `oxc.jsx` 1 点に
集約:

```ts
config() {
  return {
    oxc: {
      jsx: {
        runtime: "automatic" as const,
        importSource: "@vidro/core",
      },
    },
  };
},
```

これにより:

- user の vite.config.ts から `react/jsx-runtime` alias が完全消滅 (= "react"
  の文字列が user 空間に出てこない、抽象漏れ解消)
- vite-plus deprecation 警告も消える
- `@vitejs/plugin-react` と同じ正攻法 (OXC ベース) に揃う

### 3. low-level 個別 export は残す

`jsxTransform` / `routeTypes` / `serverBoundary` は引き続き named export する。
理由:

- ADR 内部 tuning や FW 開発時に個別 plugin を組み替えたい場面がある
- `vidro()` は user-facing facade、個別 export は plugin 開発者向け low-level

通常の Vidro app は `vidro()` だけ知っていればよい。

### 4. `router` の自動検知は却下

`package.json` の deps に `@vidro/router` が居るか見て自動 enable する案も検討
したが:

- magical (config を読んで挙動が変わる)、`legibility_test.md` の「読んで日本語
  に訳せるか」原則に反する
- `vidro({ router: true })` の 1 token が真の cost ではない
- 後で `vidro({ router: 'auto' })` を足すのは後方互換的に容易

→ explicit な opt-in を採用。

## 影響

### apps/core/vite.config.ts (CSR template)

19 行 → **6 行**:

```ts
import { defineConfig } from "vite-plus";
import { vidro } from "@vidro/plugin";

export default defineConfig({
  plugins: [vidro()],
});
```

### apps/router-demo/vite.config.ts (router + SSR + CF)

41 行 → **20 行** (`build.outDir` の `.vidro/build` 集約と CF plugin の説明
コメントは残置)。`esbuild` block / `resolve.alias` block / `jsxTransform()` /
`routeTypes()` / `serverBoundary()` の 3 個別 plugin 呼び出しが、`vidro({ router: true })`
の 1 行に縮約。

## 動作確認

- `apps/core` (port 5174): `vp dev` 起動、deprecation 警告ゼロ、`Hello, Vidro!`
  - counter 描画、click で 0 → 1 ✓
- `apps/router-demo` (port 5175): `vp dev` 起動、`/` → `/notes` 遷移 OK、SSR +
  hydrate 動作、console error / warning ゼロ ✓

## trade-off / 代替案検討

### A. `jsxTransform()` だけ残し、`vidro()` は作らない

却下。`routeTypes()` と `serverBoundary()` は常にセットで使う (router 有る
=server boundary 必要、ADR 0043) ので、user に 3 plugin を並べさせる意義が
薄い。`vidro({ router: true })` で 1 行に畳む方が DX 良い。

### B. `vidro()` を default export にする

却下。Vidro core の他の primitive (`signal`, `mount` 等) は named export 統一
しており、plugin だけ default export だと一貫性が崩れる。React/Solid plugin
も named export を推奨している。

### C. OXC 移行を見送り、`esbuild.jsx + alias` のまま `vidro()` だけ作る

却下。deprecation 警告を放置するのは技術的負債。`oxc.jsx` で書ける状態が
既に整っているのに workaround を残す理由がない。alias 削除で user 空間から
"react" 文字列も消えるので、これが本作業の主目的のひとつ。

## 派生発見: vite-plus alpha の dual-version 型衝突

実装中に `[vidro()]` で `TS2321 Excessive stack depth comparing types` が出続け
原因が分からなかったが、エラーメッセージを精査して以下を発見:

```
'.../@voidzero-dev+vite-plus-core@0.1.19/...').Plugin<any>' is not assignable to
'.../@voidzero-dev+vite-plus-core@0.1.20/...').Plugin<any>'
```

→ pnpm 依存解決で **vite-plus-core が 0.1.19 と 0.1.20 同時に同居**。`Plugin<any>`
は構造同じでも path が違うので TS は別型扱いし、`PluginOption` recursion で
照合が爆発していた (ユーザーが指摘した「vite-plus alpha 由来では」が的中)。

**回避**: `@vidro/plugin` 内で `Plugin` 型を `vite-plus` ではなく `vite` から
直接 import する (4 ファイル全て統一)。`@cloudflare/vite-plugin` も `vite.Plugin[]`
を返しており、これが single source of truth。vite-plus が stable に入ったら
再評価する。

`packages/plugin/package.json` に `vite` を direct deps + peerDeps として追加。

## follow-up

- `create-vidro` CLI の template に `vidro()` を採用 (`apps/core/` がそのまま
  template になる想定)
- 将来 `vidro()` に `ssr?: 'cloudflare' | 'node'` option を足し、CF plugin
  も内包する余地あり (ただし `@cloudflare/vite-plugin` は外部 vendor の
  third-party plugin なので、Vidro 側で wrap する設計妥当性は要検討)
- `react/jsx-runtime` alias 撤去で発覚するかもしれない他の "react" 言及箇所
  (e.g. resource scan rule) があれば追って削除
- vite-plus stable 後、`Plugin` 型を `vite-plus` 経由に戻せるか再検証
  (本 ADR の dual-version 回避 hack を撤去できる可能性)
