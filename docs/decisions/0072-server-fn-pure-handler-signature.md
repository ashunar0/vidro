# 0072 — serverFn handler signature を pure service form (= c は末尾 optional) に改修

## Status

**Proposed** — 2026-05-10 (60th session)

依存: ADR 0070 (server function pattern)
関連: ADR 0071 (`@vidro/zod`)、ADR 0049 (loaderData)、ADR 0057 (fw design stance)、ADR 0066 (async server component / `getRequestEnv`)
**部分 supersede**: ADR 0070 論点 6 (= Hono c subset を **handler から外して middleware に閉じる**) + 論点 7 (= 位置引数構造で c の位置を末尾 optional に再定義)

## Context

ADR 0070 Phase 7 (= dogfood、apps/blog) で以下の違和感が user 視点で顕在化した:

- `serverFn(async (c, input) => ...)` の `c` が handler signature に出てる
- 9 割の handler では `c` を使わない (= `_c` で受けてる)
- handler の責務は **service** (= business logic) に近いのに、Hono 流の **handler** (= HTTP 境界) signature を被っている
- 3 層分離 (= memory `project_layer_separation_principle`) で言うと service 層に書きたいコードに HTTP 境界の `c` が混入

Vidro 北極星 (= memory `project_design_north_star` / `project_vidro_rsc_like_core_model`) は **「server function を `await fn(input)` で呼ぶ pure な関数として見せる」** こと。tRPC / TanStack Start 等の RPC 系 FW と同じ流派。なら handler 自身も pure に書けるべき、というのが本 ADR の動機。

ADR 0070 論点 6 で「Hono c subset を採用」と decide した時は、Hono pattern 踏襲を最優先した。dogfood で実コードを書いてみて、Vidro identity (= RPC 系、3 層分離整合) 重視で見直す段階。

### Vidro 哲学整合 (memory cross-check)

| memory                               | 関係                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `project_design_north_star`          | RSC simpler 代替 = handler が pure 関数に見える方向                                           |
| `project_vidro_rsc_like_core_model`  | invoke-once + HTML wire = handler 自身も「ただの関数」感                                      |
| `project_layer_separation_principle` | 3 層分離 (handler / service / repository)、handler 層は機構が hide、user code は service 寄り |
| `project_legibility_test`            | 「c なし `(input) => R` = pure な関数」と日本語訳できる、合格                                 |
| `project_type_vertical_propagation`  | typed input が引数として直接来る = 型貫通 #4 + #9 完成                                        |
| `project_fw_design_stance`           | strong default + 強制ゼロ、c が必要なら optional 後置で対応                                   |
| `feedback_dx_first_design`           | dogfood 第 7 周目で気付いた DX 痛み点を起点に signature 見直し                                |

## Options

### 論点 1: handler signature の form

#### (1-A) 現状維持 `(c: Context, ...args: P) => R`

- pros: ADR 0070 既存実装、Hono 流 (= `app.post(..., (c) => ...)`) と互換、c 必要時に手が届く
- cons: c 不要な handler でも `_c` で受ける、handler が pure に書けない、3 層分離原則と微妙に逆 (= handler signature に HTTP 境界の `c` が混入)

#### (1-B) c 完全削除 `(...args: P) => R`、c は ALS `getContext()` で取る

```ts
serverFn(async (input) => {
  const c = getContext(); // ALS magic
});
```

- pros: signature が完全に pure
- cons: **物理判定原則違反** (= memory `project_legibility_test`、`getContext()` がどこから引くか handler を読んでもわからない magic)、Vidro 哲学と逆向き、Server Actions / RSC が落ちた罠

→ **却下** (= magic 最小化原則違反)

#### (1-C) c を最後に optional 後置 `(...args: [...P, c?: Context]) => R` (= **採用**)

```ts
// 9 割 case: c 不要な pure service
serverFn(validator(schema), async (input) => {
  return db.posts.insert(input);
});

// 1 割 case: c 必要 (= auth header / redirect)
serverFn(validator(schema), async (input, c) => {
  const ua = c.req.headers.get("user-agent");
  return db.posts.insert({ ...input, ua });
});
```

