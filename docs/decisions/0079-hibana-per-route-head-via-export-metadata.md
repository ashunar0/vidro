# 0079 — Hibana の per-route head を `export const metadata` で扱う

## Status

**Proposed** — 2026-05-12 (= 第 19 周目 開始時点、dogfood 着地後 Accepted に昇格)

経緯:

- 2026-05-11 (= 第 18 周目完走): Hibana Phase 1 Step 1-3 全完走、`.island.tsx` + `app.ts` + `vite.config.ts` だけが user 語彙の状態
- 2026-05-12 (= 第 19 周目): Step 4 着手、(1) c.render 命名は据え置き決定 (= HonoX / Hono+Inertia と整合)、残る (2) per-route head の API shape を本 ADR で確定

依存: なし (= Hibana 初 ADR、Vidro ADR 連番を継続)
関連: `project_hibana_overview`, `project_hibana_vidro_interaction`, `feedback_dx_first_design`, `feedback_ai_first_api_design`, `project_api_design_philosophy_object_one_spread`

## Context

第 18 周目までで `hibana({ title })` middleware option で global title を 1 個だけ設定できる状態。**route ごとに `<head>` を変える機構が無い** = `<title>` も `<meta>` も `<link>` も全 route 共通固定。

Hibana の北極星は「backend-first FW」(= 設計書) で、route handler が render を invoke する構造。route 単位で:

- `<title>` を変える (= SEO / brand)
- `<meta name="description">` / `<meta property="og:*">` / `<meta name="twitter:*">` を変える (= shareable / social)
- `<link rel="canonical">` / `<link rel="alternate">` を変える (= SEO / i18n)
- page 固有の stylesheet / font を `<link>` で足す (= performance / scoped style)

これらは web app の必須要件 (= MVP scope と整合)。Phase 1 Step 4 でこの API shape を確定させる。

memory `feedback_dx_first_design` (= target syntax を起点に逆引き) に従い、user が書くコードの見た目を先に決め、機構は逆引きで設計する。

## Options

### 案 A: `c.render` 第 3 引数で options を渡す

```ts
postsRoutes.get("/:id", (c) => {
  const post = getPost(c.req.param("id"));
  return c.render(PostDetailPage, { post }, { title: post.title, description: post.excerpt });
});
```

**却下** — c.render の引数を増やすと API surface が太る。memory `project_api_design_philosophy_object_one_spread` の「機構知識を primitive に閉じる」原則に逆行。route と page の責務が分散 (= page タイトルなのに route handler で書く)。c.render は据え置き要件 (= user の明示意向、第 19 周目開始時に確認済) と矛盾。

### 案 B: page module に `export const metadata` (= 採用)

```tsx
// PostDetailPage.tsx
import type { MetadataFn } from "@vidro/hibana";

export const metadata: MetadataFn<{ post: Post }> = ({ post }) => ({
  title: post.title,
  description: post.excerpt,
  meta: [
    { property: "og:title", content: post.title },
    { name: "twitter:card", content: "summary" },
  ],
  link: [{ rel: "canonical", href: `/posts/${post.slug}` }],
});

export function PostDetailPage({ post }: Props) {
  return <article>{post.body}</article>;
}
```

```ts
// app.ts (= c.render は変更なし)
postsRoutes.get("/:id", (c) => {
  const post = getPost(c.req.param("id"));
  return c.render(PostDetailPage, { post });
});
```

**採用**。Next.js App Router の `export const metadata` と整合 (= AI フレンドリー / 既知 pattern)。

**pros**:

- **Streaming SSR 互換** = module top-level export なので component evaluate せずに metadata を取り出せる → 将来 streaming に進化させる時 `<head>` を body 評価前に flush 可能 (= TTFB 改善 / early hints)。今 Hibana は `renderToString` だけだが、Hono 上に薄く乗る identity (= Hono の stream 機構を活かす) と将来整合
- **Compound type** = `Metadata` 1 個に集約、IDE 補完 / 型 / migration が網羅的、`name: "descriptipon"` typo が build error 化
- **Noun-first** (memory `project_fw_design_stance`) = `export const metadata` が宣言的 (= 「これは metadata である」)、JSX `<Head>` は描画的 (= 「これを描画する」) で混在
- **dedup / merge ロジック不要** = parent layout の metadata + child page の metadata を object spread で merge できる (= 1 行、Step 4 (3) layout pattern 設計時に着地)
- **機構実装軽量** = Vite plugin の transform で `export const metadata` を発見、default export function に `.metadata` を attach するだけ (= Phase B-1 で defineIsland auto-wrap した同じ手法)

