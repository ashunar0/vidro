# 0067 — Per-route `+types` codegen (`Route` namespace, 9 論点)

## Status

**Accepted** — 2026-05-08 (55th session、user 合意取得済 9 論点)

依存: ADR 0011 (Route tree 型生成 plugin、`routeTypes()` で central `RouteMap`)
関連: ADR 0049 (loaderData primitive)、ADR 0058 (`.server.tsx` semantics)、ADR 0066 (async server component native)、memory `project_type_vertical_propagation` (= 型貫通 9 経路、本 ADR は #1 を担当)

## Context

### 痛みの起点 — async 直書きで `params` の型を引けない

apps/blog `src/routes/posts/[slug]/index.server.tsx` の現状コード:

```tsx
export default async function PostDetail({ params }: { params: { slug: string } }) {
  //                                                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  //                                                ファイル位置 [slug] からの自動推論が無いので手書き
  const post = await db.postBySlug(params.slug);
  // ...
}
```

ADR 0066 / 0058 で `.server.tsx` を `async function Component` で書く async 直書きが主軸になった結果:

- loader を持たない (= ADR 0058 D-α-iii)
- 既存の `PageProps<typeof loader>` (loader-based 用) が効かない
- `{ params: { slug: string } }` を user が手書きする以外に道がない

### 構造的問題: 重複定義

ファイル位置 `[slug]` (= URL pattern declaration) と PageProps annotation 内の `slug` (= TS 型) が **同じ情報を 2 箇所で保持** している。

- **rename 追従コスト**: `[slug]` → `[postSlug]` の場合、ファイル名以外に annotation の path string も書き直し必要
- **多階層の長大化**: `/users/[userId]/posts/[postId]/comments/[commentId]` で各 layer の名前が flat に merge され、annotation が improperly long
- **typo 検出**: ファイル位置と annotation がズレても build まで見つからない

### 既存資産: `routes.d.ts` central RouteMap (ADR 0011)

`@vidro/plugin` の `routeTypes()` は既に中央 `RouteMap` interface を生成している:

```ts
// .vidro/routes.d.ts (auto-gen)
declare module "@vidro/router" {
  interface RouteMap {
    "/posts/:slug": { params: { slug: string } };
    // ...
  }
}
```

これを **per-route で拡張** する = 各 route file の sibling として `+types.d.ts` を生成し、`Route` namespace 経由で型をその route 専用に解決する。

### 路線 A (= `PageProps<R>` overload) を却下した経緯

検討初期は「`@vidro/router` の `PageProps` 型を `<R extends keyof Routes>` overload で拡張、user は `PageProps<"/posts/:slug">` のように route path を手書きで指定」案 (= 路線 A) を有力視していた。RouteMap 既存資産にそのまま乗れる、機構増えない、シンプル。

しかし 55th session の議論で以下が判明:

- **重複定義は thin redundancy ではなく structural redundancy** — ファイル位置と annotation の 2 箇所同期は規模に関わらず存在し続ける
- **rename 時の手作業発生** — TS が「`keyof Routes` に無い」エラーで炙り出してくれるが、書き換えは user が機械的にやる必要
- **deep nested で annotation 長大化** — `PageProps<"/users/:userId/posts/:postId/comments/:commentId">` 級が formatter で改行に折れる
- **memory「引き算のデザイン」(`/CLAUDE.md`) に反する** — user に二重管理を強いるのは「足し算」

→ 路線 B (per-route codegen) を採用。詳細は Options 参照。

### 他 FW との対比

| FW                       | アプローチ                                                                |
| ------------------------ | ------------------------------------------------------------------------- |
| **Next.js (App Router)** | 手書き or `PageProps<'/[locale]'>` generic、最新版で部分的 codegen        |
| **React Router v7**      | `import type { Route } from "./+types/post"` + `react-router typegen`     |
| **TanStack Router**      | `createFileRoute('/posts/$postId')` で route 定義 object 経由             |
| **Inertia + Hono**       | central registry (`routes.gen.d.ts`)、per-page props は user augment 任せ |

**React Router v7 と同型のアプローチ** が Vidro philosophy (= 素朴な default export route + 機構誘導 + 型貫通) に最も自然に乗る。Inertia/Hono の per-page props auto-infer 未対応 (= `unknown` 留め) 領域を Vidro path B で **超える** ことで、memory `project_type_vertical_propagation` の identity を立てられる。

### Vidro 哲学整合 (memory cross-check)

| memory                              | 関係                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| `project_type_vertical_propagation` | 9 経路の #1 (URL pattern → loader/page args) を本 ADR で着地                      |
| `project_design_north_star`         | RSC simpler 代替 + 型貫通強化 (= identity 核)                                     |
| `feedback_dx_first_design`          | target syntax 起点で API 逆引き、本 ADR は dogfood で踏んだ痛みから起票           |
| `project_legibility_test`           | `import type { Route } from "./+types"` が「この route 専用の型」と日本語に訳せる |
| 「引き算のデザイン」 (`/CLAUDE.md`) | 重複定義の structural avoidance = user に二重管理を強いない                       |
| `project_app_scaffolding_strategy`  | per-route codegen は scaffolding 不要 (plugin 自動)、apps/temp templates 互換     |
| `project_3tier_architecture`        | core / +router / +pack の +router tier、環境ではなく機能で切る軸とは独立          |
| `project_plugin_type_dedup`         | plugin 拡張は既存 routeTypes() に乗る、peer dep dedup は本 ADR の射程外           |

## Options

### 論点 0: 全体路線

#### (0-A) `PageProps<R extends keyof Routes>` overload (path 手書き、却下)

```tsx
import type { PageProps } from "@vidro/router";
export default async function Page({
  params: { userId, postId, commentId },
}: PageProps<"/users/:userId/posts/:postId/comments/:commentId">) {}
```

- **pros**: 機構薄 (中央 `RouteMap` 既存で済む、追加 codegen 不要)、tsconfig 変更不要
- **cons**: **構造的重複定義** (file path と annotation で同情報を 2 箇所保持)、rename で全 generic 書き換え、深いネストで annotation が長大化

#### (0-B) Per-route `+types` codegen (採用)

```tsx
import type { Route } from "./+types";
export default async function Page({ params: { userId, postId, commentId } }: Route.PageProps) {}
```

- **pros**: file path = single source of truth、rename 追従 auto、annotation が定数長 (深さ非依存)、React Router v7 互換
- **cons**: per-route codegen 機構必要 (`@vidro/plugin` 拡張 + tsconfig rootDirs)、生成ファイル増 (route 数 1:1)

#### (0-C) `createFileRoute('/posts/$postId')` 強制 (却下)

TanStack Router 風。Vidro philosophy 「素朴な default export route」 (= memory `project_design_north_star`) に反する。default export を壊さない範囲では (0-B) が筋。

### 論点 1: import path の規約

#### (1-A) `./+types` (per-directory、採用)

```tsx
import type { Route } from "./+types";
```

- 1 directory = 1 route segment、index.tsx / layout.tsx / server.ts / error.tsx が同じ `Route` namespace を共有
- import 行が定数 (filename 依存しない)
- Vidro の directory-based routing (memory `project_design_north_star` 整合) と素直に整合

#### (1-B) `./+types/{filename}` (per-file、却下)

```tsx
import type { Route } from "./+types/index";
import type { Route } from "./+types/layout";
```

- React Router v7 完全準拠
- ただし Vidro は 1 directory = 1 route の感覚、各 special file (index/layout/server/error) ごとに別 namespace は冗長

→ **(1-A) 採用**。

### 論点 2: namespace 名

`Route` 採用。

- **React Router v7 互換** (流入 user 学習コスト低)
- 「この route 専用の型集」が `Route.` で視覚的明示
- 短く自然な命名

却下:

- `Page.` — page 中心、layout 違和感
- `T.` — 省略形、memory `project_legibility_test` 落ちる
- `This.` — 英語感弱い
- flat (= namespace なし) — `@vidro/router` 公開の `PageProps<L>` と名前衝突

### 論点 3: v1 で生やす type 集

採用: 5 種類すべて。

```ts
namespace Route {
  type PageProps; //          index.tsx / index.server.tsx
  type LayoutProps; //        layout.tsx / layout.server.tsx (children + params)
  type LoaderArgs; //         server.ts loader (request + params)
  type ActionArgs; //         server.ts action (request + params)
  type ErrorBoundaryProps; // error.tsx (error + reset + params)
}
```

理由:

- dogfood scope では PageProps + LayoutProps だけ即効くが、codegen ロジックは同じ (= params shape に追加 field を生やすだけ)
- 後で書き直すコスト > 今書くコスト
- `LoaderArgs` / `ActionArgs` は loader-based 経路が memory `project_pending_rewrites` 通り残存中なので互換維持に必要

### 論点 4: codegen 出力位置

`.vidro/+types/routes/{mirror}/+types.d.ts`。

```
src/routes/posts/[slug]/index.server.tsx
                                ↓
.vidro/+types/routes/posts/[slug]/+types.d.ts
```

tsconfig.json:

```json
{
  "compilerOptions": {
    "rootDirs": ["./src", "./.vidro/+types"]
  }
}
```

`rootDirs` は両方を 1 つの logical root として扱う TS 機能。`src/routes/posts/[slug]/index.server.tsx` から見た `./+types` が `.vidro/+types/routes/posts/[slug]/+types.d.ts` に解決される。

#### `+` prefix の意味

ディレクトリ名の `+` は React Router v7 由来の「FW 生成、user は触らない」マーカー。TS / module resolution としては普通の文字、特殊機能ではない。Vidro が独自記号を作るより成熟した慣習を借りる方が legibility 高い。

### 論点 5: `Route.path` value export (v1 では保留)

```tsx
// 案 (v1 では実装しない):
import { Route } from "./+types";
import { navigate } from "@vidro/router";
navigate(Route.path, { params: { slug: "foo" } });
```

- **pros**: Cluster A の typed `<Link>` / `navigate` (#5, #6) で path 手書き不要
- **cons**: namespace に value 混在、本 ADR scope 拡大

→ **保留**。Cluster A の他経路 (`<Link href>` typed routes、`navigate()` typed) は別 ADR (= 候補 0068) で扱う。

### 論点 6: 動的 params なしの route

`params: Record<string, never>` で統一。

```tsx
// src/routes/index.tsx (= "/", params なし)
import type { Route } from "./+types";
export default function Home({ params }: Route.PageProps) {
  // params: Record<string, never>
}
```

- API 統一性 (= PageProps は常に `params` field を持つ)
- destructure すると何も取れないが、optional にしない (= 統一性優先、user が `params` を destructure しなければ済む)

### 論点 7: namespace vs interface

`namespace` 採用。

```ts
// 採用
export namespace Route {
  export type PageProps = { params: ... };
  export type LayoutProps = { params: ...; children: Node };
}

// 却下: interface
export interface Route {
  PageProps: { params: ... };
  LayoutProps: ...;
}
// → 型として直接アクセス不可 (Route["PageProps"] になる、dot 記法不能)
```

- `Route.PageProps` の dot 記法が自然 (React Router 互換)
- 将来 value export (`Route.path`) も同 namespace 内に追加可能 (= TS namespace は値も持てる)

### 論点 8: destructure 文法

FW で強制しない (= user の好み)。

```tsx
// 全部 valid、TypeScript の振る舞いも同じ
function Page({ params }: Route.PageProps) {} // 1 段、本体で params.x or const { x } = params
function Page({ params: { slug } }: Route.PageProps) {} // 2 段、slug 直接 binding
```

これは pure JavaScript の destructuring の話、Vidro 設計とは独立。docs / examples では blog 現状スタイル (= 1 段 destructure) を default として推奨するが、強制ではない。

## Decision (= 9 論点まとめ)

| #   | 論点               | 決定                                                                         |
| --- | ------------------ | ---------------------------------------------------------------------------- |
| 0   | 全体路線           | **B (per-route codegen)**                                                    |
| 1   | import path        | `./+types` (per-directory)                                                   |
| 2   | namespace 名       | `Route`                                                                      |
| 3   | v1 type 集         | `PageProps`, `LayoutProps`, `LoaderArgs`, `ActionArgs`, `ErrorBoundaryProps` |
| 4   | 出力位置           | `.vidro/+types/routes/{mirror}/+types.d.ts` + tsconfig `rootDirs`            |
| 5   | `Route.path` value | v1 保留 (= ADR 0068 候補)                                                    |
| 6   | params なし route  | `Record<string, never>` で統一                                               |
| 7   | namespace 形式     | `namespace`                                                                  |
| 8   | destructure 文法   | 自由 (FW 強制なし、blog スタイル `{ params }` を default 推奨)               |

## Rationale

### 重複定義の structural avoidance

路線 A は **ファイル位置と annotation の 2 箇所同期** を user に強いる。memory 「引き算のデザイン」(`/CLAUDE.md`) に反する。路線 B はファイル位置を single source of truth に据え、TS の `rootDirs` 機構で type に橋渡しする。

### React Router v7 互換 = 流入 user 学習コスト低

`import type { Route } from "./+types"` 規約は React Router v7 で成熟、ecosystem として既に「これで OK」判定済。Vidro 独自規約を作るより慣習を借りる方が user の認知負荷が低い (= memory `project_legibility_test`)。

### Inertia/Hono の上を行く identity

memory `project_type_vertical_propagation` で「Vidro identity の核 = 型貫通」を北極星に置いた。Inertia + Hono の組み合わせも per-page props auto-infer は未対応 (`unknown` 留め)、Vidro が path B を取れば **型貫通の射程で Inertia/Hono の上**を行ける。

### 機構コスト < 価値

per-route codegen は機構増 (= plugin 拡張 + tsconfig rootDirs) だが:

- `routeTypes()` 機構は既存 (= 0→1 ではなく 1→2 拡張)
- 生成ファイルは小さい (~20 行 / file)、`.gitignore` で隔離、user 体感ゼロ
- React Router 同型なので known territory

価値 (重複定義回避 + rename 追従 + scale 不変 annotation) と釣り合う。

## Consequences

### 機構面

- `@vidro/plugin` の `routeTypes()` を **per-route 出力にも対応** させる必要あり
  - 現状: `.vidro/routes.d.ts` 1 ファイル + `route-manifest.ts` + `server-entry.ts`
  - 拡張: `.vidro/+types/routes/{mirror}/+types.d.ts` を route 数ぶん追加
- `tsconfig.json` に `rootDirs: ["./src", "./.vidro/+types"]` 設定必要
  - **将来検討**: Vidro が `tsconfig.base.json` 配布 (= ADR 0013 と同様の base config 拡張) で user 設定不要化
- generated ファイルの watcher 必要 (= dev で route file 追加削除に追従)
  - 既存 `routeTypes()` plugin に乗っかれる前提

### API 面

- 旧 `PageProps<typeof loader>` (loader-based generic) は **維持** (deprecate しない)
  - loader 経路がまだ機構として残る (memory `project_pending_rewrites`)
  - dogfood blog は loader 不在、`Route.PageProps` 主軸
- `@vidro/router` 公開の `PageProps<L>` と `Route.PageProps` (per-route codegen) は **共存**
  - 名前空間が分かれてるので衝突なし
  - 用途で使い分け: loader-based は `PageProps<typeof loader>`、async 直書きは `Route.PageProps`

### dogfood 面

apps/blog の各 route file を以下のように移行:

| file                                       | before                                   | after               |
| ------------------------------------------ | ---------------------------------------- | ------------------- |
| `src/routes/index.tsx`                     | (型なし、props 受けず)                   | `Route.PageProps`   |
| `src/routes/layout.tsx`                    | `LayoutProps` (= `@vidro/router` import) | `Route.LayoutProps` |
| `src/routes/posts/index.server.tsx`        | (型なし、props 受けず)                   | `Route.PageProps`   |
| `src/routes/posts/[slug]/index.server.tsx` | `{ params: { slug: string } }` (手書き)  | `Route.PageProps`   |

apps/temp / apps/temp-router (= memory `project_app_scaffolding_strategy` の templates) も同様に migrate して canonical example 化する。

### 段階的移行

1. **Phase 1**: `@vidro/plugin` の `routeTypes()` 拡張 (= per-route +types codegen 機構)
2. **Phase 2**: tsconfig rootDirs 設定 (apps/blog 適用、後で template 化)
3. **Phase 3**: blog dogfood migration (= 既存 annotation を `Route.PageProps` 等に置換)
4. **Phase 4**: apps/temp / apps/temp-router migrate
5. **Phase 5**: 既存 ADR 0011 docs を本 ADR への参照込みで更新

各 Phase は独立コミット可能 (= memory `feedback_collaboration_style` 流の小さな commit)。

## Revisit when

- **per-route codegen の build perf issue** — route 数 100+ 規模で codegen が build を遅くするなら output 圧縮 / lazy generate 検討
- **React Router v7 が `+types` 規約を変更** — ecosystem 互換のための追従要否を再評価
- **TS が file path を型に流す機能を提供** — codegen 不要化の道、現状無いが将来登場可能性
- **`Route.path` value 必要性が顕在化** — Cluster A の `<Link href>` typed routes ADR (= 候補 0068) で再検討
- **loader-based 経路が完全廃止** — `LoaderArgs` / `ActionArgs` を namespace から削除、API 縮小余地
- **tsconfig rootDirs の user 設定が痛む** — Vidro が `tsconfig.base.json` 配布 (= ADR 0013 と同様) で user 設定不要化