- pros:
  - **9 割 handler が pure に書ける** = signature に HTTP 境界が出ない、3 層分離整合
  - **1 割 edge case (auth header / redirect 等) は c で対応** = magic 不要、物理判定原則整合
  - TS variadic tuple で実装可能 (= `[...P, c?: Context]`)
  - **既存 Hono 知識流用可能** = c 必要時の API は Hono と同じ
- cons:
  - ADR 0070 Phase 1 + 2c の Handler 型 + dispatch 改修必要 (= breaking change)
  - 影響範囲: `packages/router/src/server-fn.ts` + 既存 router test 26 件 + apps/blog 既存 server.ts 3 本

→ **採用** (= Vidro identity 整合 + edge case 対応 + 物理判定原則維持)

#### (1-D) destructured object form `({ input, c }) => R`

```ts
serverFn(validator(schema), async ({ input, c }) => {
  return db.posts.insert(input);
});
```

tRPC / TanStack Start 流。

- pros: 引数順序を user が気にしなくて良い、`{ ctx, input, env }` 等で property 追加が容易 (= 後方互換)
- cons:
  - ADR 0070 既存 signature (= variadic tuple `(c, ...args)`) からの大変更
  - 引数 1 個 (object) になるので、`serverFn(...mw, handler)` の最後を destructure check するのが冗長
  - dyn segment が複数あると `{ slug, id, input, c }` 等 destructure 順序で曖昧

→ **却下** (= ADR 0070 既存 variadic tuple 設計と整合性低、(1-C) の方が改修小さい)

### 論点 2: middleware signature の form

#### (2-A) 現状維持 `(c: Context, next: () => Promise<void>) => ...` (= **採用**)

middleware は context を扱うのが本職。handler から c を移動しても middleware は維持。

- pros: middleware = c の世界、handler = input の世界 という関心事分離が機構レベルで成立、ADR 0070 既存 middleware 実装ゼロ改修
- cons: なし

→ **採用** (= 改修ゼロ、関心事分離整合)

### 論点 3: dispatch 経路 (= server-fn.ts:435 改修)

#### (3-A) handler 引数末尾に c を spread `entry.handler(...params, ...bodyArgs, c)` (= **採用**)

handler signature が `(...args, c?: Context)` なので、c を最後に渡す。

- pros: handler signature と整合、handler が c を受けない場合も TS variadic で無視される (= safe、runtime arity チェックなし)
- cons: なし

→ **採用**

#### (3-B) c を runtime で injection (= ALS 経由)

→ 却下 ((1-B) と同じ理由)。

### 論点 4: ADR 0070 論点 6 + 7 との関係

#### (4-A) 論点 6 を **partial supersede**、論点 7 を維持 (= **採用**)

- 論点 6 (= Hono c subset 採用): **handler から外して middleware に閉じる**、c subset 自体は維持 (= middleware が引き続き使う)
- 論点 7 (= 位置引数 dyn segment + body): **維持**、c は最後 optional として後置

→ ADR 0070 の構造 (= variadic tuple、bundler が body decode して handler 引数注入) は維持、c の位置だけ末尾 optional に変更。

→ **採用**

### 論点 5: ADR 0071 (`@vidro/zod`) validator middleware との連動

#### (5-A) middleware の next() で input override、type 連鎖 (= **採用**、ADR 0071 補足で詳細化)

```ts
// Middleware 型 generic 化 (本 ADR で決定)
type Middleware<TIn = unknown, TOut = TIn> = (
  c: Context,
  next: (overrideArgs?: readonly unknown[]) => Promise<void>,
) => Promise<void | Response> | void | Response;

// validator 実装 (ADR 0071 Phase 6 で実装)
const validator = <S extends z.ZodSchema>(schema: S) => {
  return ((c, next) => {
    const body = c.var.body; // dispatch が body を c.var に詰める (= bodyArgs.length === 0 の引数なし fn では undefined)
    // validator は **input ある fn 専用前提** — 引数なし fn に付けると
    // schema.safeParse(undefined) で 422 になる (= 60th session review で確認)。
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw createValidationError(parsed.error);
    return next([parsed.data]); // handler の input 引数を override
  }) as Middleware<unknown, z.infer<S>>;
};

// handler は typed input を受ける
serverFn(validator(schema), async (input) => { ... });
//                                  ^^^^^ z.infer<typeof schema> typed
```

