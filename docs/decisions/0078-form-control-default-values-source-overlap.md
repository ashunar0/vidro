# 0078 — `formControl({ defaultValues })` を source data と schema field overlap で型制約する

## Status

**Proposed** — 2026-05-10 (68th session、第 13 周目で起票)

経緯:

- 2026-05-09 (66th〜67th): ADR 0073/0074/0075/0076 連動で formControl の周辺機構が完成、第 11 周目で try/catch 撲滅
- 2026-05-10 (67th、第 12 周目、commit 51f947b): `defaultValues: { title: post.title, body: post.body }` を `defaultValues: post` (= Post 型まるごと) に書換、規約として格上げ
- 2026-05-10 (68th、本 ADR): 第 12 周目で着地した「post まるごと渡せる」が **silent breakage を許す** 弱点に気付き、source data ⟷ schema field の type-level 一致を制約する型強化を起票

依存: ADR 0069 (formControl primitive)、ADR 0075 (bind を form props 化)、ADR 0076 (bind 自動 catch)
関連: `project_type_vertical_propagation`, `project_form_design_decided`, `feedback_dx_first_design`, `project_3tier_architecture`

## Context

第 12 周目で `defaultValues: post` (= Post 型まるごと) が型 pass する **真因** は、TS の structural typing ではなく **「object literal 以外には excess property check が走らない」** ルール。`Partial<{title, body}>` を期待する場所に `Post = {id, slug, title, body, createdAt}` を変数経由で渡すと、`title?` / `body?` が optional なので「無くても良い」、余計 field の `id` 等は変数経由なので excess check 回避、という二段の偶然で通っていた。

これは **「post まるごと渡せる」を成立させる仕組みであると同時に、silent breakage の温床**。具体的には:

| ケース                                                                | 現状の挙動             | 期待               |
| --------------------------------------------------------------------- | ---------------------- | ------------------ |
| `const opts = { titlee: "x" }; defaultValues: opts`                   | 黙って空文字 prefill   | build error        |
| schema を `title → headline` に rename、source は `post.title` のまま | 黙って空文字 prefill   | build error        |
| schema 1 field だけ rename、もう 1 field は match                     | 黙って partial prefill | (= 検出限界、後述) |

