# 0059 — Validation error primitive: Response throw 規約 + sub.fieldError signal

## Status

**Accepted** — 2026-05-06 (51st session、user 合意取得済、signup form dogfood で発見)

依存: ADR 0037 (action primitive R-min)、ADR 0040 (submission.input)、ADR 0041 (navigation flush)、ADR 0051 (derive 楽観 + intent)
関連: ADR 0058 (.server.tsx semantics)、ADR 0042 (nested action)
注: ADR 0058 文中で「0059 候補 = partial hydration」と予告したが、51st の form sketch dogfood で本論点が先行発見されたため番号を取得。partial hydration は後続 ADR (= 0060+) にずれる

## Context

### 痛みの起点 — 51st signup form dogfood

51st session で `apps/router/src/routes/signup/` を form sketch dogfood として実装した時、validation error の field-level 表示で ad-hoc narrowing が発生:

```tsx
// 現状の signup/index.tsx (= 改善対象)
const fieldErrors = computed<Record<string, string>>(() => {
  const v = sub.value.value;
  if (v && typeof v === "object" && "ok" in v && v.ok === false && "fields" in v) {
    return (v.fields as Record<string, string>) ?? {};
  }
  return {};
});
```

問題:

- **ad-hoc narrowing が冗長**、type 安全性も低い
- **`sub.value.value` の二重 .value access** で legibility 微妙
- **validation error と success を action 戻り値 union で表現する負担** が user code に乗る
- 51st user 反応 (= dogfood 中): "これはちょっと気になるね。submission の返り値の問題か"

### memory `project_action_phase3` の既知残課題

memory `project_action_phase3.md` の Issue 表より:

> validation error (4xx) と system error (5xx) | throw = 500 一本 | `Response` を throw する規約 (Remix `data()` 相当) で 4xx/5xx 分け

Vidro 自身が「未着地」と認識してた残課題が、form sketch dogfood で表面化したタイミング。`feedback_dx_first_design` per の DX-first 起点で primitive 改善余地が見えた。

### 北極星との接続

- `project_design_north_star`: RSC simpler 代替の北極星と整合 (= form mechanic を ergonomic に)
- `project_html_first_wire`: action result は JSON wire が許容される 3 例外の 1 つ
- `project_legibility_test`: ad-hoc narrowing は読みづらく、改善対象

## Options

### (A) Response throw + 専用 signal (= 採用案)

- action は validation 失敗時 `throw new Response(JSON, { status: 422 })`
- client は `sub.fieldError.value` で field error 取得
- `sub.error` (5xx system error) との住み分けで意味論 clear

### (B) 現状維持 (= action 戻り値 union + user 側 narrowing)

- 規約なし、各 user の判断
- ad-hoc 冗長、`sub.value.value` 二重感残る
- 何も解決しない

### (C) Remix 流 helper

- `throw json({fields}, {status:422})`
- helper の magic (= 422 が default) で透明性低下
- 依存追加

### (D) Vidro 独自 helper

- `throw fail({fields})`
- 422 magic + Vidro 専有 API、透明性さらに低下
- helper を library code に保つ negative

## Decision

**(A) Response throw + 専用 signal** を採用する。

### action 側の規約

```ts
import type { ActionArgs } from "@vidro/router";

export async function action({ request }: ActionArgs<"/signup">) {
  const fd = await request.formData();
  const email = String(fd.get("email") ?? "");
  const password = String(fd.get("password") ?? "");

  const fieldErrors: Record<string, string> = {};
  if (!email.includes("@")) fieldErrors.email = "Invalid email";
  if (password.length < 8) fieldErrors.password = "Min 8 chars";

  if (Object.keys(fieldErrors).length > 0) {
    throw new Response(JSON.stringify({ fields: fieldErrors }), {
      status: 422,
      headers: { "Content-Type": "application/json" },
    });
  }

  return Response.redirect(new URL("/", request.url).toString(), 303);
}
```