- pros: ADR 0071 dream code 完成、型貫通 #4 + #9 整合、validator が handler の input を typed で渡す経路が機構レベルで成立
- cons: ADR 0070 Phase 1 の Middleware 型 + dispatch 改修必要 (= 論点 1-C 改修と同 commit に含める)

→ **採用** (= ADR 0071 起票動機との整合、本 ADR と連動着地)

## Decision (= 5 論点まとめ)

| #   | 論点                 | 決定                                                                   |
| --- | -------------------- | ---------------------------------------------------------------------- |
| 1   | handler signature    | **(1-C) `(...args: [...P, c?: Context]) => R`** (= c 最後 optional)    |
| 2   | middleware signature | **(2-A) 現状維持 `(c, next)`**                                         |
| 3   | dispatch 経路        | **(3-A) `entry.handler(...params, ...bodyArgs, c)`** (= c 末尾 spread) |
| 4   | ADR 0070 関係        | **論点 6 partial supersede + 論点 7 維持**                             |
| 5   | ADR 0071 連動        | **(5-A) middleware next() で input override + 型連鎖**                 |

### Scope (= 本 ADR で扱う / 扱わない)

| 項目                                                                               | 本 ADR で扱う?                                    |
| ---------------------------------------------------------------------------------- | ------------------------------------------------- |
| Handler 型を `(...args: [...P, c?: Context]) => R` に変更                          | ✅                                                |
| dispatch を `entry.handler(...params, ...bodyArgs, c)` に変更                      | ✅                                                |
| Middleware 型を `Middleware<TIn, TOut>` generic + next() input override 経路に変更 | ✅ (ADR 0071 連動)                                |
| ADR 0070 既存 router test 26 件の signature 修正                                   | ✅                                                |
| `apps/blog` 既存 server.ts 3 本の Path 4 書き換え                                  | ✅                                                |
| ADR 0071 (`@vidro/zod`) validator + helper の実装本体                              | ❌ (= ADR 0071 Phase 6 で別途、本 ADR 着地後着手) |
| ALS 経由の getContext() helper                                                     | ❌ (= 物理判定原則違反、却下)                     |
| destructured object form (`{ input, c }`) への移行                                 | ❌ (= 論点 1-D 却下)                              |
| validation error の wire shape (= 422 + fields)                                    | ❌ (= ADR 0059 / 0071 で既に decide)              |

## Rationale

### Vidro 北極星 (= RPC simpler 代替) との整合

memory `project_design_north_star` で Vidro 北極星 = **「RSC の simpler 代替、server function を `await fn(input)` で呼ぶ pure な関数として見せる」** と decide。tRPC / TanStack Start (= 同じ RPC 系) は既に handler signature を pure に倒してる (= `({ ctx, input }) => R` 等)。

Vidro が Hono 流 (= `(c) => R`) を採用したのは ADR 0070 論点 6 で **Hono pattern 踏襲を最優先** したため。dogfood で実コードを書いてみて、Vidro identity (= RPC 系) 整合の方が重要と判断。

handler signature を pure に倒すことで:

- user code が service 層と signature 一致 (= 「これは pure service」と読める)
- 3 層分離原則 (= memory `project_layer_separation_principle`) が機構レベルで支援
- Hono 流の handler/service 分離が「serverFn 1 個に圧縮」される (= boilerplate ゼロ + pure 維持)

### Path 1-B (ALS getContext) 却下理由

ALS 経由で c を引く案 (= Server Actions / RSC 流) は handler signature を最も pure にできる (= `(input) => R`)。しかし:

