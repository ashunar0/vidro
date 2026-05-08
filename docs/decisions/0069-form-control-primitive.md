# 0069 — `@vidro/form` opt-in pack: `formControl()` primitive で client form を fine-grained に制御

## Status

**Proposed** — 2026-05-08 (57th session)

依存: ADR 0058 (`.server.tsx` semantics、`.tsx` で signal 動く)、ADR 0068 (action 置き場 + resource route、formControl が叩く target)、ADR 0049 (loaderData primitive、同形 factory)
関連: ADR 0051 (derive optimistic with intent)、ADR 0059 (validation error primitive)、memory `project_form_design_decided`、memory `project_vidro_zod_pack_pending`、memory `project_3tier_architecture`

## Context

### 痛みの起点 — form dogfood で抽出した残り痛み 2 個

memory `project_form_dogfood_2026_05_08` で 8 痛み点を抽出、56th session で 5 個を ADR 0068 で structural decide した残りが本 ADR で扱う 2 個:

#### 痛み点 3: 型貫通 #4 (form input name → action 引数型 check) は手付かず

```tsx
// apps/blog/src/routes/posts/new/index.tsx (= 現状の Remix mode)
<input name="title" />          // ← 文字列手書き
<input name="body" />           // ← 文字列手書き

// apps/blog/src/routes/posts/new/server.ts (= 現状の Remix mode)
export async function action({ request }: ActionArgs) {
  const fd = await request.formData();
  const title = String(fd.get("title") ?? "");  // ← 同期せず手書き、typo 検出されない
  const body = String(fd.get("body") ?? "");
  const fields: Record<string, string> = {};
  if (!title) fields.title = "Title is required";
  if (!body) fields.body = "Body is required";
  if (Object.keys(fields).length) throw new Response(JSON.stringify({fields}), {status: 422});
  // ...
}
```

= **`<input name="title">` の文字列と action 内 `fd.get("title")` が手書き同期**。typo は build まで見つからず、validation も毎 form 5-10 行 boilerplate。memory `project_vidro_zod_pack_pending` の起票 trigger 「3+ form 痛み」に到達。

#### 痛み点 4 (副次): Show の `when` と children で同じ式を 2 度書く

```tsx
<Show when={() => sub.fieldError.value?.title}>{() => <p>{sub.fieldError.value?.title}</p>}</Show>
```

`sub.fieldError.value?.title` を 2 度書く。1 度で reactive 化したい。

### 設計議論で確定した formControl API surface (memory `project_form_design_decided`)

56th session で AppRouter mode の **island form** = default 推奨経路として、`formControl()` primitive を opt-in pack で提供することに決まった。Remix mode の `submission()` per-route slot とは別軸 (= cross-route POST に強い、submission slot 不整合が構造的に消える、痛み点 1 解消)。

target dream code (= `feedback_dx_first_design` per、syntax 起点 API 逆引き):

```tsx
// apps/blog/src/routes/posts/new/PostForm.tsx (.tsx = client + server 両側実行、island)
import { formControl } from "@vidro/form";
import { z } from "zod";
import { navigate } from "@vidro/router";

const schema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
});

export function CreatePostForm() {
  const f = formControl({ schema });

  const handleSubmit = async (data: z.infer<typeof schema>) => {
    const res = await fetch("/api/posts", {
      method: "POST",
      body: JSON.stringify(data),
      headers: { "content-type": "application/json" },
    });
    if (res.ok) {
      const { slug } = await res.json();
      navigate(`/posts/${slug}`);
    } else if (res.status === 422) {
      const { fields } = await res.json();
      f.setFieldErrors(fields);
    }
  };

  return (
    <form onSubmit={f.bind(handleSubmit)}>
      <input {...f.field("title")} />
      {f.error("title").value && <p class="error">{f.error("title").value}</p>}

      <textarea {...f.field("body")} />
      {f.error("body").value && <p class="error">{f.error("body").value}</p>}

      <button disabled={() => f.pending.value}>
        {() => (f.pending.value ? "Submitting..." : "Create")}
      </button>
    </form>
  );
}
```

### Vidro 哲学整合 (memory cross-check)