- `status: 422` が validation error の signal
- body は `{ fields: Record<string, string> }` 形式
- web 標準 (= `throw new Response`)、Hono 流の透明性維持
- helper は将来 ADR で別途 (= YAGNI、user が web 標準で書ける)

### client 側の API

```tsx
const sub = submission<typeof action>();

sub.fieldError.value?.email; // ← string | undefined (= 422 経路)
sub.error.value; // ← system error (= 5xx 経路、既存)
```

新規 signal:

- **`sub.fieldError`**: `Signal<Record<string, string> | undefined>`
- 422 response の JSON body から `fields` を auto parse して expose
- 5xx は引き続き `sub.error` に流れる

### 4xx / 5xx 分けのルール

| status               | content-type              | body             | 振り分け先       |
| -------------------- | ------------------------- | ---------------- | ---------------- |
| 422                  | `application/json`        | `{fields:{...}}` | `sub.fieldError` |
| 4xx (400-499) その他 | `application/json`        | `{fields:{...}}` | `sub.fieldError` |
| 4xx その他           | non-JSON or `fields` 無し | (任意)           | `sub.error`      |
| 5xx                  | (任意)                    | (任意)           | `sub.error`      |
| network error        | -                         | -                | `sub.error`      |

判定条件: **status 4xx + content-type JSON + body has `fields`**。3 つ揃えば validation error 扱い。1 つでも欠けたら system error。

### type 表現

- start = `Record<string, string>`
- 将来の型貫通強化 (= action 入力 shape からの inference、`Record<keyof Input, string>`) は別 ADR で
- 今は simple、後で upgrade 余地を残す

### 既存 submission との関係

| field                | 内容                                        | 状態            |
| -------------------- | ------------------------------------------- | --------------- |
| `sub.value`          | action return value (success path)          | 既存            |
| `sub.error`          | system error (5xx / network / non-JSON 4xx) | 既存            |
| **`sub.fieldError`** | **validation error (4xx + fields body)**    | **新規**        |
| `sub.input`          | 入力値                                      | 既存 (ADR 0040) |
| `sub.pending`        | in-flight                                   | 既存            |

優先順位:

1. action が return → `sub.value` に乗る
2. action が `throw new Response(JSON, {status: 4xx})` で body に `fields` → `sub.fieldError` に乗る
3. action が他の throw (= `throw new Error(...)` / 5xx Response / network 失敗) → `sub.error` に乗る

### navigation flush との整合 (ADR 0041)

- `sub.fieldError` も navigation flush の対象に追加
- 別 path navigate で `sub.fieldError.value = undefined` にリセット
- 同 path navigation flush しない (既存仕様維持)

### How to apply

- **新 form を書く時**: action 内で validation 失敗 → `throw new Response(JSON, {status:422})`、page で `sub.fieldError.value?.<field>` 表示
- **既存 form を migration する時**: action の `return { ok: false, fields }` を `throw new Response` に書き換え、page で narrowing 削除
- **system error と区別したい時**: `sub.fieldError` (validation) と `sub.error` (system) で分岐表示

## Consequences

### Pros

- **field-level error が ergonomic** = `sub.fieldError.value?.email` で direct access、narrowing 不要
- **web 標準で透明性維持** = `throw new Response` は Web 標準、Hono 流哲学と整合
- **4xx/5xx 分けが意味論 clear** = system error と validation error を区別、UX 別出し分け可
- **`project_action_phase3` 残課題が解決** = 既知 issue を着地
- **`feedback_dx_first_design` per 起点** = dogfood で発見 → ADR 化 → 実装 の自然な流れ
- **既存 user code への影響なし** = `sub.value` / `sub.error` は変更なし、`sub.fieldError` は純粋追加

### Cons / Open Questions

