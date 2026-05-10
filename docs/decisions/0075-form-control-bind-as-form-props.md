# 0075 — `formControl.bind` を form 全体の spread props を返す形に変更

## Status

**Proposed** — 2026-05-10 (66th session、dogfood 第 8 周目で見えた痛み点解消)

依存: ADR 0069 (formControl primitive)、ADR 0051 (form submit auto-intercept)
関連: `feedback_dx_first_design`, `feedback_ai_first_api_design`

## Context

ADR 0051 で「route page 上の **全 method=post form を window 全体で自動 intercept**」設計を採用、SPA 遷移を成立させている。例外的に hijack させたくない form (= island で fetch を直接呼ぶ form) は `data-vidro-no-intercept` data attribute を form node に付ける escape hatch。

ADR 0069 で `formControl({schema})` primitive 導入、`f.bind(handleSubmit)` で submit handler を作る pattern。**ただし**、formControl で fetch を直接呼ぶ island form は router の global interceptor から逃げる必要があり、user は **手動で `data-vidro-no-intercept` を form に付ける** 必要があった。

apps/blog の現状 (= dogfood 第 8 周目時点):

```jsx
// post-form.tsx / edit-form.tsx 共通 pattern
<form
  onSubmit={f.bind(handleSubmit)}
  data-vidro-no-intercept    // ← user 手書き、忘れると router が intercept して double POST
  class="mt-4 space-y-4"
>
```

両 form のコメントに「formControl が自動でこの marker をやってくれる方が良い」と書かれていた (= 第 3 周目で identified、第 8 周目まで持ち越し)。

## Options

### 案 X: `f.bind` の戻り値を form props object に変更 (= 採用)

```jsx
<form {...f.bind(handleSubmit)} class="mt-4 space-y-4">
```

`f.bind(fn)` は今までは `(e: SubmitEvent) => void` (= raw event handler) を返していた。これを **form 全体の props object** を返すように変える:

```ts
bind(fn): {
  onSubmit: (e: SubmitEvent) => void;
  "data-vidro-no-intercept": "";
}
```

JSX spread (`{...obj}`) で marker と onSubmit を 1 度に注入。

**pros**:

- API は `f.bind` 1 個のまま
- spread `{...}` 1 字追加だけで marker 隠蔽完了 (memory `feedback_dx_first_design`)
- 将来 form-level の追加 attr (例: `noValidate`) も bind 戻り値に積める拡張余地

**cons**:

- breaking change: 既存 `onSubmit={f.bind(...)}` 形式は型 error (= 戻り値が object になり SubmitEvent handler とは別物)
- 影響範囲は apps/blog の 2 form のみ (= 個人開発の private FW、痛み小)

### 案 Y: 新 helper `f.formProps()` を追加

```jsx
<form {...f.formProps(handleSubmit)} class="mt-4 space-y-4">
```

`f.bind` は既存形式 (event handler 返す) を維持、新しく `f.formProps()` を追加して spread 経路を別 API として並存。

**pros**: backward compatible

**cons**:

- API が 2 個に増える、user は「`bind` と `formProps` どっち使う?」を判断必要
- 実質 `formProps` の方が常に正解 (= marker 自動付与で安全)、`bind` は legacy として残るだけ → 2 個併存は説明 cost / 混乱の元
- memory `feedback_legibility_test` 観点で「読み手が判断軸を持てない」 = 痛み

### 案 Z: marker を一切使わず、router 側 interceptor で「event.target が formControl 由来か」を判定

router が submit event の target form を見て「formControl で bind されたか」を判別、自動 escape する。

- pros: API 何も変えなくて良い
- cons: formControl ↔ router の循環依存、形式的にも island 境界跨ぎで筋が悪い、formControl 以外の「fetch を直叩きする生 form」も marker 不要にする一貫性が取れない

## Decision

**案 X を採用** — `f.bind` の戻り値を form 全体の props object に変更。

`packages/form/src/form-control.ts` の `FormControl<T>.bind` の signature を:

```ts
bind(fn: (data: T) => Promise<void> | void): FormControlBindProps;
```

の形にし、`FormControlBindProps` を export する:

```ts
export type FormControlBindProps = {
  onSubmit: (event: SubmitEvent) => void;
  "data-vidro-no-intercept": "";
};
```

## Rationale

- **DX-first** (memory `feedback_dx_first_design`): user が書くコードの見た目を起点、marker 手書きは「FW 機構を知らないと書けない」呪文。spread 化で機構知識を formControl の中に閉じ込める
- **AI-first** (memory `feedback_ai_first_api_design`): `<form {...f.bind(handler)}>` は 1 expression、AI 補完にも自然。 `<form ... data-vidro-no-intercept>` は marker を覚えてないと AI も書けない
- **API 単一** (memory `feedback_legibility_test`): `f.bind` 1 個で済む、案 Y の「使い分け不明瞭」を回避
- **router-formControl 疎結合維持**: 案 Z (router 側 detection) は循環依存、案 X は formControl 内で完結
- **breaking change の痛み小**: 個人開発、影響は apps/blog 2 form のみ。memory `feedback_collaboration_style` の小さな commit で 1 weekend 範囲
- **rhf との対比**: rhf は `<input {...register(name)} />` の input spread、`<form>` は通常 onSubmit。Vidro は router global interceptor の特殊事情で **form 自体に spread が必要**、spread を使う方針は rhf と一貫しつつ scope を form に拡張

## Consequences

### 影響範囲

- `packages/form/src/form-control.ts`: `FormControl<T>.bind` の return type 変更、`FormControlBindProps` export 追加、runtime impl は object 返す形に書換
- `packages/form/tests/`: bind 戻り値検証を新形式に
- `apps/blog/src/routes/posts/new/post-form.tsx`: `<form {...f.bind(handleSubmit)}>` に書換、`data-vidro-no-intercept` 削除、コメント更新
- `apps/blog/src/routes/posts/[slug]/edit/edit-form.tsx`: 同上
- `docs/decisions/0069-form-control-primitive.md`: `formControl.bind` の return shape を ADR 0075 で update した旨をノート追加 (= 0069 の Revisit 条件「marker 自動付与の DX 改善」消化)

### 振る舞い変更

- 既存 `<form onSubmit={f.bind(...)}>` 形式は **TS error** (= 戻り値 type mismatch)。runtime に migration したいユーザーは spread 形式に書換必須
- 新形式 `<form {...f.bind(...)}>` は marker と onSubmit が同時注入、router intercept から自動 escape
- formControl の他 helper (`field`, `error`, `pending`, `reset`, `setFieldErrors`) は不変

### 拡張余地

- `bind` 戻り値に追加 attr (例: `noValidate: true`、`encType` 等) を積める。form-level の規約強化 (= ADR 0051 系の interceptor 規約) を formControl に閉じ込めて user に書かせない方針

## Revisit when

- form-level の追加 attr (例: file upload で `encType="multipart/form-data"` 自動付与) が dogfood で必要になった時
- formControl 以外の生 form でも marker 自動化したい case が出た時 (= 別 helper or document 推奨方針)
- router の interception 仕様が変わって marker 自体が不要になった時 (= ADR 0051 を superseed する設計が出た時)