**cons**:

- **scope 制限** = function 形式 `(props) => ({...})` で props のみ触れる、server scope の他 primitive (= 例えば将来の loaderData / ALS 経由 context) は触れない。`Metadata` の function を server scope で eval する hook を将来追加する余地は残せる
- **JSX 表現力なし** = conditional / loop は object 内で書く (= `meta: post.tags.map(t => ({...}))` 等は書ける、JSX `<Head>` 程の自由度ではないが MVP scope では困らない)

### 案 C: `<Head>` component を JSX 木に埋める

```tsx
import { Head } from "@vidro/hibana";

export function PostDetailPage({ post }: Props) {
  return (
    <>
      <Head>
        <title>{post.title}</title>
        <meta name="description" content={post.excerpt} />
      </Head>
      <article>{post.body}</article>
    </>
  );
}
```

**却下** — HonoX / Astro / Inertia / React Helmet 流。本 ADR で最後まで残った対抗案。却下理由:

- **streaming SSR 阻害** = body 内 `<Head>` を render しないと head 確定しない、stream model と構造的に矛盾
- **portal 機構が重い** = JSX 木の任意位置の `<Head>` を抽出して `<head>` に hoist する transform が必要、`renderToString` の hook 改造が機構複雑度を大きく上げる
- **dedup ロジック必要** = layout の `<Head>` + page の `<Head>` を tag/key 単位で merge する portal-side のロジック、React Helmet 級に肥大化リスク
- **type 安全性低い** = `<meta name="descriptipon">` の typo が build error にならない (= JSX `<meta>` 標準 type に依存)
- **compound type 提供しにくい** = openGraph / twitter / robots 等を JSX で表現するには別 component 群 (= `<OpenGraph>` `<Twitter>` 等) が要る、案 B の object compound に対して非整合

Hibana の薄さ哲学 (= JSX 一本化 + 機構を user 語彙から消す) からは C の方が綺麗に見えたが、streaming + 機構実装軽量 + AI フレンドリー compound type の 3 点で B が構造的に優位と判断。

### 案 D: 案 B + 案 C 両方提供 (Astro 流)

**却下** — API が 2 つに増える = user が「どっち使えばいい?」で迷う + memory `project_api_design_philosophy_object_one_spread` の「機構知識を primitive に閉じる」と逆行。Astro は static export + JSX `<Head>` 両対応だが、Hibana は MVP scope を絞る。

## Decision

**案 B 採用**。

### API shape

```ts
// @vidro/hibana から export する型のみ (= runtime 追加 export ゼロ)
type Metadata = {
  title?: string;
  description?: string;
  charset?: string; // default "utf-8"
  viewport?: string; // default "width=device-width, initial-scale=1"
  meta?: Array<MetaTag>;
  link?: Array<LinkTag>;
  // 将来拡張余地 (= dogfood で困ったら): openGraph / twitter / robots / icons の compound type
};

type MetaTag = {
  name?: string;
  property?: string;
  "http-equiv"?: string;
  content: string;
};

type LinkTag = {
  rel: string;
  href: string;
  hreflang?: string;
  type?: string;
  sizes?: string;
};

type MetadataFn<P> = (props: P) => Metadata;
```

### 機構

1. **Vite plugin transform** (= `packages/hibana/src/vite.ts` に追加):
   - `.tsx` ファイルで `export const metadata = ...` を検出
   - default export function の末尾に `<DefaultExport>.metadata = metadata;` を attach する line を AST で挿入
   - Phase B-1 で defineIsland auto-wrap した同じ babel transform path に乗る (= 既存基盤を再利用)

