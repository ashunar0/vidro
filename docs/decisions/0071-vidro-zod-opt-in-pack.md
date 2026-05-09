# 0071 — `@vidro/zod` opt-in pack: `validator(schema)` middleware と `fieldsFromZodError` helper

## Status

**Proposed** — 2026-05-09 (58th session)

依存: ADR 0070 (server function pattern)、ADR 0069 (`formControl` primitive)、ADR 0059 (validation error primitive)
関連: memory `project_vidro_zod_pack_pending`、`project_3tier_architecture`、`project_html_first_wire`、`project_type_vertical_propagation`

## Context

ADR 0070 の論点 8 (schema 統合) で `serverFn(validator(schema), handler)` 形式を採用、`validator()` は `@vidro/zod` opt-in pack で提供することに決定。memory `project_vidro_zod_pack_pending` の起票 trigger (= 「複数 form を Zod で書いた段階で boilerplate 累積」) は ADR 0069 (= `formControl` 内 zod 統合) 着地時点で達成済、さらに ADR 0070 で server function 用 `validator(schema)` middleware が必要になり、本 ADR で fulfill。

哲学 (= memory `project_vidro_zod_pack_pending` 引用):

- **薄い core 維持** = `@vidro/router` / `@vidro/core` は zod 不知 (= bundle に zod を強制しない)
- **Hono pattern 踏襲** = `@hono/zod-validator` 別 package と同形 (= core は web 標準 + middleware-like、validator は別 pack)
- **強制ゼロ** (= ADR 0057) = zod 採用は user 判断、軽い form は ad-hoc safeParse で書いて良い
- **ADR 0059 規約遵守** = 422 + JSON `{fields: Record<string, string>}` foundation そのまま

### Vidro 哲学整合 (memory cross-check)

| memory                              | 関係                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `project_vidro_zod_pack_pending`    | 起票 trigger 達成、本 ADR で fulfill、memory finalize                                                     |
| `project_3tier_architecture`        | +pack tier 2 個目 (= `@vidro/form` 0069 / `@vidro/zod` 0071)、3-tier 構造実証                             |
| `project_html_first_wire`           | 422 + JSON wire は HTML-first 例外条項 (= action result + 明示 data fetch) に該当                         |
| `project_type_vertical_propagation` | 型貫通 #4 (form input → action 引数型) + #9 (submission.input ← action 引数逆引き) を ADR 0070 と連動完成 |
| `project_design_north_star`         | 個人 / hobby / cf scale、薄い core + 厚い optional pack 整合                                              |
| `project_legibility_test`           | `validator(schema)` は「schema を middleware として渡して input を validate する」と読める、合格          |
| `project_fw_design_stance`          | 強制せず機構誘導、validator 採用は user 判断                                                              |

## Options

### 論点 1: package 位置と命名

#### (1-A) `packages/zod/` 新規、`@vidro/zod` (= **採用**)

memory `project_3tier_architecture` の +pack tier に置く。`@vidro/core` (signal 等 reactive primitive) / `@vidro/router` (routing + serverFn) と独立、import で初めて入る opt-in。

- **pros**:
  - 3-tier 整合、`@vidro/router` の `serverFn` 連携を `validator()` middleware として opt-in 提供
  - core / router は zod 不知 (= bundle 自由)
  - peer dep に zod 置けば user が version 制御
  - `@vidro/form` (= ADR 0069) と並んで +pack tier の 2 個目、tier 構造実証
- **cons**: 新パッケージ 1 個追加 (= ただし既存 `packages/form` と同形なので機構コストほぼゼロ)

#### (1-B) `@vidro/router` 内に `validator()` を merge

→ 却下。core 哲学 (= zod 不知) 違反、bundle に zod が混入する。

#### (1-C) `@vidro/form` に `validator()` を追加

→ 却下。`@vidro/form` は formControl の primitive pack、`validator()` は server function 用 middleware で関心事が違う。両方 zod を使うが用途が直交、別 pack に分離する方が責務明確。

#### (1-D) `@vidro/core` 同梱

