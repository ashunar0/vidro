# 0077 — `formControl` に form-level error signal を追加

## Status

**Proposed** — 2026-05-10 (68th session、第 14 周目で起票)

経緯:

- ADR 0076 (= 67th、第 11 周目) §拡張余地で「form-level error signal (= rhf `formState.errors.root` 相当) を追加して network error / 500 等を formControl の form-level UI に流す primitive」を別 ADR 候補として明示
- 2026-05-10 (68th、本 ADR): 第 14 周目として起票、formError signal + setFormError method を formControl 公式 API に追加

依存: ADR 0069 (formControl primitive)、ADR 0075 (bind を form props 化)、ADR 0076 (bind 自動 catch)
関連: `project_form_design_decided`, `project_api_design_philosophy_object_one_spread`, `feedback_dx_first_design`, `feedback_ai_first_api_design`

## Context

ADR 0076 着地後、formControl が提供する reactive UI primitive は:

| primitive            | 責務                                         | 機構提供 |
| -------------------- | -------------------------------------------- | -------- |
| `f.field(name)`      | per-field input props (= controlled binding) | ✓        |
| `f.error(name)`      | per-field error signal (= validation 表示)   | ✓        |
| `f.pending`          | submit 中フラグ (= button disable / spinner) | ✓        |
| `f.setFieldErrors()` | server validation error → per-field 流し     | ✓        |
| **form-level error** | **「Something went wrong」表示用 reactive**  | **✗**    |

最後の **form-level error** だけ user 自前 (= `signal<string | undefined>(undefined)` 直書き) を要求していた。具体的には apps/blog dogfood で network error / 500 / business error 等を表示したい場合:

```tsx
// 現状 (= ADR 0076 着地後): user 自前
import { signal } from "@vidro/core";

const formErrorSignal = signal<string | undefined>(undefined);

const handleSubmit = async (data) => {
  try {
    await createPost({ data });
    navigate("/...");
  } catch (err) {
    formErrorSignal.value = "Something went wrong";
  }
};

return (
  <form {...f.bind(handleSubmit)}>
    {formErrorSignal.value && <p>{formErrorSignal.value}</p>}
    {/* fields */}
  </form>
);
```

痛み:

- formControl に `pending` / `error(name)` があるのに **form-level error だけ user 自前 signal**、機構提供と一貫性がない
- `f.reset()` で values + per-field error + pending が clear されるが、form-level error は user 別途 clear 要 (= `formErrorSignal.value = undefined`)
- AI が forget しやすい (= 「formControl の API 並べる」と pending / field / error / setFieldErrors / reset で完結見えるが、form-level error UI が機構外で迷子)
- rhf の `formState.errors.root` 相当が不在 (= 業界 standard pattern の対応が薄い)

## Options

### 案 A: formError signal + setFormError method + bind onError hook (= 採用)

```ts
export type FormControl<T> = {
  // ... 既存 ...
  /** form-level error signal (= rhf `formState.errors.root` 相当)。network / 500 / business error 表示用。 */
  formError: Signal<string | undefined>;
  /** form-level error を手動 set (= undefined で clear)。`f.reset()` でも自動 clear される。 */
  setFormError(message: string | undefined): void;
  /** bind 第 2 引数で「validation 以外の error」を user に渡す hook を受ける。 */
  bind(
    fn: (data: T) => Promise<void> | void,
    options?: { onError?: (err: unknown) => void },
  ): FormControlBindProps;
};
```

user code:

```tsx
const handleSubmit = async (data: PostContentInput) => {
  // handler は throw しっぱなし (= try/catch しない、ADR 0076 経路を bypass しない)
  const { slug } = await createPost({ data });
  navigate(`/posts/${slug}`);
};

return (
  <form
    {...f.bind(handleSubmit, {
      onError: (err) => f.setFormError(err instanceof Error ? err.message : "Something went wrong"),
    })}
  >
    {f.formError.value && <p class="text-red-600">{f.formError.value}</p>}
    {/* fields */}
  </form>
);
```

bind 内部 catch chain (= ADR 0076 拡張):