- **422 以外の 4xx での fields body 扱い**: 本 ADR は 4xx 全般 (status 4xx + JSON + fields) を validation 扱いとする。401 (Unauthorized) や 403 (Forbidden) で fields を返した場合も sub.fieldError に乗る。狭めるなら 422 限定も検討余地、dogfood で踏んだら別 ADR で
- **field 名 type-safe inference (= `Record<keyof Input, string>`)**: 本 ADR は scope 外、`project_type_vertical_propagation` 系の別 ADR で。今は string field 名 user 責任
- **既存 throw new Response の利用箇所**: 既存 routes は throw = Error 一本で 500 化してた。422 path は新規追加なので backwards compat 問題なし
- **content-type 不一致時の degradation**: server が JSON 以外を返した場合 (= text/html error page 等) は parse 失敗 → `sub.error` に system error として fall back
- **multi-language**: error message は server 側で生成、i18n は user 責任 (= toy 段階で十分)
- **field error の累積**: 同 page で別 form の error と混ざる懸念 → ADR 0051 の per-route registry で route swap で flush される、別 form 間の混入なし

### 既存 ADR との関係

- **ADR 0037 (action primitive R-min)**: throw → 500 の base、本 ADR で 4xx 分岐追加
- **ADR 0040 (submission.input)**: 既存 fields と整合、parallel に新 signal 追加
- **ADR 0041 (navigation flush)**: `sub.fieldError` も flush 対象に追加
- **ADR 0042 (nested action)**: layout.server.ts の action でも本規約適用
- **ADR 0051 (derive 楽観 + intent)**: submission API の延長、per-route registry と整合
- **ADR 0058 (.server.tsx)**: server-only validation logic は本 ADR と組み合わせ可

### 既存 memory との関係

- `project_action_phase3`: 残課題が本 ADR で解決、Issue 表を update (= validation error 4xx/5xx 分けを完了)
- `project_html_first_wire`: action result は JSON wire 例外の 1 つ、本 ADR と整合
- `project_design_north_star`: RSC simpler 代替の北極星具体例
- `project_type_vertical_propagation`: 型貫通の future task として upgrade 余地

## Affected files

- `docs/decisions/0059-validation-error-primitive.md`: 本 ADR (新規)
- `packages/router/src/action.ts`: Submission に `fieldError` signal 追加、registry / flush 対応
- `packages/router/src/router.tsx`: `dispatchSubmit` で 422 (4xx + JSON + fields) parse 経路追加
- `packages/router/src/index.ts`: type 追加 (= SubmissionFieldError か同等)
- `packages/router/tests/`: 4xx + fields → fieldError、5xx → error、navigation flush の test
- `apps/router/src/routes/signup/server.ts`: validation error を throw new Response 形式に書き直し
- `apps/router/src/routes/signup/index.tsx`: `sub.fieldError.value` で取得、computed narrowing 削除、`<Field>` 切り出し
- `apps/router/src/components/field.tsx`: 新規 (= Presentational kind)

## Validation

- 既存 test 全 pass
- 新規 test:
  - 422 + JSON + fields body → `sub.fieldError` 設定、`sub.error` undefined
  - 5xx → `sub.error` 設定、`sub.fieldError` undefined
  - 4xx + non-JSON → `sub.error` 設定 (= fall back)
  - navigation flush で `sub.fieldError` も undefined に
- signup form dogfood (= 全 scenario 動作)
- `feature-dev:code-reviewer` agent review (= optional)

## Next steps after Accepted

1. `@vidro/router` 改修 (Submission に fieldError signal、422 parse path、test)
2. `vp pack` で router を rebuild
3. signup form を新 API で書き直し + `<Field>` 切り出し
4. dev server で動作確認 (= 422 throw、navigation flush 等)
5. memory `project_action_phase3` の Issue 表 update (= 4xx/5xx 分け完了)
6. 型貫通 upgrade (= `Record<keyof Input, string>`) は別 ADR 候補