| memory                              | 関係                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `project_form_design_decided`       | 2-mode + 3 経路の AppRouter mode 完成、formControl が island form 主軸           |
| `project_vidro_zod_pack_pending`    | 3+ form 痛み trigger 達成、formControl + zod 統合で起票                          |
| `project_3tier_architecture`        | core / +router / +pack の +pack tier、`@vidro/form` opt-in、import で初めて入る  |
| `project_type_vertical_propagation` | 型貫通 #4 (form name → action 引数型) を schema.shape の keyof inference で達成  |
| `project_design_north_star`         | RSC simpler 代替の form 経路完備、AppRouter mode 主軸                            |
| `project_legibility_test`           | `formControl({ schema })` は「schema 渡して form 制御」と読める、合格            |
| `feedback_dx_first_design`          | dream code 起点で API 逆引き、formControl 命名は user 議論で finalize            |
| `project_signal_api_decision`       | Vidro primitive は factory 一本化、composite hook (formControl) は別軸として共存 |
| `feedback_callback_props_pattern`   | `f.bind(handleSubmit)` で event handler 親 bind、子は data だけ受ける統一        |

## Options

### 論点 1: package 位置と命名

#### (1-A) `packages/form/` 新規、`@vidro/form` (= **採用**)

memory `project_3tier_architecture` の +pack tier に置く。`@vidro/core` (`signal` 等 reactive primitive) / `@vidro/router` (routing + submission) と独立、import で初めて入る opt-in。

- **pros**: 3-tier 整合、`@vidro/core` の signal を peer dep で参照、`@vidro/router` 依存ゼロ (= form は cross-route で fetch する形を想定、router の submission registry は使わない)
- **cons**: 新パッケージ 1 個追加、build pipeline / publish flow が 1 個増える (= ただし既存 packages/router と同形なので機構コストほぼゼロ)

#### (1-B) `@vidro/router` 内に formControl を追加

router の export に formControl を merge。

- **pros**: パッケージ 1 個増えない
- **cons**: router の責務肥大化、`@vidro/router` を import するだけで form 機能が bundle に乗る (= 3-tier 違反、opt-in でなくなる)

#### (1-C) `@vidro/core` に formControl を追加

core の primitive 群 (signal/computed/effect) に並べる。

- **pros**: import 場所が単一
- **cons**: core 哲学 (= 「使わなくても動く reactive primitive 最小集合」) に反する、formControl は composite hook で zod 等の外部依存を引き込みうる、core を肥大化させる

→ **(1-A)** 採用、3-tier 維持。

### 論点 2: schema 統合の依存形式

#### (2-A) zod を peer dep、duck-type interface で受ける (= **採用**)

```ts
// formControl は ZodSchema を直接 import せず、parse method を持つ duck-type で受ける
type ParseSchema<T> = {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: (string | number)[]; message: string }> } };
};

export function formControl<T>(opts: { schema: ParseSchema<T> }): FormControl<T> { ... }
```

- **pros**:
  - zod 直依存しない (= bundle に zod が混入しない、user が選択)
  - peer dep にすれば user が zod インストール、form pack は薄い
  - 将来 valibot / yup / ArkType 等 schema lib への切り替え可能 (= `safeParse` 互換 lib なら全部受ける)
- **cons**: type narrowing が user の `z.infer<typeof schema>` を経由する必要、schema lib 切り替えで type 表現が微妙に違う可能性

#### (2-B) zod を直 dependency

`@vidro/form` が zod を直 import、`formControl({ schema: z.object({ ... }) })` で zod schema 必須。

- **pros**: type 推論が直接書ける、user 学習コスト低
- **cons**: zod を強制、bundle に zod が乗る (= 13kb gzip 程度)、schema lib 切り替え不可

#### (2-C) Vidro 独自 schema primitive を用意

`vfield(z.string())` 等の Vidro layer。

- **pros**: 完全 Vidro control
- **cons**: ecosystem 自殺 (= zod を学んだ user に新規学習強要)、機構肥大、YAGNI 大違反

→ **(2-A)** 採用、duck-type で schema lib agnostic、zod が de-facto なので docs では zod example を default 推奨。

### 論点 3: validation timing

#### (3-A) submit 時に全 field validate + blur 時に該当 field validate (= **採用**)

```ts
const f = formControl({ schema });
// 初期: errors 全部空
// blur 時: 該当 field だけ validate、error signal 更新
// submit 時: 全 field validate、blocking error あれば fn 呼ばない
// input 時: error 表示中の field のみ revalidate (= once-errored becomes reactive)
```