- **物理判定原則違反** (= memory `project_legibility_test`): `getContext()` がどこから引くか handler を読んでもわからない (= magic)
- **Server Actions / RSC が落ちた罠**: Next.js `cookies()` / `headers()` の magic は user 学習コスト、debug 時の追跡困難
- Vidro 哲学 (= AI-native / 物理判定 / magic 最小化) と正面衝突

Path 1-C (= optional 後置) は **9 割 pure + 1 割明示** という折衷で、magic を導入しない。

### Path 1-D (destructured object) 却下理由

tRPC / TanStack Start は `({ ctx, input })` destructured object form を採用、これは現代 RPC FW の主流。しかし:

- ADR 0070 既存 signature (= variadic tuple `(c, ...args)`) からの大変更が必要
- `serverFn(...mw, handler)` の最後を destructure check するため、TS variadic tuple types で扱いづらい
- dyn segment が複数あると `{ slug, id, input, c }` 等 destructure 順序が曖昧

Path 1-C (= variadic tuple 維持 + c 末尾 optional) は ADR 0070 既存設計と最小差分で済む。

### `getRequestEnv` (= ADR 0066) との並行存続

ADR 0066 で `getRequestEnv<T>()` は ALS 経由の env 取得 helper として handler 内で使える。本 ADR でも引き続き使える (= 改修なし、c.env と並行存続):

- handler が env だけ必要なら → `getRequestEnv()` で取る (= c 不要、signature pure 維持)
- handler が env 以外も必要なら (= headers / executionCtx 等) → 第 2 引数で c を受ける

## Consequences

### Pros

- **9 割 handler が pure な service 関数として書ける** (= Vidro 北極星整合)
- **3 層分離原則の機構誘導** (= service 層 = handler signature `(input) => R`)
- **型貫通 #4 + #9 完成** (= validator 経由で typed input が引数で渡る、本 ADR + ADR 0071 連動で実現)
- **edge case (auth header / redirect 等) も明示で対応** (= magic 不要、物理判定原則維持)
- **既存 Hono 知識流用可能** (= middleware は `(c, next)` のまま、c 必要時の API も Hono と同じ)
- **ADR 0071 dream code 完成** (= `serverFn(validator(schema), async (input) => ...)` 着地)

### Cons / 残るリスク

- **breaking change** (= ADR 0070 Phase 1 + 2c 改修、apps/blog 既存 server.ts 書き換え)
- **影響範囲は限定的** (= router 1 file + test 26 件 + apps/blog 3 file、1-2 セッション規模)
- **第 2 引数 `c` の位置に user が慣れる必要** (= Hono は第 1 引数だったが、Vidro は最後 optional)
- **middleware が type 連鎖を持つ generic 型に進化** (= `Middleware<TIn, TOut>`、複雑度上昇、ただし validator など typed 経路 user code には透過的)

### 既存 ADR との関係

- **ADR 0070 (server function pattern)**: 論点 6 (= Hono c subset の handler 採用) を **partial supersede** (= handler から外して middleware に閉じる)、論点 7 (= 位置引数) は維持
- **ADR 0071 (`@vidro/zod`)**: 連動着地、validator middleware の typed input 経路を本 ADR の Middleware 型 generic で支える
- **ADR 0049 (loaderData)**: 整合、loader 側は本 ADR の影響なし (= server function とは別経路)
- **ADR 0057 (fw design stance)**: 整合、c 必要時は明示 (= 強制ゼロ)
- **ADR 0066 (async server component / `getRequestEnv`)**: 整合、`getRequestEnv()` は handler 内でも引き続き使える (= c.env と並行存続)

### 既存 memory との関係