→ 却下。core 哲学 (= 「使わなくても動く reactive primitive 最小集合」) 違反、core を肥大化させる。

→ **(1-A) 採用**、3-tier 維持。

### 論点 2: API surface

#### (2-A) `validator(schema)` middleware + `fieldsFromZodError` helper (= **採用**)

```ts
// packages/zod/src/index.ts
import type { z } from "zod";

/**
 * server function 用 input parse middleware。
 * schema.safeParse(input) を実行、failure 時 422 throw、success 時 input を typed で handler に渡す。
 */
export function validator<S extends z.ZodSchema>(schema: S): Middleware<z.infer<S>>;

/**
 * ZodError → Record<string, string> 変換 (= ADR 0059 規約)。
 * client 側で受けた 422 JSON を formControl の setFieldErrors に流す等で利用。
 */
export function fieldsFromZodError(err: z.ZodError): Record<string, string>;
```

採用 API:

| API                       | 用途                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `validator(schema)`       | server function の middleware として渡す、input parse + 422 throw + handler に typed input |
| `fieldsFromZodError(err)` | ZodError → `Record<string, string>` 変換、422 response shape (= ADR 0059) との橋渡し       |

不採用 (= initial 限定):

| API                                  | 不採用理由                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------- |
| async refinement validation          | initial は sync only、async は将来拡張 (= zod async schema 必要時)         |
| nested / array field 型貫通強化      | initial は flat object のみ、ADR 0069 と同様の限界                         |
| `safeFieldErrors<T>()` 型貫通 helper | future、`Record<keyof T, string>` 化は schema lib 切り替えと連動して再評価 |

#### (2-B) `validate` factory (= 命名 alt)

→ 却下。Hono `@hono/zod-validator` の `validator()` 命名と整合、user の Hono 知識流用可能。

#### (2-C) `validateInput()` 等の冗長命名

→ 却下。冗長、Hono 慣習からズレる。

→ **(2-A) 採用**。

### 論点 3: 422 response shape

#### (3-A) ADR 0059 規約踏襲 = `{fields: Record<string, string>}` (= **採用**)

```json
{ "fields": { "title": "Title is required", "body": "Body is required" } }
```

ZodError の field path → message を flatten、各 field の **最初の error message** を `Record<string, string>` に詰める (= ADR 0059 / `@vidro/form` setFieldErrors と完全互換)。

- **pros**:
  - ADR 0059 foundation そのまま使う = `formControl` の `setFieldErrors` と完全 compatible、client/server の wire shape 統一
  - 「想定外が生えない」原則整合 (= shape 既知、parse 容易)
  - HTML-first wire 例外条項 (= action result) に該当
- **cons**: 1 field 1 message 制約 (= ADR 0059 制約継承、ADR 0059 revisit 時に同時更新)

#### (3-B) ZodError 直接 wire (= `{error: ZodError.flatten()}`)

→ 却下。ADR 0059 と整合しない、formControl の setFieldErrors が shape 変換コード必要、client が ZodError shape を知る必要 (= 結合度上昇)。

#### (3-C) 独自 wire shape

→ 却下。ADR 0059 規約をわざわざ捨てる理由なし。

→ **(3-A) 採用**。

### 論点 4: schema lib agnostic か zod 専用か

#### (4-A) zod 専用、peer dep で受ける (= **採用 initial**)

```ts
// peer dep
{ "peerDependencies": { "zod": "^3.0.0 || ^4.0.0" } }
```

- **pros**:
  - type 推論が直接書ける、user 学習コスト低
  - ZodError shape を直接扱える (= `fieldsFromZodError` 実装が単純)
  - de-facto schema lib なので用途カバー率高
- **cons**: zod 強制 (= ただし pack opt-in なので import しなければ影響なし)

#### (4-B) duck-type (= ADR 0069 `formControl` 流) で schema lib agnostic

→ 将来検討。本 ADR では initial に zod 専用で出す、痛み顕在化したら 4-B に migrate。`formControl` (= ADR 0069) は duck-type で受けてるので、ADR 0069 と本 ADR で **schema lib 観点が分かれる**が、両方 zod を default 推奨で実用上は問題なし。

