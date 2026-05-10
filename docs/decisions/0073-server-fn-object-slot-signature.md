# 0073 — serverFn signature を object slot form に改修 (= 流派 1 + 型付き ctx)

## Status

**Accepted** — 2026-05-10 (63rd session、dogfood 第 5 周目完走で着地確定)

経緯:

- 2026-05-10 (62nd): Proposed として起票 + path B / 流派 1 / c 完全排除 / 型付き ctx / 2 slot YAGNI を決定
- 2026-05-10 (63rd): Phase 1〜5 + dogfood 完走、`Accepted` に昇格

着地時 commit: `ae11663 feat: ADR 0073 着地 — serverFn を object slot form に改修` (router 169 + zod 4 + plugin 40 tests pass、apps/blog vp build (SSR + client) 成功、curl smoke で createPost / updatePost (URL params + data 同時) / deletePost / 422 validation error 全通過)

依存: ADR 0070 (server function pattern)、ADR 0072 (pure handler signature)
関連: ADR 0071 (`@vidro/zod`)、ADR 0069 (`@vidro/form`)、ADR 0067 (per-route +types codegen)、ADR 0057 (fw design stance)
**Supersedes**: ADR 0070 論点 7-A (位置引数で dyn segment を受ける)、ADR 0072 論点 1-C (`(input, c?: Context)` 末尾 optional form)、ADR 0071 `validator(schema)` middleware (= router の serverFn config の validator slot に統合)

## Context

ADR 0072 第 4 周目 dogfood (61st session) で **F1 (validator middleware × URL 動的 segment 共存不可)** が顕在化。

### F1 の構造

```
posts/[slug]/edit/server.ts:
  serverFn(validator(schema), async (slug, input, c) => ...)

dispatcher が handler(...params, ...bodyArgs, c) で呼ぶ:
  → ["abc-slug", { title, body }, c]

validator middleware が next([parsed.data]) で args 全 override:
  → [{ title, body }, c]   ← URL [slug] が消える
```

回避策: serverFn を `[slug]/` dir の上に移して slug を schema に詰め込む (= 第 4 周目で採用、commit `1dae607`)。ただし **本来 `[slug]/edit/` co-location に置きたい server function が違う dir に追いやられる** 構造的問題を残した。

根本原因 = **`next(overrideArgs)` が args を全 override する設計**。middleware が args の特定 slot だけ更新する経路がない、handler が positional args で受けるので middleware の責務 (URL params / body / ctx) が分離できない。

### user 視点の違和感 (62nd session)

- **「引数の順番で wire 規約が決まる」のが意味不明** = file path (`posts/[slug]/edit/`) と handler 引数順 (`(slug, input, c)`) の暗黙対応、規約を覚える必要、入れ替えると静かに壊れる
- **「server function は普通の関数のフリしてるけど実体は HTTP request」** に user が腹落ち、「業界 default が `1 引数 object` に揃う構造的理由」(= wire は HTTP request 1 つ) を理解
- **AI に書かせる前提で API design** = flat object literal が AI 補完と相性良い (memory `feedback_ai_first_api_design`)

### 業界 cross-check

| FW             | 引数の数  | 形                    | slug の取り方         |
| -------------- | --------- | --------------------- | --------------------- |
| Next.js        | 実質 1 個 | `FormData` + bind     | hidden input or bind  |
| TanStack Start | 1 個強制  | `{ data, ctx }`       | `data.slug`           |
| Remix          | 1 個強制  | `{ params, request }` | `params.slug`         |
| Hono           | 1 個強制  | `c`                   | `c.req.param('slug')` |
| **Vidro 現状** | **複数**  | **位置引数**          | **第 1 引数**         |

業界は「wire を挟む以上、引数 1 個に揃える」が圧倒的多数派。Vidro の positional は Rust Actix / C# Minimal API の DNA、JS で誰も達成してない (= memory `project_positional_vs_slot_design_question`)。

### Vidro 哲学整合 (memory cross-check)

| memory                               | 関係                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `project_design_north_star`          | RSC simpler 代替 + AI フレンドリー副産物 = object slot で同方向                             |
| `project_layer_separation_principle` | handler は application 層、HTTP は infrastructure = handler から `c` 排除                   |
| `project_legibility_test`            | `params.slug` は読めば分かる、`c.req.valid('param').slug` は Hono 知識必要                  |
| `project_type_vertical_propagation`  | file path → params 型 → handler の経路が直接的に通る                                        |
| `feedback_dx_first_design`           | target syntax を起点に逆引き、user が書くコード優先                                         |
| `feedback_ai_first_api_design`       | flat object > builder chain、AI 補完優先 (62nd 確認、副産物から decision criteria に格上げ) |
| `project_form_design_decided`        | formControl の data slot と wire の data slot が一貫、schema 共有                           |
| `project_3tier_architecture`         | 薄い core + split-when-confused、object 1 個渡しで実装軽量                                  |