- **pros**: UX 標準 (React Hook Form / Formik と同形)、過剰 validate しない、user 学習コスト低
- **cons**: timing logic が機構内に混じる (= 微小)

#### (3-B) submit 時のみ全 field validate

blur 無視、submit のみ。

- **pros**: 機構薄
- **cons**: user が type している間 error 出ない、UX 悪化

#### (3-C) input 時に常時 validate

毎 keystroke で全 field validate。

- **pros**: realtime 表示
- **cons**: 過剰、heavy schema (= async refinement) で performance 痛む

→ **(3-A)** 採用、業界標準で UX OK。

### 論点 4: API surface (= primitive 集合)

採用 (= memory `project_form_design_decided` 確定):

```ts
type FormControl<T> = {
  // submit 制御
  bind(fn: (data: T) => Promise<void> | void): (event: SubmitEvent) => void;
  // field props spread (name + value + onInput + onBlur)
  field<K extends keyof T>(
    name: K,
  ): {
    name: K;
    value: T[K] extends string ? string : never; // current value
    onInput: (e: InputEvent) => void;
    onBlur: () => void;
  };
  // field error 表示用 signal
  error<K extends keyof T>(name: K): Signal<string | undefined>;
  // submit 中 flag
  pending: Signal<boolean>;
  // server 戻り 422 fields を流し込む
  setFieldErrors(fields: Partial<Record<keyof T, string>>): void;
  // form 全 reset (success 後等)
  reset(): void;
};
```

各 method の責務:

- **`bind(fn)`**: form `onSubmit` に渡す handler factory。preventDefault → FormData 取得 → schema.safeParse → success なら user fn 呼び出し + pending 管理、failure なら error signal 更新
- **`field(name)`**: `<input>` に spread する props。name + value + onInput (state 更新) + onBlur (validation trigger)。`{...f.field("title")}` で済む
- **`error(name)`**: per-field error signal、`{f.error("title").value && <p>...</p>}` で reactive に表示 (= 痛み点 4 解消、Show 不要)
- **`pending`**: submit 中 true、user fn 実行中も含む。button disabled / "Submitting..." 表示用
- **`setFieldErrors(fields)`**: server 戻り 422 の fields を field error に流す。client 側 schema を passes したが server 側で fail (= unique constraint 違反等) のケース
- **`reset()`**: 全 state クリア。success navigate 後の cleanup や cancel button 用

### 論点 5: SSR / hydration 挙動

#### (5-A) `.tsx` (両側実行) のみ動く、`.server.tsx` で使うと build error (= **採用**)

formControl は signal-based primitive、`.server.tsx` 内 reactive primitive 禁止 (ADR 0058) と同じ規律。

- **pros**: ADR 0058 と整合、build error で意味論誤用検出 (silent no-op 防止)
- **cons**: なし (= ADR 0058 既存規律と統一)

#### (5-B) `.server.tsx` でも使える (server で initial state、client で hydrate)

- **pros**: 場所制約なし
- **cons**: ADR 0058 と矛盾、`.server.tsx` 内 signal を許容することになり Vidro 哲学崩壊

→ **(5-A)** 採用、`.tsx` (= 両側実行 = client 主体) 必須。

### 論点 6: input value の binding 形式

#### (6-A) controlled (= **採用**)

`f.field("title").value` を `<input value=...>` に渡し、`onInput` で state 更新。

- **pros**: state が single source of truth、reset()/setFieldErrors() で値同期可能
- **cons**: signal-based なので keystroke ごとに signal 更新 + DOM patch (= fine-grained reactive で軽い、React のような VDOM diff コスト無し)

#### (6-B) uncontrolled

`<input>` 自身が値を保持、submit 時に FormData で取得。

- **pros**: 最小機構
- **cons**: reset()/setFieldErrors() で input 値を制御できない、user 期待 UX 達成困難

→ **(6-A)** 採用、controlled が業界標準 + reset/setError を可能にする。

### 論点 7: type 貫通 (= 痛み点 3 解消)

#### (7-A) schema → field name keyof inference (= **採用**)

```tsx
const schema = z.object({ title: z.string(), body: z.string() });
const f = formControl({ schema });

f.field("title"); // ✓
f.field("body"); // ✓
f.field("typo"); // ✗ TS error: "typo" is not in keyof T
f.error("typo"); // ✗ TS error 同上

const handleSubmit = async (data: z.infer<typeof schema>) => {
  data.title; // string
  data.body; // string
  data.typo; // ✗ TS error
};
```

