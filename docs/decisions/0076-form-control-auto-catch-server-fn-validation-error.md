# 0076 — `formControl.bind` が `ServerFnValidationError` を自動 catch する

## Status

**Accepted** — 2026-05-10 (67th session、dogfood 第 11 周目で着地確定)

経緯:

- 2026-05-10 (67th): ADR 0069 + ADR 0073 + ADR 0075 連動の延長として、`@vidro/router` の `validator` 経路で吐かれる `ServerFnValidationError` を formControl が default で消化する設計を Proposed 起票 + 案 B 実装 + 514 test pass + dogfood smoke (= post-form / edit-form 想定通り動作確認)、Accepted に昇格

着地時 commit: `1dc692b feat(form): ADR 0076 — formControl.bind が ServerFnValidationError を自動 catch する + dogfood 第 11 周目`

依存: ADR 0069 (formControl primitive)、ADR 0071 (`@vidro/zod`)、ADR 0072 (handler pure service form)、ADR 0073 (serverFn object slot)、ADR 0075 (formControl.bind を form props 化)
関連: `project_3tier_architecture`, `feedback_dev_restart_after_dist_change`, `feedback_dx_first_design`, `project_layer_separation_principle`

## Context

ADR 0071 + 0072 + 0073 で `serverFn({ validator: { data }, handler })` 経路が完成、validator slot が fail すると server で 422 を JSON で返す。`@vidro/router/client` の `__vidroServerFnStub` が 422 + content-type `application/json` + body shape が `{ fields }` の Response を `ServerFnValidationError` (= `Error` subclass、`.fields: Record<string, string>` 持ち) として throw する経路。

ADR 0069 で `formControl({schema})` primitive、`f.setFieldErrors(fields)` で server 由来の per-field error を流す helper も用意済。**ところが** user 側の handleSubmit は毎回同じ try/catch を書かされている。

apps/blog 第 8〜10 周目時点 (= post-form.tsx / edit-form.tsx 共通):

```tsx
const handleSubmit = async (data: PostContentInput): Promise<void> => {
  try {
    const { slug } = await createPost({ data });
    f.reset();
    navigate(`/posts/${slug}`);
  } catch (err) {
    if (err instanceof ServerFnValidationError) {
      f.setFieldErrors(err.fields);
      return;
    }
    throw err;
  }
};
```

「server validation error は per-field UI に流す」は formControl の責務として default 化したい。dogfood 第 3 周目から identified、第 11 周目時点でも apps/blog の 2 form が同 boilerplate を保持。

## Options

### 案 A: `@vidro/form` の peer dep に `@vidro/router` 追加、`instanceof` で判定

```ts
import { ServerFnValidationError } from "@vidro/router/client";
// bind 内
.catch((err: unknown) => {
  if (err instanceof ServerFnValidationError) {
    f.setFieldErrors(err.fields);
    return;
  }
  throw err;
});
```

**pros**: 型 narrowing が IDE で効く、`fields` の type は `ServerFnValidationError` 由来で正確

**cons**:

- 3-tier (memory `project_3tier_architecture`) 構造を壊す: `@vidro/form` (= +pack tier) が `@vidro/router` (= +router tier) を peer dep に持つと tier 逆転
- cross-bundle で `instanceof` が壊れるリスク (memory `feedback_dev_restart_after_dist_change`): HMR / package re-pack 中に `ServerFnValidationError` class が複数 instance 化、`instanceof` が false 化する事象は dogfood で既出

### 案 B: duck-type 判定 (= 採用)

```ts
// bind 内
.catch((err: unknown) => {
  if (isServerFnValidationError(err)) {
    f.setFieldErrors(err.fields);
    return;
  }
  throw err;
});

function isServerFnValidationError(
  err: unknown,
): err is { name: "ServerFnValidationError"; fields: Record<string, string> } {
  return (
    err instanceof Error &&
    err.name === "ServerFnValidationError" &&
    "fields" in err &&
    typeof (err as { fields: unknown }).fields === "object" &&
    (err as { fields: unknown }).fields !== null
  );
}
```

`err.name === "ServerFnValidationError"` を **public contract** として ADR 0076 で文書化する (= `@vidro/router/client` 側の `ServerFnValidationError.name` を変えると本契約 break、ADR 起票 + 一斉移行が必要)。

**pros**:

- 3-tier 構造を維持: `@vidro/form` は `@vidro/router` を知らないまま
- cross-bundle に強い: `err.name` 文字列は package boundary を跨いでも安定
- `Error` subclass の `name` は古典的 JS の error discrimination パターン (= `DOMException`, `SyntaxError` 等が踏んでる規約)、Vidro 独自規約ではない

**cons**:

- `name` 文字列を refactor (例: `ValidationError` に rename) すると本契約 break、ADR 0076 で固定する責任が `@vidro/router/client` 側にも乗る
- 型 narrowing は user-defined type predicate で書く必要、IDE の自動補完は `instanceof` ほど豊かではない