## Options

### 論点 1: handler の引数の取り方

#### (1-A) Hono 流 `(c) => ...` (= path A)

```ts
serverFn(authMw, validator("param", paramsSchema), validator("json", dataSchema), async (c) => {
  const slug = c.req.valid("param").slug;
  const data = c.req.valid("json");
  const user = c.var.user;
});
```

- pros: Hono 互換 max、業界知識ストック流用、wire 露出 (= 「これは HTTP」と自覚させる)
- cons:
  - handler が **`c` (= HTTP) を知る必要** = ADR 0072 の pure service form 後退
  - **層分離原則違反** (= handler が application 層、HTTP は infrastructure、memory `project_layer_separation_principle`)
  - legibility 落ちる (= `c.req.valid('param').slug` は Hono 知らないと読めない)

→ **却下** (= ADR 0072 路線後退)

#### (1-B) TanStack 流 object slot `({ params, data, ctx }) => ...` (= path B、**採用**)

```ts
serverFn({
  middleware: [authMw],
  validator: { params: paramsSchema, data: dataSchema },
  handler: async ({ params, data, ctx }) => {
    return await db.posts.update(params.slug, data);
  },
});
```

- pros:
  - **handler は HTTP 知らない pure service form** (= ADR 0072 路線継続 + 強化)
  - **層分離整合** (= application 層に閉じる)
  - **legibility OK** (= `params.slug` はモデルなしで読める、memory `project_legibility_test`)
  - **F1 構造的解決** (= URL params slot と body data slot が独立、middleware の args 衝突なし)
  - **formControl と一貫** (= ADR 0069 の data slot と wire の data slot が同名、schema 共有)
- cons:
  - 全 package (router / zod / plugin / blog) breaking change
  - middleware Out 型 accumulate に TS variadic 必要 (= 流派 1 + 型付き ctx 採用時)

→ **採用** (= Vidro 哲学全方位整合)

#### (1-C) positional 死守 `(slug, input) => ...` (= path C)

TS variadic で middleware Out 型 accumulate、Rust Actix DNA を JS で完成。

- pros: 「見た目が普通の関数」、思想実験として面白い (= memory `project_vidro_position_synthesis` Marko DNA)
- cons:
  - **F1 が構造的に解決不能** (= middleware の args 衝突)
  - **user 自身が違和感表明** (= 順番依存、入れ替えると静かに壊れる、規約勉強コスト)
  - 業界 (Hono/TanStack/Remix/Next.js) が全て object 1 個に収束した構造的理由 (= wire は HTTP request 1 つ) と逆行
  - 実装 1〜2 週間級の TS 変態芸、保守困難

→ **却下** (= F1 構造的解決不能 + user 直感違反)

### 論点 2: serverFn の呼び出し形 (path B 内部の論点)

#### (2-1) object 1 個渡し `serverFn({ middleware, validator, handler })` (= **採用**)

- pros: **一番薄い** (= option 1 個)、AI 補完が全 option 一覧、Vidro 独自ポジション
- cons: middleware list の Out 型 accumulate に TS variadic 必要

→ **採用** (= memory `feedback_ai_first_api_design` + 「薄いもの」優先)

#### (2-2) builder chain `.middleware().validator().handler()` (= TanStack Start)

- pros: 各段で型確定、TS variadic 不要、実装易
- cons: 冗長 (= 関数呼び出し 4 回)、AI 補完で「次に何を呼ぶ」毎段推論、Vidro = 「TanStack 劣化版」化

→ **却下** (= AI フレンドリー優先、Vidro 独自ポジション維持)

#### (2-3) 可変長 args (= Hono 流)

- pros: Hono mental model 直行
- cons: validator が middleware 列に混ざるので分離が崩れる、F1 が再発する形

→ **却下** (= path A と等価)

### 論点 3: handler から `c` (Context) を完全排除するか

#### (3-i) 完全排除 (= **採用**)

handler は `({ params, data, ctx })` のみ、c は middleware だけ扱える。

- pros: layer 分離完全、業界 default (= TanStack/next-safe-action と一致)
- cons: redirect / header 設定の edge case は middleware 経由 or `throw redirect()` で対応必要