- `project_adr_0070_status`: 論点 6 partial superseded を反映、Phase 進捗に Phase 1' 追加
- `project_adr_0071_status`: validator middleware の typed input 経路が本 ADR 連動で着地、Phase 6 実装内容を update
- `project_dogfood_post_form_blocker`: 本 ADR + ADR 0071 連動で root cause 解消 (= 422 throw 経路、union 戻り値廃止)
- `project_layer_separation_principle`: handler signature が pure service form に倒れる、3 層分離が機構誘導されると追記
- `project_design_north_star`: RPC simpler 代替の handler signature pure 化を反映
- `project_legibility_test`: handler `(input) => R` は「pure service 関数」と訳せる、合格
- `project_type_vertical_propagation`: #4 + #9 完成 status 反映 (= ADR 0071 連動と本 ADR で確定)

## Affected files

### 改修

- `packages/router/src/server-fn.ts`:
  - `Handler<P, R>` 型: `(c: Context, ...args: P) => R` → `(...args: [...P, c?: Context]) => R`
  - `Middleware` 型: `(c, next) => ...` → `Middleware<TIn = unknown, TOut = TIn> = (c, next: (overrideArgs?: readonly unknown[]) => Promise<void>) => ...` (= type 連鎖追加)
  - `serverFn` factory の dispatch 内: `handler(c, ...args)` → `handler(...args, c)`
  - `dispatchServerFn`: `entry.handler(c, ...params, ...bodyArgs)` → `entry.handler(...params, ...bodyArgs, c)`、body を `c.var.body` に詰める処理を追加 (= validator から参照可能にする)
- `packages/router/tests/server-fn.test.ts` (= 既存 26 test の signature 修正)
- `packages/router/dist/*` (= rebuild で再生成)
- `apps/blog/src/routes/posts/new/server.ts` (= Path 4 + validator 経路)
- `apps/blog/src/routes/posts/[slug]/edit/server.ts` (= 同上)
- `apps/blog/src/routes/posts/[slug]/delete/server.ts` (= 同上)
- `apps/blog/src/routes/posts/new/post-form.tsx` (= try/catch + ServerFnValidationError 経路、isOk type guard と CreatePostResult import 削除)

### 新規

- なし (= ADR 0071 Phase 6 で `packages/zod/` 新規、本 ADR とは別途)

## Validation (= Accepted 化までに実施)

- 既存 ADR (0001-0071) との矛盾 check (= 上記表で実施済)
- 既存 memory との整合 check (= 上記 cross-check で実施済)
- user 合意取得 (= 60th session で confirm)
- `feature-dev:code-reviewer` agent review (= 60th session 実施済、Critical 1 件 (`bodyArgs.length === 0` で `c.var.body` 不在 case) を ADR + 実装 comment で「validator は input ある fn 専用前提」と明示、Important 1 件 (manifest cast の型不一致) は runtime 上 false positive と確認済)

## Next steps (= Accepted 化後)

### 段階的 commit 推奨順序

1. **Phase 1'**: `packages/router/src/server-fn.ts` の Handler 型 + Middleware 型 + dispatch 改修、router test 26 件の signature 修正、`vp pack --dts` で dist 再生成
2. **Phase 6'**: `packages/zod/` skeleton (= packages/form mirror) + `validator(schema)` middleware (= ADR 0071 Phase 1+2 連動) + `fieldsFromZodError(err)` helper + `ServerFnValidationError` class、unit test
3. **Phase 7'**: `apps/blog` 既存 server.ts 3 本 + post-form.tsx の Path 4 書き換え、smoke 確認 (= dev server で curl + browser)
4. **memory update + main merge 判断** (= dogfood 完走で OK ならマージ)

各 Phase は独立コミット可能。

## Revisit when

- **destructured object form (= `({ input, c }) => R`) の必要性顕在** — dyn segment + body の引数順序で痛み出たら 1-D に migrate 検討
- **ALS getContext() helper の必要性顕在** — edge case で c の引数渡しが boilerplate になったら、ただし物理判定原則とのトレードオフ慎重判断
- **Middleware 型 generic 連鎖の複雑度が user に漏れる事象顕在** — validator など typed 経路 user code に generic 型表記が出てきたら simplify 検討
- **Hono 流に戻したい強い user 要求** — Hono ecosystem 統合に強い動機が生じたら revisit