formControl は **schema 起点で `keyof T` を制約してる** ので、`f.field("titlee")` 経路 (= 型貫通 #4) は build error 化済。**しかし `defaultValues` 経路は `Partial<T>` で受けてるだけで、source data 側に schema field 同名が存在するかを check していない**。型貫通 #4 と #5 (= defaultValues 経路) で保護レベルが食い違っている。

Vidro の北極星は型貫通 (= server で書いた型が client まで end-to-end で繋がる、9 経路ある) を伸ばす方向 (memory `project_type_vertical_propagation`)。本 ADR は **#5 = defaultValues source ⟷ schema field の overlap 保証** を着地させる。

## Options

### 案 A: `defaultValues` の generic を分けて、source ⟷ schema の overlap を要求 (= 採用)

```ts
formControl<T extends Record<string, unknown>, D extends Partial<T>>(opts: {
  schema: ParseSchema<T>;
  defaultValues?: ValidDefaults<T, D>;
}): FormControl<T>;

type ValidDefaults<T, D> = keyof D extends never
  ? D
  : (keyof D & keyof T) extends never
    ? never
    : D;
```

D を generic として infer。`keyof D extends never` (= D が `{}` 等 empty) なら制約スキップで `D` を返す (= `defaultValues: {}` を許可)、それ以外は `keyof D & keyof T` が `never` (= source に schema field が 1 個も無い) なら `never` を要求して reject する。

**pros**:

- runtime 変更ゼロ、型だけの話
- 第 12 周目の規約 (= post まるごと渡せる) を **そのまま維持** (= Post に title/body が含まれるので `keyof D & keyof T = "title" | "body"`、not never)
- typo 単独 (= `{ titlee: "x" }`) を build error 化、業界標準パターン (= Hono `c.req.json<T>()`、TanStack Router `PathParams`、Inertia typed props と同系)
- 5 行型 helper、IDE hover 表示は generic 1 個追加分の長さ増

**cons**:

- partial rename (= schema の 1 field だけ rename、もう 1 field は match) は overlap が残るので **検出できない** (= silent breakage のうち、全 field rename ケースだけが救われる)
- generic を 2 個に増やすと user 側で型を明示指定するケース (= `formControl<MyType>(...)` 形) で breaking change の可能性、ただし dogfood では未使用

### 案 B: `formControl({ source: PostType, fields: ["title", "body"] })` で schema を data 型から derive

詳細は memory `project_next_steps` 第 13 周目候補欄の B 項参照。**却下** — UI 都合 validation rule (= `min(1)`、`url()` 等) が結局後置 override で必要になり、2 重定義 + override で逆に複雑化。Vidro の schema-first 哲学からも離れる。

### 案 C: 親 server component → 子 island props まで vertical 型貫通

詳細は memory `project_next_steps` 第 13 周目候補欄の C 項参照。**保留** — 個人開発 hobby 規模 (memory `project_design_north_star`) では over-engineering。boilerplate が増え、`<EditPostForm post={post} />` を書く側に型 helper の理解を要求する。本 ADR の A 採用後に痛みが出てから別 ADR で起票。

### 案 D: excess property check 強化のみ (= source の余計 field を warn)

**却下** — 第 12 周目で着地した「post まるごと渡せる」が壊れる (= Post の `id/slug/createdAt` が excess として warn 化)。維持しようとすると `{[K in keyof T]?: T[K]} & {[K in Exclude<keyof D, keyof T>]?: unknown}` 的な型 trick が要り、A より複雑になる割に「typo 検出」の効用は A と同等。

### 案 E: 何もしない (= status quo)

**却下** — 第 12 周目で着地した規約が silent breakage を許すまま放置、型貫通 #5 が未着地のまま 8/9 着地不可能。「規約は格上げしたが型は弱い」状態は AI フレンドリー (memory `feedback_ai_first_api_design`) にも逆行 (= AI が typo 入れても build が通るので fix サイクルに入らない)。

## Decision

**案 A を採用** — `formControl` の signature に `D extends Partial<T>` を generic 追加、`ValidDefaults<T, D>` 型 helper で source ⟷ schema overlap を要求する。

```ts
// packages/form/src/form-control.ts

export type FormControlOptions<T, D extends Partial<T> = Partial<T>> = {
  schema: ParseSchema<T>;
  defaultValues?: ValidDefaults<T, D>;
};

/**
 * ADR 0078: source data D と schema 推論 T の field overlap が空集合なら never を要求して
 * reject する。typo 単独 (= `{ titlee: "x" }`) と全 field rename を build error 化。
 * partial rename (= 一部 field だけ rename、残りが match) は overlap が残るので検出限界。
 */
type ValidDefaults<T, D> = keyof D & keyof T extends never ? never : D;

export function formControl<T extends Record<string, unknown>, D extends Partial<T> = Partial<T>>(
  opts: FormControlOptions<T, D>,
): FormControl<T> {
  // 既存実装そのまま (runtime 変更ゼロ)
}
```

`apps/blog` 側は **コード改修不要** (= `defaultValues: post` がそのまま型 pass)。新規 type test を `packages/form/tests/` に追加して保護経路を verify。

## Rationale

- **距離 1 で書き心地不変** (= memory `feedback_dx_first_design` 起点): build 通る時の user 体験は完全に同じ、安全装置だけ増える。「型を強くしたら user code 書き換えが必要」を回避
- **第 12 周目の規約と完全互換**: `defaultValues: post` (= Post 型まるごと) が `keyof Post & keyof T = "title" | "body"` で not never、A の制約を素通りする
- **業界標準パターン**: Hono Validator、TanStack Router PathParams、Inertia typed props と同系の overlap 制約、Vidro 独自の発明ではない (memory `feedback_ai_first_api_design` の AI フレンドリー = 業界 default 整合)
- **3-tier 維持** (memory `project_3tier_architecture`): `@vidro/form` 内で完結、`@vidro/router` への dep 追加なし
- **scale-aware**: 個人開発 hobby 規模で over-engineering にならない (= 案 C との対比)、`@vidro/form` を使う user は schema を書いてる前提なので、追加負担ゼロ
- **partial rename は割り切り**: 完全検出には「全 schema field が source に存在」を要求するしかないが、それは「title だけ prefill して body は空」という legitimate な partial 用途と矛盾。現実的なトレードオフとして A の overlap 制約に留める

## Consequences

### 影響範囲

- `packages/form/src/form-control.ts`: `FormControlOptions` に generic D 追加、`ValidDefaults<T, D>` 型 helper 定義、`formControl` signature に generic D 追加 (runtime 変更なし)
- `packages/form/tests/form-control.test.ts`: ADR 0078 describe block で type test 追加 (= typo 単独 reject / post まるごと OK / `{}` OK / 全 field rename reject)
- `apps/blog/src/routes/posts/[slug]/edit/edit-form.tsx`: コード改修不要、コメントだけ第 13 周目記録に更新
- `apps/blog/src/routes/posts/new/post-form.tsx`: コード改修不要 (= defaultValues 未使用)

### 振る舞い変更

- **build 時のみ**: runtime は完全に同じ
- **build error 増加**:
  - `defaultValues: { titlee: "x" }` (= 全 field typo) → build error
  - `defaultValues: { unrelated: "x" }` 等、schema field と 1 個も match しない object → build error
- **build pass 維持**:
  - `defaultValues: post` (= Post 型まるごと、第 12 周目規約) → そのまま pass
  - `defaultValues: { title: "x" }` (= partial、片方だけ prefill) → そのまま pass
  - `defaultValues: undefined` (= optional) → そのまま pass

### 検出限界 (= 既知 limit)

- partial rename (= schema を `title → headline` に rename、source は `post.title` + `post.body` のまま) → `body` で overlap 成立、build pass、silent breakage 残る
- 完全検出は案 C (= vertical 型貫通) の領域、本 ADR の scope 外

### 拡張余地

- 別 ADR 候補: 案 C (= 親 server component → 子 island props vertical 型貫通) を本 ADR 着地後の dogfood で痛みが出てから起票
- 別 ADR 候補: partial rename 検出の opt-in mode (= `formControl({ schema, defaultValues, strict: true })` で「全 schema field が source に存在」を要求)、dogfood trigger 待ち
- 別 ADR 候補: type-level の field 名 mismatch hint を IDE quick-fix で出す lint plugin、YAGNI

## Revisit when

- partial rename の silent breakage が dogfood で実際に踏まれた時 (= 本 ADR の検出限界が痛む trigger)
- 案 C (= vertical 型貫通) を起票したくなる第 14 周目以降の痛み発見時
- `formControl<MyType>(opts)` 形で user が型を明示指定するケースで generic D 追加が breaking として観測された時
- Hono Validator 等の業界 standard 側で overlap 制約 API が変わった時 (= 整合性 renegotiation)