→ **採用** (= ADR 0072 路線の自然な進化)

#### (3-ii) 末尾 optional `({ params, data, ctx }, c?: Context) => ...`

- pros: 1 割 edge case で c に手が届く、ADR 0072 の絵受け継承
- cons: 9 割 handler で `_c` 受け、layer 分離 1 割漏れ

→ **却下** (= layer 分離完全採用、edge case は middleware で吸収)

### 論点 4: ctx inject の作法

#### (4-p) 型付き ctx (= TanStack 流、**採用**)

```ts
const authMw = defineMiddleware<{ user: User }>(async ({ c, next }) => {
  const user = await verifyToken(c.req.headers.get("authorization"));
  return next({ ctx: { user } });
});

serverFn({
  middleware: [authMw, requestIdMw],
  handler: async ({ ctx }) => {
    ctx.user; // typed: User       ← 自動推論
    ctx.requestId; // typed: string     ← 自動推論
  },
});
```

middleware list の Out 型を accumulate、handler の ctx 型を自動合成。

- pros: 型貫通完全 (= memory `project_type_vertical_propagation` Vidro identity の核)、user は ctx 型書かない
- cons: TS variadic で middleware Out 型 accumulate 実装必要 (= 流派 1 採用なので array 経由、流派 2 builder より少し難しい)

→ **採用** (= Vidro identity 維持)

#### (4-q) Hono 風 c.var weak typed

middleware が `c.var.user = ...` で set、handler が ctx 型を annotation で書く。

- pros: 実装軽い、TS 芸不要
- cons: 型貫通後退 (= Vidro identity に逆行)、user が毎回 ctx 型を書く必要

→ **却下** (= Vidro identity 維持)

### 論点 5: validator slot の拡張範囲

#### (5-x) 今回 `params` + `data` の 2 個のみ (= **採用**、YAGNI)

dogfood で困ったら拡張、第 5 周目までは 2 slot で完走想定。

#### (5-y) 初期から `query` `form` `multipart` も slot として受ける

- pros: 将来 breaking change 回避
- cons: YAGNI 違反、dogfood で具体痛みなし

→ **却下** (= split-when-confused、memory `project_3tier_architecture`)

## Decision

**path B (object slot) + 流派 1 (object 1 個渡し) + (3-i) c 完全排除 + (4-p) 型付き ctx + (5-x) params/data 2 slot** を採用。

### 確定 target syntax

```ts
// 宣言 (= server.ts、posts/[slug]/edit/server.ts に co-location 復活)
import { serverFn, defineMiddleware } from "@vidro/router";
import { z } from "zod";

const authMw = defineMiddleware<{ user: User }>(async ({ c, next }) => {
  const token = c.req.headers.get("authorization");
  const user = await verifyToken(token);
  return next({ ctx: { user } });
});

const paramsSchema = z.object({ slug: z.string() });
const dataSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
});

export const updatePost = serverFn({
  middleware: [authMw],
  validator: { params: paramsSchema, data: dataSchema },
  handler: async ({ params, data, ctx }) => {
    return await db.posts.update(params.slug, data);
  },
});

// 呼び出し (= edit-form.tsx)
import { updatePost } from "./server";

await updatePost({
  params: { slug: post.slug },
  data: { title, body },
});
```

## Consequences

### 改修必要 package

1. **packages/router**
   - `serverFn(...args)` → `serverFn({ middleware, validator, handler })` に rewrite
   - `Handler<Args, R>` 型 → `Handler<Params, Data, Ctx, R>` 型に再定義
   - `ServerFnInternal` / `ServerFnPublic` / `ServerFn` 型を object 入力 + ctx accumulation 用に再定義
   - `dispatchServerFn` の handler 呼び出しを `({ params, data, ctx })` 形式に変更
   - `Middleware<TIn, TOut>` を `({ c, ctx, next }) => Promise<...>` 形に変更、`defineMiddleware<TOut>` factory を追加
   - 既存 `Context` 型は維持 (= middleware が引き続き使う)

2. **packages/zod**
   - `validator(schema)` middleware を廃止、`validator: { params, data }` を serverFn option 内に直接書く形に変更
   - `fieldsFromZodError` helper は維持
   - `ServerFnValidationError` は維持 (= client 側 throw shape は変わらず)

3. **packages/plugin**
   - `__vidroServerFnStub` の URL template 埋め込みを「object.params から URL に展開、object.data を body に詰める」に変更
   - server-side dispatch の bodyArgs decode を「`{ params, data }` の object として decode」に変更
   - server-fn-transform は handler signature 検出ロジックを object slot 用に更新