- **pros**: 型貫通 #4 完成、文字列手書き同期問題が消える
- **cons**: schema lib (= zod 等) の type 推論に依存 (= 業界標準なので OK)

実装上は `formControl<T>` の T を `z.infer<typeof schema>` から推論、`field<K extends keyof T>` で名前を絞る。zod の `safeParse` 戻り型が標準で `T` を返すので `formControl({ schema: z.object({...}) })` だけで T 推論可能。

### 論点 8: form data encoding (= submit 経路)

formControl の `bind(fn)` は user fn に **parsed data** (= schema.safeParse の戻り値) を渡す。fetch/encoding は user の handleSubmit に委ねる:

```ts
const handleSubmit = async (data: z.infer<typeof schema>) => {
  // user が JSON / FormData / urlencoded を選んで fetch
  await fetch("/api/posts", {
    method: "POST",
    body: JSON.stringify(data),
    headers: { "content-type": "application/json" },
  });
};
```

- **pros**: form pack は encoding に責務持たない、user 自由
- **cons**: user が fetch boilerplate を書く (= ただし 3 行、validate して投げる責務分離は明確)

将来 `submitTo("/api/posts")` 等の helper を提供する道はあるが、本 ADR では opt-in pack の最小機能に絞る。

## Decision (= 8 論点まとめ)