### 案 C: 何もしない (= status quo)

**cons**:

- dogfood 第 3-10 周目で identified、毎 form 同じ boilerplate を user に書かせ続ける
- formControl と serverFn validator が「機構の半分しかつながってない」状態 (= validator は server で吐く、client deserialize は router、setFieldErrors は user 手書き接続)

## Decision

**案 B を採用** — duck-type 判定で `ServerFnValidationError` を自動 catch、`setFieldErrors` に流す。

`packages/form/src/form-control.ts` の `bind` 内、`Promise.resolve(fn(data)).finally(...)` chain に `.catch()` を追加し、判定 helper を private 関数として定義する。

```ts
return {
  onSubmit: (event: SubmitEvent) => {
    event.preventDefault();
    if (pending.peek()) return;
    const validation = validateAll();
    if (!validation.ok) return;
    pending.value = true;
    void Promise.resolve(fn(validation.data))
      .catch((err: unknown) => {
        if (isServerFnValidationError(err)) {
          setFieldErrors(err.fields);
          return;
        }
        throw err;
      })
      .finally(() => {
        pending.value = false;
      });
  },
  "data-vidro-no-intercept": "",
};
```

`@vidro/router/client` の `ServerFnValidationError` 側には ADR 0076 リンクをコメントで残し、`name` の文字列を public contract として明文化する。

## Rationale

- **3-tier 維持** (memory `project_3tier_architecture`): `@vidro/form` → `@vidro/router` の peer dep を増やさない、tier 構造の独立を保つ
- **cross-bundle robustness** (memory `feedback_dev_restart_after_dist_change`): `instanceof` の HMR / 複数 instance 化リスクを構造的に回避
- **責務分離** (memory `project_layer_separation_principle` の soft 適用): validation error = form 機構の default 責務、それ以外の error = user の責務、という線引きが明確化
- **DX-first** (memory `feedback_dx_first_design`): user が書くコードから try/catch + import + instanceof + return + throw の 5 行が消える、business logic だけ残る
- **rhf との対比**: rhf は `setError` を user が手動で呼ぶ (= submit handler 内で server response から取り出す)、Vidro は wire shape (= `{ fields }`) が確定してるので機構側で消化できる、これは Vidro の validator 規約が tighter なゆえの優位
- **`err.name` 規約は古典 JS に整合**: `DOMException`, `SyntaxError` 等が踏んでる Error discrimination の old-school pattern、AI 補完にも自然

## Consequences

### 影響範囲

- `packages/form/src/form-control.ts`: `bind` 内 onSubmit に `.catch()` 追加、`isServerFnValidationError` helper 定義
- `packages/form/tests/form-control.test.ts`: ADR 0076 describe block で auto-catch 経路 test 追加 (= validation error throw → setFieldErrors 呼ばれる / 他 error throw → bubble up / pending は両ケースで降りる)
- `packages/router/src/client.ts`: `ServerFnValidationError.name` を public contract と明示するコメント追加 (= ADR 0076 リンク)
- `apps/blog/src/routes/posts/new/post-form.tsx`: try/catch 削除、`ServerFnValidationError` import 削除、コメント更新
- `apps/blog/src/routes/posts/[slug]/edit/edit-form.tsx`: 同上

### 振る舞い変更

- handler が `name === "ServerFnValidationError"` 形 throw した場合、**user code には届かなくなる** (= setFieldErrors に流れて UI 反映で完結)
- handler が他 error を throw した場合、**従来通り bubble up** (= unhandled rejection、user は必要なら try/catch で受ける)
- pending signal は両ケースとも `finally` で降りる (= 既存挙動と同じ)
- 既存の手書き try/catch コードは **後方互換** (= setFieldErrors が 2 重呼ばれるが冪等、副作用なし)。dogfood では削除する方針

### 拡張余地

- 別 ADR 候補: form-level error signal (= rhf の `formState.errors.root` 相当) を追加して、network error / 500 等を formControl の form-level UI に流す primitive (= 例: `f.formError`)
- 別 ADR 候補: `bind(fn, { autoSetFieldErrors: false })` opt-out option (= dogfood で必要になったら追加、現時点 YAGNI)
- 別 ADR 候補: `ServerFnValidationError` 以外の structured server error (= 例: 429 rate limit、403 forbidden) を formControl が default で扱う規約 (= dogfood trigger 待ち)

## Revisit when

- form-level error UI が dogfood で必要になった時 (= form 全体の "Something went wrong" 表示の primitive 化)
- 自動 catch を opt-out したい case が出た時 (= 例: validation error も含めて user が独自 UI に流したいフォーム)
- `ServerFnValidationError.name` の文字列を変えたい改修が走る時 (= 本 ADR で固定した contract の renegotiation)
- `@vidro/form` と `@vidro/router` を 1 package に統合する設計が出た時 (= duck-type ではなく `instanceof` に書き換える余地)