2. **`hibana()` middleware の renderer** (= `packages/hibana/src/index.ts`):
   - `c.setRenderer((Component, props) => ...)` 内で `(Component as { metadata?: Metadata | MetadataFn<P> }).metadata` を読む
   - function なら `metadata(props)` で eval、object ならそのまま使う、undefined なら skip
   - shell HTML の `<head>` を default + page metadata で merge して `c.html(...)` で返す

3. **Merge ルール (v1)**:
   - `title` / `description` / `charset` / `viewport` = page が設定してれば **override** (= 後勝ち)
   - `meta` / `link` = **append** (= simple concat、dedup は v1 では skip)
   - dedup は dogfood で同 `name` / 同 `rel+href` が重複して困ったら強化 (= v2 で `name` 単位 dedup、現状 YAGNI)

### Scope (= MVP)

| 項目                                       | 含む | 理由                                                          |
| ------------------------------------------ | ---- | ------------------------------------------------------------- |
| `title` / `description`                    | ✓    | 全 route に必要、MVP 必須                                     |
| `charset` / `viewport`                     | ✓    | default 提供、override 余地                                   |
| `meta` 配列 (name/property/http-equiv)     | ✓    | OG / Twitter / robots を array で表現可能                     |
| `link` 配列 (rel/href/hreflang/type/sizes) | ✓    | canonical / alternate / icon / stylesheet を array で表現可能 |
| `openGraph` compound type                  | ✗    | array `meta` で表現可能、compound 化は dogfood で困ったら     |
| `twitter` compound type                    | ✗    | 同上                                                          |
| `robots` compound type                     | ✗    | 同上                                                          |
| `icons` compound type                      | ✗    | array `link` で表現可能                                       |
| client-side document.title 更新            | ✗    | Step 5 navigation 設計時に決める                              |
| parent layout metadata merge               | ✗    | Step 4 (3) layout pattern 設計時に決める                      |

## Consequences

### 良くなること

- per-route で `<title>` / `<meta>` / `<link>` を変えられる (= MVP の必須要件着地)
- streaming SSR への進化道筋を残せる (= module top-level export 採用で body 評価不要)
- AI フレンドリー (= `Metadata` compound type の IDE 補完、`name` typo 検出)
- 機構複雑度 minimal (= Phase B-1 と同じ Vite plugin transform path)
- breaking 変更ゼロ (= 既存 hibana-demo は metadata なしで動く、default fallback)

### Trade-off / 持ち越し

- function 形式の metadata で server scope の他 primitive (= 例えば ALS context) に触れない (= 将来 loader 機構を入れる時に再検討、Hibana にはまだ loader が無い)
- meta / link の dedup を v1 では skip = duplicate 出る可能性 (= dogfood で困ったら強化)
- parent layout metadata merge = Step 4 (3) layout pattern 設計時に着地、本 ADR では single page だけ扱う
- client-side document.title 更新 = Step 5 navigation 設計時に着地、本 ADR では SSR の初回 HTML だけ扱う

### 拡張余地 (= 将来 ADR or dogfood trigger)

- **opt-in compound type**: `openGraph` / `twitter` / `robots` を `Metadata` に追加、`meta` array の syntactic sugar として実装、dogfood で OG/Twitter の repetition が苦痛になったら起票
- **client-side metadata update**: Step 5 navigation 後の `<head>` swap、document.title 更新、`<link rel="canonical">` 更新等。navigation 設計と一体で
- **layout metadata merge**: parent layout module の `export const metadata` と child page module の `export const metadata` を deep merge、Step 4 (3) layout pattern 設計時に
- **streaming SSR**: body 評価前に `<head>` flush、stream model 採用時に
- **dedup 強化**: `meta name` 単位 / `link rel+href` 単位 dedup、dogfood で困ったら

## 関連

- `project_hibana_overview` = Hibana 全体像
- `project_hibana_vidro_interaction` = Vidro との合流 hygiene
- `feedback_dx_first_design` = target syntax 起点設計
- `feedback_ai_first_api_design` = AI フレンドリー compound type
- `project_api_design_philosophy_object_one_spread` = 機構知識を primitive に閉じる
- `project_fw_design_stance` = noun-first 整合
- docs/roadmap-hibana.md = Step 4 (2) 該当