4. **apps/blog (= dogfood 第 5 周目)**
   - `posts/server.ts` の updatePost / deletePost を `posts/[slug]/edit/server.ts` / `posts/[slug]/delete/server.ts` に co-location 復活 (= F1 解消)
   - `posts/new/server.ts` の createPost を新 syntax に migration
   - edit-form.tsx / delete-button.tsx / new-form.tsx の呼び出し側を `{ params, data }` 形式に更新
   - schema 分離 (= paramsSchema + dataSchema)、formControl の `<input type="hidden" name="slug" />` 撤去

### Migration plan (= Phase 分け)

- **Phase 1**: packages/router の `serverFn` factory + 型定義の rewrite、unit test 全 pass
- **Phase 2**: packages/router の `dispatchServerFn` 改修、server-fn-dispatch test 全 pass
- **Phase 3**: packages/zod の validator slot 統合、validator test 全 pass
- **Phase 4**: packages/plugin の `__vidroServerFnStub` + server-fn-transform 改修
- **Phase 5**: apps/blog 全 server function を新 syntax に migration、Playwright で edge to edge dogfood (= 第 5 周目)
- **Phase 6**: code-reviewer agent で review、commit + push

### Breaking changes

ADR 0070 / 0072 の signature 全部 supersede。本 ADR 着地で:

- 旧 `serverFn(...mw, handler)` 形式は **動かない**
- 旧 `(slug, input, c) => ...` の handler signature は **動かない**
- 旧 `validator(schema)` middleware は **動かない**

apps/blog 以外に user code は無いので migration は blog 1 箇所のみ。

### 旧 ADR との関係

- **ADR 0070**: 全面 supersede (= positional + variadic 設計)。Phase 1 / 2a / 2b / 2c / 7 完走分も本 ADR で書き換わる
- **ADR 0072**: pure service form 路線は維持、ただし object slot で再表現。`(input, c?)` 末尾 optional form は廃止、`({ params, data, ctx })` に置き換わる
- **ADR 0071**: `@vidro/zod` の `validator` middleware は廃止、`fieldsFromZodError` + `ServerFnValidationError` は維持
- **ADR 0069**: `formControl` の data slot は変更なし、wire の data slot と一貫性が増す方向で進化

## Open Questions

### Q1: `defineMiddleware` の正確な API shape

middleware の Out 型を表明する factory:

```ts
defineMiddleware<{ user: User }>(async ({ c, ctx, next }) => {
  return next({ ctx: { user } });
});
```

vs builder chain で連鎖する形:

```ts
defineMiddleware()
  .out<{ user: User }>()
  .handler(async ({ c, next }) => ...);
```

→ **factory 一発が薄い、builder chain は YAGNI**。Phase 1 で factory 採用、dogfood で困れば再考。

### Q2: ctx の merge 規則

middleware A が `ctx: { user }` を inject、middleware B が `ctx: { user: differentUser }` を inject した時、後勝ち or 衝突 throw か。

→ **後勝ち** (= JS object spread と同じ semantics)、TS 型も `A_Out & B_Out` の intersection で B 側が後勝ち。Phase 1 実装で確定。

### Q3: redirect / response status の edge case 処理

handler から HTTP response を細かく制御したい case (= `Set-Cookie`、特定 status code) はどう書くか。

選択肢:

- (a) `throw redirect('/login')` / `throw new Response(...)` で統一 (= Remix 流)
- (b) handler の戻り値型を `Result<R> | Response` の union で表現
- (c) middleware で post-processing (= `next()` 後に header inject)

→ **(a) throw 流が一番薄い**、Phase 5 dogfood で具体例出れば再考。

### Q4: validator slot の extension point

将来 `query` / `form` / `multipart` slot を追加する時、API は破壊しないか。

→ `validator: { params, data }` の object なので **新 slot を optional key で追加するだけ**、既存呼び出しは無傷。

### Q5: `c` の middleware への渡し方

middleware は `c` を受ける必要 (= HTTP 入力読む) があるが、ctx accumulation 用の builder と同居する形。

```ts
defineMiddleware<{ user: User }>(async ({ c, ctx, next }) => {
  // c: HTTP Context
  // ctx: 前段までの ctx accumulation
  // next: 次段に進む、optional で ctx delta を渡す
});
```

→ Phase 1 実装で `({ c, ctx, next })` の 3 引数 destructure 採用。
