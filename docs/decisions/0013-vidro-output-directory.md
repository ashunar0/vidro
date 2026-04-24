# 0013 — 生成物置き場 `.vidro/` と tsconfig base の配布戦略

## Status

Accepted — 2026-04-24

## Context

ADR 0011 で導入した `routeTypes()` plugin は `src/_vidro/routes.d.ts` に
RouteMap augmentation を吐いていた。この配置には 2 つの問題がある:

1. **生成物が `src/` に混ざる**: user の source tree に build artifact が侵入し、
   CLAUDE.md で「`src/` はユーザーコード」と宣言しづらくなる
2. **今後 prod build (案 B-2) で生成物が増える**: server bundle manifest /
   compiled route 等を増やす際に `src/_vidro/` が肥大化する

本 ADR は**生成物置き場の名前と場所**、および **Vidro が要求する `tsconfig`
設定の配布方法**を決める。`_vidro/` にした当初の理由は「dot-prefix `.vidro/`
だと tsc の `include` から自動除外されて augmentation が効かない」という
技術制約だったが、tsconfig 側で明示的に include すれば回避できる。

論点は 2 つ:

1. **生成物の場所**: `src/_vidro/` (現状) vs app root `.vidro/` (SvelteKit /
   Astro / Next 式) vs app root `_vidro/`
2. **tsconfig 配線方法**: FW が base tsconfig を提供して user が `extends`
   するか、user tsconfig に直接書かせるか

## Options

### 論点 1: 生成物の場所

- **1-A.** `src/_vidro/` (現状) — src/ に生成物が混ざる、`src/` がユーザー
  コード専用という宣言が崩れる。tsconfig の `include: ["src"]` で自動に
  拾われる利点はある
- **1-B.** app root `.vidro/` (SvelteKit `.svelte-kit/` / Astro `.astro/` /
  Next `.next/` 式) — dot-prefix なので tsc の `include` からは除外される
  (明示 `include` が必要)。`.gitignore` に `.vidro/` で artifact 扱いが自然
- **1-C.** app root `_vidro/` — dot じゃないので自動 include されやすいが、
  既存エコシステムの慣習と外れる

### 論点 2: tsconfig 配線方法

- **2-α.** **module path で extends 配布**: `@vidro/plugin` package に
  `tsconfig.base.json` を同梱し、exports で公開。user tsconfig は
  `"extends": "@vidro/plugin/tsconfig.base.json"` で継承
  (Astro `astro/tsconfigs/*` と同形)
- **2-β.** **`.vidro/tsconfig.json` を plugin が生成** し、user tsconfig が
  `"extends": "./.vidro/tsconfig.json"` で継承 (SvelteKit `.svelte-kit/tsconfig.json`
  と同形)。生成には vite を走らせる必要があり、`vp check` 単体では chicken-egg
  になる (未生成で `Cannot read file` エラー)。別 CLI (`vidro sync`) か
  `prepare` script で事前生成が必要
- **2-γ.** **extends しない**: user tsconfig に必要な compilerOptions を全部
  書かせる (現状とほぼ同じ)。FW 側で tsconfig を制御できず、`jsxImportSource`
  等の誤設定を user が起こしやすい

## Decision

- 論点 1 → **1-B (app root `.vidro/`)**
- 論点 2 → **2-α (`@vidro/plugin/tsconfig.base.json` を extends)**

### 公開 API

`@vidro/plugin` に base tsconfig を同梱:

```jsonc
// node_modules/@vidro/plugin/tsconfig.base.json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "esnext",
    "lib": ["ES2023", "DOM"],
    "types": ["vite/client"],
    "skipLibCheck": true,

    "jsx": "react-jsx",
    "jsxImportSource": "@vidro/core",

    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,

    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true,
  },
}
```

`package.json` で `./tsconfig.base.json` を exports に公開し、`files` にも追加。

user 側 tsconfig は最小限:

```jsonc
// apps/<app>/tsconfig.json
{
  "extends": "@vidro/plugin/tsconfig.base.json",
  "compilerOptions": {
    "noUnusedLocals": true,
    "noUnusedParameters": true,
  },
  "include": ["src", ".vidro/**/*.d.ts"],
}
```

### routeTypes() 出力先

plugin の default outFile を `src/_vidro/routes.d.ts` から `.vidro/routes.d.ts`
(vite root 相対) に変更。`outFile` option で override 可能。

### `.gitignore`

`.vidro/` を artifact として gitignore に入れる (`_vidro/` から置換)。

## Rationale

### 論点 1: 1-B (`.vidro/`)

- **src/ の純化**: user の source tree にビルド成果物が混ざらない。将来
  「`src/` はユーザーコードだけ」を CLAUDE.md 等で宣言しやすい
- **エコシステムとの整合**: SvelteKit `.svelte-kit/`, Astro `.astro/`,
  Next `.next/`, Nuxt `.nuxt/` と同じ dot-prefix root dir 慣習に乗る。
  外部 AI エージェント / 読み手の mental model に合う