| #   | 論点                  | 決定                                                                                   |
| --- | --------------------- | -------------------------------------------------------------------------------------- |
| 1   | package 位置          | **`packages/form/` 新規、`@vidro/form`** (3-tier の +pack tier)                        |
| 2   | schema 統合の依存形式 | **zod を peer dep + duck-type interface (`safeParse` 互換)**、schema lib agnostic      |
| 3   | validation timing     | **submit で全 field + blur で該当 field + error 中 input で revalidate** (業界標準 UX) |
| 4   | API surface           | **`bind/field/error/pending/setFieldErrors/reset` の 6 method**                        |
| 5   | SSR / hydration       | **`.tsx` のみ動く** (`.server.tsx` で使うと build error、ADR 0058 整合)                |
| 6   | input value binding   | **controlled** (state が single source of truth)                                       |
| 7   | type 貫通             | **schema → field name keyof inference** (型貫通 #4 完成)                               |
| 8   | form data encoding    | **user 委ね** (formControl は parsed data を user fn に渡すまで)                       |

### Scope (= 本 ADR で扱う / 扱わない)

| 項目                                                | 本 ADR で扱う?                                      |
| --------------------------------------------------- | --------------------------------------------------- |
| `formControl()` factory + 6 method                  | ✅                                                  |
| zod schema 統合 (duck-type)                         | ✅                                                  |
| 型貫通 #4 (schema → field name keyof)               | ✅                                                  |
| `.server.tsx` build error (formControl 使用検出)    | ✅ (ADR 0058 既存検出機構に追加)                    |
| `submitTo("/path")` helper                          | ❌ (YAGNI、user の fetch で十分)                    |
| `validator(schema, fn)` (server-side validation)    | ❌ (= 別 ADR、`@vidro/form/server` で将来検討)      |
| FormData encoding helper                            | ❌ (user の fetch に委ねる)                         |
| async validation (= zod async refinement)           | △ (initial 実装は sync only、async は将来拡張)      |
| array / nested object field                         | △ (initial 実装は flat object のみ、後で拡張)       |
| field-level optimistic UI (= submission optimistic) | ❌ (`submission()` の責務、formControl と独立)      |
| reset on success (auto)                             | ❌ (user が `f.reset()` を明示的に呼ぶ、magic 排除) |

## Rationale

### 痛み点 3 (型貫通 #4) の解消

`formControl({ schema })` で schema.shape を keyof として field 名に伝播する。`<input name="typo">` 文字列の typo は build 時に検出、`fd.get("typo")` の手書き同期も消える (= user は parsed data を直接受ける)。

memory `project_type_vertical_propagation` の 9 経路のうち #4 (URL pattern → loader/page args) と並ぶ重要経路、本 ADR で着地。

### 痛み点 4 (Show の when/children 重複) の解消

`f.error("title").value` が直接 reactive value (Signal<string | undefined>)、`{f.error("title").value && <p>...</p>}` の short-circuit で表示分岐できる。Show 不要。memory `project_jsx_runtime_contract_pending` の thunk 議論を待たずに痛み解消。

### 痛み点 1 (submission slot vs cross-route POST) の解消

formControl は **submission registry を使わない**。fetch を直接呼ぶ形なので per-route slot 不整合が構造的に発生しない。submission() は同 path co-location 経路 (= Remix mode) 専用の primitive として残し、formControl は AppRouter mode の cross-route POST + island 経路として並走する。

両 primitive の使い分けは 2-mode (memory `project_form_design_decided`) で整理済。

### opt-in pack として独立する理由

formControl は composite hook (= 内部で signal/effect/computed を組み合わせる) であって reactive primitive ではない。`@vidro/core` (= primitive 集合) に置くと:

1. core が肥大化 (= API 数増、bundle 増)
2. zod 等 schema lib への duck-type 依存が core 哲学 (= 外部依存ゼロ) を破る
3. opt-in 性が消える (= core import で formControl も乗る)

3-tier (memory `project_3tier_architecture`) の +pack tier に置けば、import で初めて入る、bundle 影響を user が制御できる。

## Consequences

### Pros

- **痛み点 3 (型貫通 #4) 解消** = `<input name>` 文字列手書き同期 → `keyof T` inference、typo 検出
- **痛み点 4 (Show の when/children 重複) 解消** = `f.error("title").value` 直接 reactive
- **痛み点 1 (submission slot vs cross-route POST) 解消** = formControl は registry 使わない、cross-route POST native
- **AppRouter mode 完成** = island form の主経路として機能、ADR 0068 の resource route と組み合わせて REST 自然
- **schema lib agnostic** = zod 直依存しない、valibot 等への切り替え可能 (= ecosystem 自由度)
- **3-tier 維持** = opt-in pack、bundle に zod / formControl が乗るのは import した時だけ
- **業界標準 UX** = React Hook Form / Formik と同形 timing、流入 user 学習コスト低

### Cons / 残るリスク

- **opt-in なので user が知らないと使われない** = docs での誘導が必要、Vidro README / blog example で formControl を default 推奨化
- **zod 等 peer dep の version drift** = duck-type で受けるので version 固定不要、ただし schema lib の breaking change で `safeParse` shape が変わると追従必要 (= zod は v3→v4 で lib 内部のみ変更、external API は安定のはず)
- **server-side validation 重複** = client formControl で validate しても server action でも validate 必須 (= server を信用しない原則)、ただし schema を共有すれば 2 度書きコストはほぼゼロ (= 同じ z.object を import)
- **async refinement 未対応** = initial 実装は sync schema のみ、async が必要なら user が submit 時に try/catch で server 側 validation に委ねる
- **nested / array field 未対応** = initial は flat object のみ、痛み顕在化したら拡張 (= 既存 React Hook Form / Formik の API を参考)

### 既存 ADR との関係

- **ADR 0058 (`.server.tsx` semantics)**: 影響なし、formControl は signal-based なので `.server.tsx` で禁止される primitive リストに追加 (= ADR 0058 既存検出機構を拡張)
- **ADR 0066 (async server component native)**: 影響なし、formControl は `.tsx` (両側実行) のみ動く
- **ADR 0068 (action 置き場 + resource route)**: 直接連携、formControl が叩く target が resource route (or 同 path action)
- **ADR 0051 (derive optimistic with intent)**: 影響なし、submission() は Remix mode 専用、formControl は AppRouter mode 専用、共存
- **ADR 0059 (validation error primitive)**: 影響なし、422 + JSON `{fields}` 規約は formControl `setFieldErrors()` で受ける
- **ADR 0049 (loaderData primitive)**: 同形 factory、`loaderData()` と `formControl()` は両方 composite hook (= state + control object) で API 整合
- **ADR 0067 (per-route +types codegen)**: 直接活用、resource route の `Route.ActionArgs` が action 引数型として効く

### 既存 memory との関係

- `project_form_design_decided`: 2-mode + 3 経路の AppRouter mode 完成、formControl が island form 主軸、status 「✓ ADR 0069 で着地」に更新
- `project_form_dogfood_2026_05_08`: 痛み点 3 + 4 を decide、status 「✓ ADR 0069 で解決」に更新
- `project_vidro_zod_pack_pending`: 起票 trigger 達成、本 ADR で fulfill、memory は finalize として保管
- `project_3tier_architecture`: +pack tier の最初の住人 (= `@vidro/form`) 確立、3-tier 構造実証
- `project_type_vertical_propagation`: #4 (form name → action 引数型) を本 ADR で着地、9 経路中 5/9 完了
- `project_signal_api_decision`: composite hook (formControl) は primitive (signal) と別軸として共存、二元化追記済
- `project_design_north_star`: AppRouter mode 完成、RSC simpler 代替の form 経路完備
- `feedback_callback_props_pattern`: `f.bind(handleSubmit)` で event handler 親 bind、子は data だけ受ける統一

## Affected files (実装着地時)

- `packages/form/` 新規 (root structure):
  - `package.json`: `@vidro/form` 0.0.0、`@vidro/core` workspace dep、zod peer dep optional
  - `src/index.ts`: `formControl()` factory + types export
  - `src/form-control.ts`: 実装本体 (signal-based state machine + bind/field/error/pending)
  - `tests/form-control.test.ts`: unit test (validation timing / setFieldErrors / reset / type narrowing)
  - `tsconfig.json`, `vitest.config.ts` 等の build 設定 (= `@vidro/router` を mirror)
- `packages/plugin/src/server-component.ts` (or 該当 ADR 0058 検出機構): `.server.tsx` 内 `formControl` import 検出 + build error メッセージ追加
- `apps/blog/src/routes/posts/new/PostForm.tsx`: dogfood 第 3 周目、formControl + island で書き換え
- `apps/blog/src/routes/posts/[slug]/edit/PostForm.tsx`: dogfood 同上
- `apps/blog/src/routes/api/posts/server.ts`: resource route (ADR 0068) で POST endpoint
- `apps/blog/src/routes/api/posts/[slug]/server.ts`: resource route で PATCH/DELETE endpoint
- `apps/blog/package.json`: zod 依存追加 (= dogfood 用)
- `pnpm-workspace.yaml`: zod を catalog に追加 (= 統一 version 管理)

## Validation (= Accepted 化までに実施)

- 既存 ADR (0001-0068) との矛盾なし check (上記表で実施済)
- 既存 memory との整合 check (上記 cross-check 表で実施済)
- `feature-dev:code-explorer` agent 報告は ADR 0068 起票時に実施済 (= 本 ADR は 0068 と連動した同 session 設計)
- user 合意取得 (8 論点 = package 位置 / schema 統合 / validation timing / API surface / SSR / binding / 型貫通 / encoding)、最終 review 待ち
- `feature-dev:code-reviewer` agent review (memory `feedback_review_in_workflow` per、Accepted 化前 or 実装 commit 直前)

## Next steps (= Accepted 化後)

### 段階的 commit 推奨順序

1. **Phase 1**: `packages/form/` の skeleton 作成 (= package.json / tsconfig / 空 index.ts / vitest 設定)
2. **Phase 2**: `formControl()` 実装本体 (= signal-based state + bind/field/error/pending/setFieldErrors/reset)
3. **Phase 3**: type 推論 (= schema → keyof T → field<K> / error<K>)、unit test
4. **Phase 4**: `.server.tsx` build error 検出に `formControl` 追加 (ADR 0058 検出機構拡張)
5. **Phase 5**: dogfood blog migration (= apps/blog の new/edit を formControl + island 化、resource route 経路を ADR 0068 と組み合わせて検証)、zod を catalog に追加

各 Phase は独立コミット可能 (= memory `feedback_collaboration_style` 流の小さな commit)。

## Revisit when

- **async validation (= zod async refinement) の必要性顕在** — sync only initial 実装で痛み出たら拡張
- **nested / array field の必要性顕在** — flat only initial 実装で痛み出たら拡張 (= 既存 lib の API を参考)
- **`validator(schema, fn)` server-side helper の必要性顕在** — formControl の client 側だけでは validate 重複コストが見える時、`@vidro/form/server` で起票
- **`submitTo("/path")` helper の必要性顕在** — fetch boilerplate 3 行が複数箇所で書かれて痛み出たら追加
- **schema lib 切り替え (zod → valibot 等) が dogfood で必要** — duck-type で受けてるので追加 ADR 不要、docs example 更新のみ