- validation error → setFieldErrors (= 既存)
- **それ以外 + `options.onError` あり** → onError 呼ぶ (= 新規)、user が `f.setFormError(...)` で UI に流すのが典型
- **それ以外 + `options.onError` 無し** → 再 throw (= unhandled rejection、既存挙動と互換)

`f.reset()` 内部で formError も undefined に戻す。

**重要設計判断 — handler 内 try/catch を使わない理由**:

最初の draft では「handler 内で `try { await ... } catch (err) { f.setFormError(...) }` を書く」案だったが、code-reviewer 指摘で **致命的な不整合** が判明:

- handler が **internal try/catch で全 error を catch する**と、handler 自体が resolve で返る
- → bind の catch chain (= ADR 0076 自動消化) には何も届かない
- → **validation error も formError に流れる**、per-field error 表示が壊れる

つまり handler 内 try/catch は ADR 0076 と **構造的に共存できない**。「機構が catch する経路」と「user が catch する経路」を **物理的に分ける** 必要があり、bind 第 2 引数 hook で「機構が catch、user に push する経路」を作るのが解。

**pros**:

- formControl primitive の **責務一貫性**: pending / field / error / bind と同じ machinery で formError + onError も提供、AI/user 両方の認知負荷が下がる
- ADR 0076 の自動 catch (= validation 自動消化) を **完全に保つ**、`f.bind` の catch chain は機構に占有されたまま、user の handler は throw 任せ
- 業界 trend (= 自動消化 + hook) と整合: Conform / TanStack Form / React 19 `useActionState` / Remix `useActionData` 等は皆「server validation を機構が消化、それ以外を user に hook で渡す」路線、本 ADR はそれを 1 primitive 内で完結
- 自動 catch を validation までに留める = 機構誘導の限度を保つ:
  - validation error は per-field 表示が **普遍解** (= 機構が UI を完結できる)
  - network / 500 / business error は **business decision** が要る (= 再試行 button / auto retry / redirect / Sentry 通知 / ignore 等、user 判断分岐)
  - 自動消化を ON にすると一律「formError 表示」になり、business decision の場が消える (= 案 B)
- `f.reset()` 連動で「`pending = false` + `formError = undefined`」が atomic、user の手書き reset 経路が消える
- 握り潰しリスク無し: user が `onError` を渡さなくても `pending` は finally で false に戻り、error は unhandled rejection で global handler / devtools console に届く (= JS 標準挙動、Vidro 固有の罠ではない)

**cons**:

- user が `onError` 渡さないと UI 沈黙 (= console error は出るが form 上は無音、user が「押したけど何も起きない」体験)
  - ただしこれは **ADR 0076 着地時点と完全に同じ挙動**、本 ADR で悪化はしない
  - 解消したい場合は別 ADR で「dev mode warning」or「default ON 化」を再起票する余地
- bind の signature が 1 引数 → 1+1 引数に拡張 (= optional なので breaking change ではない、既存 callsite は無改修)

### 案 B: bind 内部の自動 catch chain を拡張、validation 以外も formError に流す (= default ON)

bind 内部:

```ts
.catch((err) => {
  if (isServerFnValidationError(err)) { setFieldErrors(...); return; }
  setFormError(err instanceof Error ? err.message : String(err));   // ← 追加
})
```

user code は try/catch 不要、`f.formError.value` を表示するだけで完結。

**pros**:

- user code 更にスリム、ADR 0076 の自動 catch 方針と一貫
- silent failure (= user が catch 忘れ) を構造的に消す
- AI 生成 code に強い (= AI が catch 書き忘れても UI に出る)

**cons**:

- business decision の場が消える: 「auth error → /login redirect」「network error → 3 秒後 retry」「rate limit → 別 UI」等を書く place が無くなる (= 全部「formError 表示」一律になる、`f.bind(handler, { autoCatchFormError: false })` opt-out が必要になり API 表面増)
- 自動 catch の責務範囲が **拡大**、機構が「自分が UI を完結できない error」まで握る = 線引きの崩壊
- error が bubble up しなくなる = global handler (Sentry 等) に届きにくい (= setFormError 内部で再 throw する経路を別途用意要)
- ADR 0076 と違って「機構が普遍解を提供できる場合のみ自動 catch」原則を破る