- **将来の拡張**: 案 B-2 (prod build) で server bundle manifest 等の成果物を
  足す際、`.vidro/` 配下に集約すれば scale する
- dot-prefix で tsc include から除外される問題は、user tsconfig の
  `include` に `.vidro/**/*.d.ts` を 1 行足せば解決する

### 論点 2: 2-α (module path extends)

- **chicken-egg を避ける**: 2-β は `.vidro/tsconfig.json` を plugin が生成する
  設計だが、`vp check` のような vite を経由しない tool が走ると未生成で
  tsconfig 解決に失敗する。SvelteKit は `prepare: svelte-kit sync` を
  package.json scripts で強制しているが、Vidro の toy runtime 段階で
  独立 CLI を足すのは YAGNI
- **package version で中央制御**: `@vidro/plugin` を bump するだけで
  全 user の tsconfig 基盤が追従する。user tsconfig に同じ compilerOptions を
  重複させる必要がない
- **Astro と同じ形**: `"extends": "@vidro/plugin/tsconfig.base.json"` は
  Astro / Remix 等で既視感のある書き方で、学習コストが低い
- **include は extends で継承しない設計**: TypeScript の include 相対パスは
  その tsconfig のディレクトリ基準で解決されるため、plugin package 内で
  `include` を書いても node_modules 基準になり意味を成さない。従って
  **include は user tsconfig で明示的に書く** のを規約にする (7-8 行の
  tsconfig に収まる)

### 論点 2 で β を却下した理由

- vite を通さずに tsconfig が読める必要がある場面が多い: `vp check`
  (oxc 単体), editor (TS Language Server), `tsc --noEmit` (手動), CI の
  並列 stage 等
- SvelteKit 式の CLI (`svelte-kit sync`) は toy runtime 段階では過剰。
  将来 paths 等を動的に調整したくなったら再検討

## Consequences

### 実装

- `packages/plugin/tsconfig.base.json` を新設 (compilerOptions のみ、include 無し)
- `packages/plugin/package.json` の `files` / `exports` に tsconfig.base.json を追加
- `packages/plugin/src/route-types.ts` の `outFile` default を
  `.vidro/routes.d.ts` に変更 (option 名も `outFile` に統一)
- `apps/router-demo/tsconfig.json` を `extends` + `include` の 7-8 行に縮小
- `.gitignore` を `_vidro/` → `.vidro/`

### 制約・既知の課題

- **`.vidro/routes.d.ts` の chicken-egg は残る**: `vp check` を走らせる前に
  `vp dev` か `vp build` を 1 回走らせて `.vidro/routes.d.ts` を生成する
  必要がある。routes.d.ts が無いと `LoaderArgs<"/users/:id">` が `unknown`
  になり TS エラー。CI では `vp build && vp check` の順で回避、ローカルでは
  `vp dev` を常用しているので実質問題にならない
- **plugin package に tsconfig が混ざる**: `@vidro/plugin` は vite plugin を
  export するパッケージだが tsconfig base も同梱する (単一パッケージで
  "Vidro を使うための入り口" を 1 箇所に集約する方針)。plugin のコードと
  tsconfig が同じ package から来るのが違和感なら、将来 `@vidro/tsconfig`
  のような専用パッケージに分離できる (package.json 1 つ増えるだけ)
- **user tsconfig に include が必要**: 2-α の宿命として include は user 側
  で書く。漏れると `.vidro/routes.d.ts` / `src/**` が拾われず lint 通らない
- **website app はまだ routeTypes を使っていない**: 本 ADR の対象外。
  将来 website で router を使う時点で同じ tsconfig 形式に揃える

### 設計書への影響

- 設計書 3.4「生成物の扱い」(存在すれば) に `.vidro/` を追記。未存在なら
  "AI-native 規約" 節に「生成物は `.vidro/` に集約、`src/` はユーザーコード
  だけ」を明記

## Revisit when

- **paths 等を動的に調整したくなった時**: 例えば `@/components/*` の alias を
  Vidro 側でデフォルト注入したい場合、static な base tsconfig では対応しづらい。
  その時 2-β (生成) + 独立 CLI (`vidro sync`) に寄せる
- **`vp check` 単体で完結させたくなった時**: 現状 chicken-egg は `vp dev`
  / `vp build` を前置することで回避しているが、CI 時間短縮で `check` だけ
  走らせたい等の要求が出たら、routes.d.ts を commit 対象にするか sync CLI
  を足すかを再検討
- **`@vidro/plugin` が重くなった時**: plugin に vite の重い dependency が
  増えた段階で、tsconfig だけ別パッケージ (`@vidro/tsconfig`) に切り出す。
  現状 @babel/\* 依存が大きいので、将来 oxc-transformer に載せ替える
  タイミングで見直し
- **case 2-β が必要になった時**: user ごとに tsconfig を動的生成したく
  なったら `.vidro/tsconfig.json` 生成 + `prepare` script に戻す