→ **(4-A) 採用 initial**、4-B は revisit 候補。

### 論点 5: 422 自動 throw vs 手動 return

#### (5-A) 自動 throw (= **採用**)

`validator(schema)` middleware が parse failure 時に `throw new Response(JSON, {status: 422})` で自動応答。handler に到達しない。

```ts
export const createPost = serverFn(validator(createPostSchema), async (c, input) => {
  // ↑ 到達時点で input は typed + parse 済、failure 時は到達しない
  return db.posts.insert(input);
});
```

- **pros**:
  - boilerplate ゼロ (= memory `project_vidro_zod_pack_pending` の dream code そのまま)
  - handler が input を受け取った時点で typed + parse 済を保証 (= 型貫通 #9)
  - Hono `@hono/zod-validator` 完全互換挙動
- **cons**:
  - error 時 handler に control が渡らない (= ただし custom error 処理は middleware 自体を override する path が残る)

#### (5-B) 手動 return (= `c.req.valid("json")` で取り出し、user が if 分岐)

→ 却下。boilerplate が増える、Hono `@hono/zod-validator` 慣習からズレる。

→ **(5-A) 採用**。

## Decision (= 5 論点まとめ)

| #   | 論点               | 決定                                                                                            |
| --- | ------------------ | ----------------------------------------------------------------------------------------------- |
| 1   | package 位置       | **`packages/zod/` 新規、`@vidro/zod`** (= 3-tier の +pack tier、`@vidro/form` と並ぶ 2 個目)    |
| 2   | API surface        | **`validator(schema)` middleware + `fieldsFromZodError(err)` helper**                           |
| 3   | 422 response shape | **ADR 0059 規約踏襲** (`{fields: Record<string, string>}`、`formControl.setFieldErrors` と互換) |
| 4   | schema lib         | **zod 専用 + peer dep** (initial、4-B duck-type は revisit 候補)                                |
| 5   | failure 経路       | **422 自動 throw** (handler に到達しない、Hono `@hono/zod-validator` 互換挙動)                  |

### Scope (= 本 ADR で扱う / 扱わない)

| 項目                                                               | 本 ADR で扱う?                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------ |
| `validator(schema)` middleware (= server function 用)              | ✅                                                     |
| `fieldsFromZodError(err)` helper                                   | ✅                                                     |
| 422 自動 throw + ADR 0059 規約                                     | ✅                                                     |
| zod peer dep + catalog 統一                                        | ✅ (= ADR 0069 で既に追加済、本 ADR で再確認のみ)      |
| `packages/zod/` skeleton (= package.json / tsconfig / vitest)      | ✅                                                     |
| async refinement validation (= zod async schema)                   | ❌ (= initial sync only、痛み顕在化で revisit)         |
| nested / array field 型貫通強化                                    | ❌ (= ADR 0069 の flat-only と同様の制約継承)          |
| 別 schema lib (valibot 等) サポート                                | ❌ (= 必要時に `@vidro/valibot` 等で別 pack 起票)      |
| `safeFieldErrors<T>()` 型貫通 helper (= `Record<keyof T, string>`) | ❌ (= future、ADR 0059 revisit と連動)                 |
| `formControl` 内部の zod 統合を `@vidro/zod` 上に再構築            | ❌ (= ADR 0069 は duck-type 維持、本 ADR とは観点分離) |

## Rationale

### Hono pattern 踏襲が正しい理由

`@hono/zod-validator` が別 package、Vidro でも同形にすることで:

- core が zod 知らない (= bundle 自由)
- user が opt-in (= 強制ゼロ、ADR 0057 整合)
- 学習: Hono を知ってる user は読める (= memory `project_legibility_test` の「日本語に訳せる」基準合格)

ADR 0070 の `serverFn(validator(schema), handler)` syntax は Hono `app.post(zValidator("json", schema), handler)` 直系。**user の Hono 知識をそのまま流用できる**ので、認知負荷ゼロに近い。

### 422 規約遵守が橋渡しになる理由

ADR 0059 の `{fields: Record<string, string>}` foundation を踏襲することで:

- **client 側 (formControl)**: `f.setFieldErrors(json.fields)` で受ける、shape 変換不要
- **server 側 (validator)**: `fieldsFromZodError(err)` で ZodError → 規約 shape 変換、auto throw

client/server の wire が **shape level で完全一致**、user は 422 response の構造を 1 個覚えれば全部解ける。memory `project_html_first_wire` の例外条項 (= action result + 明示 data fetch は JSON OK) と整合。

### initial で zod 専用にする理由

memory `project_vidro_zod_pack_pending` には「将来 valibot / yup / ArkType 等 schema lib 切り替え可能 (= duck-type)」と書いてあるが、initial 実装では zod 専用に倒す。理由:

- zod は de-facto、Hono ecosystem も zod 中心
- duck-type interface の implementation 複雑度を initial で持ち込むと開発速度落ちる
- `formControl` (= ADR 0069) は duck-type 採用済なので、schema lib agnostic 性は ADR 0069 で既に達成、`@vidro/zod` で重複実装する必然性が薄い
- 別 schema lib 需要が顕在化したら `@vidro/valibot` 等で別 pack を出す方が pack 単位の責務明確

ADR 0069 と ADR 0071 で **schema lib 観点が分かれる**のは設計上の choice、両方 zod を default 推奨で実用上問題なし。

### `formControl` 内部の zod 統合を再構築しない理由

ADR 0069 で `formControl({ schema })` は duck-type で zod schema を受ける形に decide 済。本 ADR の `@vidro/zod` を出す際、`@vidro/form` の zod 統合を `@vidro/zod` 上に再構築する道もあるが:

- ADR 0069 既存実装の rewrite コスト
- 観点分離 (= form control vs server function validator) は別 pack で表現する方が責務明確
- `@vidro/form` は schema lib agnostic を選択済 (= duck-type)、`@vidro/zod` は zod 専用 (= 本 ADR)、両者の選択は独立判断

両 pack が並走することで、user は use case で選択可能 (= form のみなら `@vidro/form`、server function validation 含むなら `@vidro/form` + `@vidro/zod`)。

## Consequences

### Pros

- **ADR 0070 の schema 重複問題着地** (= 元々の trigger 解消、ファイル 1 個増えない、co-location 維持)
- **3-tier の +pack tier 2 個目確立** (= `@vidro/form` 0069 / `@vidro/zod` 0071、tier 構造実証)
- **型貫通 #4 + #9 完成** (= form input + action 引数型 + submission.input、9 経路中 7/9)
- **Hono ecosystem 知識流用可能** (= `@hono/zod-validator` 直系の慣習)
- **client/server wire shape 統一** (= ADR 0059 規約踏襲、formControl との橋渡し)
- **422 boilerplate ゼロ** (= memory `project_vidro_zod_pack_pending` dream code そのまま、user code 5-10 行 → 1 行)

### Cons / 残るリスク

- **zod 依存** (= peer dep、user が zod インストール、ただし opt-in なので影響なし)
- **async refinement / nested / array field 未対応** (= initial 限定、痛み顕在化で revisit)
- **別 schema lib 需要時に別 pack 起票必要** (= `@vidro/valibot` 等、ただし pack 単位の責務明確という pros)
- **ADR 0069 と schema lib 観点が分かれる** (= ADR 0069 duck-type / 本 ADR zod 専用、user 説明が一段増える)

### 既存 ADR との関係

- **ADR 0059 (validation error primitive)**: 422 response shape を踏襲、`fieldsFromZodError(err)` で foundation 連携
- **ADR 0069 (`formControl` primitive)**: 整合、`formControl({ schema })` の duck-type と本 ADR の zod 専用は観点分離。両方 zod を default 推奨で実用上問題なし
- **ADR 0070 (server function pattern)**: 直接連動、`serverFn(validator(schema), handler)` の `validator()` を本 ADR で提供
- **ADR 0057 (fw design stance)**: 整合、validator は opt-in、強制ゼロ

### 既存 memory との関係

- `project_vidro_zod_pack_pending`: 起票 trigger 達成、本 ADR で fulfill、memory finalize (= status 「✓ ADR 0071 で着地」)
- `project_3tier_architecture`: +pack tier 2 個目 (= `@vidro/zod`) 確立、3-tier 構造実証
- `project_type_vertical_propagation`: #4 + #9 完成、9 経路中 7/9
- `project_html_first_wire`: 422 + JSON wire は例外条項該当、再確認
- `project_legibility_test`: `validator(schema)` は Hono 慣習で「schema を middleware として渡す」と訳せる、合格
- `project_design_north_star`: 個人 / hobby / cf scale 整合
- `project_form_dogfood_2026_05_08`: 痛み点 3 (= 型貫通 #4) を ADR 0069 + 0070 + 0071 連動で完全解決

## Affected files (実装着地時)

- `packages/zod/` 新規 (root structure):
  - `package.json`: `@vidro/zod` 0.0.0、zod peer dep (`^3.0.0 || ^4.0.0`)、`@vidro/router` core dep (= peer or workspace)
  - `src/index.ts`: `validator()` + `fieldsFromZodError()` export
  - `src/validator.ts`: middleware 実装本体 (= safeParse + 422 throw + typed input)
  - `src/fields-from-zod-error.ts`: ZodError → `Record<string, string>` 変換 helper
  - `tests/validator.test.ts`: unit test (= parse success / failure / 422 throw / typed input)
  - `tests/fields-from-zod-error.test.ts`: unit test (= 1 field 1 message / nested error flatten)
  - `tsconfig.json`, `vitest.config.ts` 等の build 設定 (= `packages/form` を mirror)
- `pnpm-workspace.yaml`: zod は ADR 0069 で既に catalog 追加済、本 ADR で再追加不要
- `apps/blog/`: dogfood Phase 7 (= ADR 0070 と連動) で `validator()` 使用例実証

## Validation (= Accepted 化までに実施)

- 既存 ADR (0001-0070) との矛盾 check (= 上記表で実施済)
- 既存 memory との整合 check (= 上記 cross-check で実施済)
- user 合意取得 (= 5 論点 = package 位置 / API / 422 shape / schema lib / failure 経路、58th session で confirm)
- `feature-dev:code-reviewer` agent review (= memory `feedback_review_in_workflow` per、Accepted 化前 or 実装 commit 直前)

## Next steps (= Accepted 化後)

### 段階的 commit 推奨順序

1. **Phase 1**: `packages/zod/` の skeleton 作成 (= `package.json` / `tsconfig.json` / 空 `index.ts` / vitest 設定)
2. **Phase 2**: `validator(schema)` 実装本体 (= safeParse + 422 throw + typed input)、unit test
3. **Phase 3**: `fieldsFromZodError(err)` helper、unit test (= ZodError flatten + 1 field 1 message 抽出)
4. **Phase 4**: ADR 0070 と連動 dogfood (= `apps/blog` の AppRouter mode 化で `serverFn(validator(schema), handler)` を実証)

各 Phase は独立コミット可能。

## Revisit when

- **async refinement (= zod async schema) の必要性顕在** — initial sync only で痛み出たら拡張、middleware 内 async parse に対応
- **nested / array field の必要性顕在** — flat only で痛み出たら拡張 (= 既存 React Hook Form / Hono の API を参考)
- **別 schema lib (valibot 等) 需要顕在** — `@vidro/valibot` 等で別 pack 起票、または duck-type に migrate (= 4-B 採用)
- **`safeFieldErrors<T>()` 型貫通 helper の必要性顕在** — ADR 0059 の `Record<keyof T, string>` 拡張と連動、別 ADR
- **422 response shape を 1 field 多 message にする要求** — ADR 0059 revisit と同時、本 ADR も追従更新
- **`@vidro/form` を `@vidro/zod` 上に再構築する判断** — ADR 0069 と本 ADR の観点分離が user 説明で痛み顕在化したら統合検討