### 案 C: 何もしない (= status quo)

**却下** — ADR 0076 §拡張余地で明示候補、apps/blog dogfood で user 自前 signal を毎 form 書かされる構造が残る、formControl primitive の責務一貫性が崩れたまま

## Decision

**案 A を採用** — `formControl` に 3 点追加:

1. `formError: Signal<string | undefined>` (= reactive 表示用 primitive)
2. `setFormError(msg: string | undefined): void` (= 手動 set / clear method)
3. `bind(fn, options?: { onError?: (err: unknown) => void })` (= bind 第 2 引数 hook、validation 以外の error を user に渡す経路)

`f.reset()` で formError も undefined に戻す。bind 内部の catch chain は ADR 0076 (= validation 自動消化) を **維持**、その後ろに「`options.onError` あり → onError 呼ぶ / 無し → 再 throw」の分岐を追加。

```ts
// packages/form/src/form-control.ts

export type FormControlBindOptions = {
  /**
   * bind 内部 catch chain で validation error 以外の error が出た場合に呼ばれる。
   * 渡されない場合は再 throw されて unhandled rejection 経路に落ちる (= 既存挙動)。
   * `f.setFormError(err.message)` で form-level UI に流すのが典型。
   */
  onError?: (err: unknown) => void;
};

export type FormControl<T extends Record<string, unknown>> = {
  // ... 既存 (field / error / pending / setFieldErrors / reset) ...
  bind(
    fn: (data: T) => Promise<void> | void,
    options?: FormControlBindOptions,
  ): FormControlBindProps;
  formError: Signal<string | undefined>;
  setFormError(message: string | undefined): void;
};
```

bind 内部 catch chain (= ADR 0076 拡張):

```ts
.catch((err: unknown) => {
  if (isServerFnValidationError(err)) {
    applyFieldErrors(err.fields);
    return;
  }
  // ADR 0077: validation 以外を user の onError hook に渡す経路、渡さなければ再 throw
  if (options?.onError) {
    options.onError(err);
    return;
  }
  throw err;
})
```

実装は内部 `formError` signal を 1 個追加、`setFormError` で write、`reset()` の batch 内で undefined に戻す。bind に `options` 引数を追加し、ADR 0076 chain の最後の枝に onError 分岐を挟む。

## Rationale

- **責務一貫性** (= memory `project_api_design_philosophy_object_one_spread`): formControl primitive が提供する UI machinery (pending / field / error) と同じ shape で formError も提供、user が「form 用 reactive primitive はここに集約」と認識できる
- **機構誘導の限度** (= memory `project_layer_separation_principle` の soft 適用): 機構が自動化するのは「機構が普遍解を提供できる場合のみ」原則を保つ。validation = per-field 表示が普遍、network/500 = business decision が普遍解の前提を崩す
- **DX-first** (= memory `feedback_dx_first_design`): user の dream code から逆引き、`f.setFormError("...")` + `f.formError.value` の対称性が業界 standard (= rhf `formState.errors.root`) と整合
- **AI フレンドリー** (= memory `feedback_ai_first_api_design`): API 表面が flat object として 1 個、`f.formError` / `f.setFormError` / `f.bind(fn, { onError })` で AI 補完が完結
- **JS 標準挙動の活用**: user が `onError` 渡さない場合の挙動は ADR 0076 着地時点と完全に同じ (= unhandled rejection、global handler 経由)、本 ADR で挙動劣化はゼロ
- **rhf parity + 一歩先**: rhf は `formState.errors.root` を提供するが server validation の自動消化は無く、user が `setError` を手動で呼ぶ全手動派 (= 公式 docs `handleSubmit will not swallow errors` 明言)。Vidro は ADR 0076 で server validation 自動消化、ADR 0077 で「自動消化されなかった error の hook」を提供、新世代 trend (= Conform / TanStack Form / React 19 `useActionState` / Remix `useActionData` / SvelteKit Form Actions / Inertia.js) と整合
- **handler 内 try/catch との構造的分離**: handler 内で全 error を catch すると bind の catch chain (= ADR 0076 自動消化) を bypass する不整合がある (= code-reviewer 指摘で発覚)、bind 第 2 引数 hook で「機構が catch、user に push」経路を物理的に分けることで、validation 自動消化と user の business decision を **両立** させる
- **既存 callsite 互換**: `bind(fn)` 1 引数形は変更なし、`bind(fn, { onError })` 2 引数形が opt-in 追加、既存 user code は無改修

## Consequences

### 影響範囲

- `packages/form/src/form-control.ts`:
  - `FormControl<T>` interface に `formError` + `setFormError` 追加、内部 signal 1 個追加、`reset()` 内 batch で formError clear
  - `FormControlBindOptions` 新規 export (= `{ onError?: (err: unknown) => void }`)
  - `bind` signature を `bind(fn, options?: FormControlBindOptions)` に拡張、内部 catch chain で validation 以外の error を `options.onError` に渡す枝を追加
- `packages/form/tests/form-control.test.ts`: ADR 0077 describe block (= 初期 undefined / setFormError で値入る / undefined 渡しで clear / reset で undefined に戻る / pending と独立 / 自動 catch chain は formError を触らない / **bind onError option で typical 経路** / **bind onError は validation には呼ばれない (= ADR 0076 維持)** / **bind onError 省略は従来挙動 = unhandled rejection**)
- `apps/blog/src/routes/posts/new/post-form.tsx`: dogfood で `f.formError` 表示 + `f.bind(handleSubmit, { onError: (err) => f.setFormError(...) })` 形に実装 (= 第 14 周目の使い心地 smoke)、handler 内 try/catch は **使わない** (= ADR 0076 経路を bypass しないため)
- `apps/blog/src/routes/posts/[slug]/edit/edit-form.tsx`: 同上

### 振る舞い変更

- **新規 reactive primitive**: `f.formError: Signal<string | undefined>` 追加、初期値 undefined
- **新規 method**: `f.setFormError(msg: string | undefined)`、message 渡しで set、undefined で clear
- **新規 bind option**: `f.bind(fn, { onError })` で「validation 以外の error」を user hook に渡す経路、option 省略は従来挙動 (= 再 throw → unhandled rejection) と互換
- **reset 連動**: `f.reset()` で formError も undefined に戻る (= per-field error / values と一貫)
- **bind 自動 catch chain は ADR 0076 維持**: validation error は引き続き自動 catch、それ以外は **`onError` 渡してれば onError 呼ぶ / 渡さなければ再 throw**
- **既存 callsite 互換**: 既存 user code は `bind(fn)` 1 引数形 + formError / setFormError 未使用、無影響 break なし

### 拡張余地

- 別 ADR 候補: dev mode で「unhandled rejection 時に console.warn でヒント (= 「formError に流すには `f.setFormError` を」)」、production 抜き
- 別 ADR 候補: `f.bind(handler, { autoCatchFormError: true })` opt-in で案 B の挙動 (= 自動 catch ON) を選べる、dogfood で痛み出てから起票
- 別 ADR 候補: form-level error の **multiple message** support (= `formError: Signal<string[]>` で複数 error stack)、業界 demand 出てから
- 別 ADR 候補: form-level error の **structured payload** (= `{ message: string; cause?: unknown; severity?: "error" | "warning" }`)、現時点 string only で十分

### 既知 limit

- `onError` 内で sync throw すると、機構は再 catch せず unhandled rejection に落ちる。`onError` の責務は「副作用で UI / log 系に流す」までで、business 判断の throw は不向き。throw を投げ直したい場合は user 側で別 promise / global handler に委譲する。

## Revisit when

- silent failure (= user が catch 書かない) が dogfood で頻発した時 (= 自動 catch ON 化 or dev warning 起票 trigger)
- structured form error (= severity / cause 等) が dogfood で必要になった時
- multiple form-level error が dogfood で必要になった時 (= 複数 error stack 表示)
- rhf 等の業界 standard 側で form-level error API が変わった時 (= 整合性 renegotiation)
