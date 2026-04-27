# ADR 0037 — Phase 3 R-min: action primitive (Remix-style minimum)

- Status: Accepted
- Date: 2026-04-27
- 関連 ADR: 0009 (loader primitive), 0011 (route types), 0014 (server boundary
  prod), 0028 (resource), 0030 (resource bootstrap)

## 背景 / 動機

Phase 1〜2 (reactive primitive + routing) と Phase 3 の **loader 部分** + Phase 3.5
(SSR / streaming / 段階 hydration / TTI) が着地した。書き込み側 (= action / RPC)
が roadmap 残課題で、Phase 3 の本筋。本 ADR で **R-min (= 最小スコープ)** を
着地させる。

R-min の定義:

- Web 標準 `<form method="post">` を Router が hijack して action 経路に流す
- action は `routes/.../server.ts` の export (loader と共存)
- 戻り値を `submission()` factory の signal-like API で読む
- action 後の loader 自動 revalidate (Remix の "POST/Redirect/GET" 体験の核)
- redirect は `Response.redirect(...)` を return して制御
- error は SerializedError として `submission.error` に流す

R-min で **やらないこと** (= 後続の R-mid 以降):

- programmatic submit (`useSubmit({json})`) / JSON content-type
- multiple actions / `name="intent"` 分岐
- 楽観的更新 / mutate
- per-form submission state (= 複数 form の個別管理)
- CSRF / auth middleware (Phase 5/6)
- file upload (`enctype="multipart/form-data"` は原理的に動くが test 対象外)
- nested route の action 階層

## 設計判断

### 大論点 1: RPC 方式 — 案 R-A (Remix 式) 採用

| 案  | 機構                                             | 長所                                     | 短所                                                    |
| --- | ------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------- |
| R-A | `<form method="post">` + action export           | Web 標準、JS 切でも動く、loader と同形式 | 型貫通は `import type { action }` 経由 (= R-min で十分) |
| R-B | `serverFn()` + bundle 時 RPC transform (tRPC 式) | function signature がそのまま型          | bundle pipeline 改修大、JS 切で動かない                 |
| R-C | R-A + R-B 両方サポート                           | 段階導入                                 | API 表面広い、設計負担                                  |

**R-A 採用** (= Web 標準 / 思想優先 + R-min 最小スコープ)。R-B は将来 opt-in で
追加可能 (= 既存 R-A コードを壊さない)。

### 大論点 2: 命名 — `submission()` factory

候補:

| 案                  | 例                                           | 評価                                                                              |
| ------------------- | -------------------------------------------- | --------------------------------------------------------------------------------- |
| `useAction`         | `const result = useAction<typeof action>()`  | React 流。Vidro は ADR 0011 で `useParams` を却下した経緯と矛盾                   |
| `submission()` ⭐   | `const sub = submission<typeof action>()`    | factory 命名 (`signal/computed/effect/resource/submission`)、Remix 内部用語と整合 |
| `action()`          | `const result = action<typeof action>()`     | server export と完全衝突 → 型 import に `as` alias 必要 = boilerplate             |
| `formAction()`      | `const result = formAction<typeof action>()` | 「form 経由」と限定的、JSON 拡張時に rename 圧                                    |
| `currentSubmission` | `currentSubmission.value`                    | `currentParams` 系列だが per-form 状態に向かない                                  |

**`submission()` 採用** (= Vidro 命名規則と Remix 用語の double 整合)。Resource
(ADR 0028) と同形式の signal-like API で揃え、user 認知負荷を下げる。

### 大論点 3: スコープ — R-min まで

`useSubmit` / mutate / per-form state は **R-mid 以降**。R-min は
「Web 標準 form + global submission state」の最小経路だけを開ける。
Phase 4 (resource API 拡張) で mutate と一緒に R-mid を設計する方が自然。

## 実装

### 1. `packages/router/src/action.ts` (新規)

`submission()` factory + `ActionArgs<R>` 型 + internal mutator (`_setSubmission*`)。
Resource (ADR 0028) と同形式の signal-like API:

```ts
export function submission<A extends AnyAction = AnyAction>(): Submission<Awaited<ReturnType<A>>> {
  return {
    value: _submissionResult as Signal<Awaited<ReturnType<A>> | undefined>,
    pending: _submissionPending,
    error: _submissionError,
    reset() {
      /* 全 field 初期化 */
    },
  };
}
```

global state 1 個で、submission() を何回呼んでも同じ signal を見る。
複数 form の per-form state は R-mid。

### 2. `packages/router/src/route-tree.ts`

`ServerModule` 型に `action` field 追加 (loader と並列):

```ts
export type ServerModule = {
  loader?: (args: { params: Record<string, string> }) => Promise<unknown>;
  action?: (args: {
    request: Request;
    params: Record<string, string>;
  }) => Promise<unknown> | unknown;
};
```

### 3. `packages/router/src/server.ts` (handleAction 追加)

`createServerHandler` に POST 経路を追加。流れ:

1. POST → `handleAction(url, request, compiled)`
2. match.server から server module を load → `serverMod.action` を解決
3. action throw → 500 + SerializedError JSON
4. 戻り値が `Response` → そのまま return (redirect 等)
5. plain value → loader 自動 revalidate して `{actionResult, loaderData: {params, layers}}` を 200 で返却
6. action 不在 / server module 不在 → 405 NoActionError

content-type は見ない (= action 内で `request.formData()` を呼ぶ user code に
委譲)。programmatic な JSON encoding は R-mid で `useSubmit({json})` と一緒に。

### 4. `packages/router/src/router.tsx` (form delegation)

Router 内 client mode に `window.addEventListener("submit", onSubmit, true)` を
attach (capture phase で取って bubble の取りこぼし回避)。

```ts
const onSubmit = (e: SubmitEvent): void => {
  const target = e.target;
  if (!(target instanceof HTMLFormElement)) return;
  if (target.method.toLowerCase() !== "post") return; // GET form は intercept しない
  e.preventDefault();
  void handleFormSubmit(target);
};
```

`handleFormSubmit`:

1. form の `action` 属性 || `currentPathname.value` を path に
2. `_setSubmissionPending(true)` → submit 中表示
3. `fetch(path, {method:"POST", body: new FormData(form), headers: {Accept: "application/json"}})`
4. response 分岐:
   - `res.redirected` (= server `Response.redirect()` 経由) → `navigate(path)`
   - JSON `{actionResult, loaderData}` → `_setSubmissionResult(actionResult)` +
     module scope `bootstrapData` を新 `loaderData` で **上書き** + `reset()`
     で reloadCounter 発火
   - JSON `{error}` → `_setSubmissionError(error)`
   - fetch 失敗 → `_setSubmissionError({name:"NetworkError", ...})`
5. `_setSubmissionPending(false)`

bootstrap data 上書き経路は **既存 mechanism の再利用**: Phase A bootstrap data の
consume 経路 (= effect 内 fetchLoaders が `bootstrapData.pathname === pathname`
時に HTTP fetch を skip して in-memory 値を返す) に乗せるだけで、loader を
2 度 fetch しない実装になる。

### 5. demo: `apps/router-demo/src/routes/notes/`

- `server.ts`: in-memory `notes: Note[]` + loader (slice 返却) + action (`title`
  を読んで push、空なら throw)
- `index.tsx`: form + `submission<typeof action>()` で pending / value / error 表示

## 検証

### unit test (新規 11 件、router 全 20/20 pass)

`packages/router/tests/`:

- `submission.test.ts` (6 件): factory 初期 state / `_setSubmission*` mutator /
  result/error 相互排他 / reset / global state 共有
- `server-action.test.ts` (5 件): handleAction の 5 分岐 (plain value / Response /
  throw / action 不在 / server module 不在)

### 実機検証 (wrangler dev + Playwright)

`/notes` で:

1. 初回 SSR + hydrate: notes list 2 件、console error 0 ✓
2. form input "Action primitive shipped!" + submit → list に `#3` が追加 + "Added: ..."
   success message 表示 (= action 実行 + loader 自動 revalidate 完了) ✓
3. 空 input + submit → "Error: title is required" 表示 (= action throw → 500 →
   submission.error) ✓

console "Failed to load resource: 500" は HTTP 500 由来の browser log で expected
(= Remix も同 semantics)。

## Trade-off / 残課題

### `<For>` / Show value accessor 未対応で demo に template literal を使った

demo の notes list は `<For>` を使わず `array.map` で static 展開、しかも各
`<li>` 内の `#{n.id}: {n.title}` は **template literal で 1 dynamic にまとめる**
形にした:

```tsx
{
  data.notes.map((n) => <li>{`#${n.id}: ${n.title}`}</li>);
}
```

理由:

- `<For>` は ADR 0024 の partial 対応で、inactive children eager 評価が SSR と
  整合しない pre-existing 案件 (B-4 案件として `project_pending_rewrites` 記録済み)
- `<li>` 内に `_$text` + `_$dynamicChild` を adjacent に並べると、SSR が連結
  text として markup に出力 → DOM parser は merge して 1 text node に → CSR
  hydrate cursor の split 評価が mismatch する

将来: B-4 完了で `<For>` の hydrate 対応 + JSX whitespace の adjacent text 処理
を `_$text` 1 個 collapse に揃えれば、demo は素直な JSX に書き直せる。
本 ADR スコープ外 (= 既知 hydrate 制約に当たっただけ、action 実装側の問題ではない)。

### global submission state は R-min の意図的 trade-off

複数 form が同 page にあると最後の submit が表示される。R-mid で per-form
binding API (例: `<form {...sub.bind()}>` or context 経由) を追加して解消予定。

### CSRF / auth は別 middleware

R-min は CSRF token / origin check を実装しない (= toy 段階)。Phase 5/6 で
auth middleware と一緒に設計する。

### `fetch` の redirect mode は default (follow)

server `Response.redirect(...)` は fetch が auto-follow して `res.redirected=true`
になる。これを client navigation に流す経路で動くが、307/308 (POST 維持) で
redirect された場合は POST が auto-follow されないこともある (= browser 仕様
依存)。R-min では 303 (= GET 化) を推奨。

### action throw の HTTP status

R-min は **すべての throw を 500** にする (= validation error / system error の
区別なし)。R-mid で `Response` を throw する規約 (Remix の `data()` ヘルパー相当)
を入れて 4xx/5xx を分けるのが自然。

### loader 自動 revalidate は同 path のみ

R-min は action 後に **submit path の loader だけ** 再実行 (= action と同じ
pathname の layout 群 + leaf)。別 path の loader (= sibling page で開いてた data)
は revalidate されない。Remix の `useRevalidator()` 相当は R-mid 以降。

### `<form action="/other">` 別 path 指定時の挙動

bootstrapData 上書き経路の skip 条件は `bootstrapData.pathname ===
currentPathname.value`。`form action="/other"` のように current pathname と
異なる path を指定すると skip 条件が不一致になり、bootstrapData 上書きを
そのまま通すと:

- effect の current pathname での fetchLoaders は bootstrap consume されず
  通常の `/__loader` 経路になる (= 1 fetch 余分)
- 上書きされた bootstrapData が次回の `/other` navigation を skip させる
  (= 別 path 用の data が誤って consume される)

これを避けるため、handleFormSubmit は `path !== currentPathname.value` のとき
**bootstrapData 上書きを行わず `navigate(path)` で正規 navigation に流す**。
fetch 回数は増えるが正確性を優先 (review fix #3)。

R-mid で per-path bootstrap 経路 / 明示的な revalidate API を入れた時に再検討。

### action throw / module load failure の HTTP status は同一 500

R-min は **すべての throw を 500** にする (= validation error / system error /
module load 失敗の区別なし)。client 側 `submission.error` には `SerializedError`
として届くが、`name` は throw された Error の `.name` (default: `"Error"`)。
`server.ts` の dynamic import 失敗も同形式で 500 化されるので、デプロイ不整合
と user code throw は client 側で区別できない。

R-mid で `Response` を throw する規約 (Remix の `data()` ヘルパー相当) を入れて
4xx/5xx を分け、`name: "ModuleLoadError"` 等の識別子を server side で付与する
方が望ましい (review fix #7)。

### Workers の non-JSON error response は NetworkError 化

`handleFormSubmit` は `res.json()` 前に Content-Type が `application/json` か
チェックする (review fix #4)。Cloudflare Workers が server エラー時に raw HTML
error page を返す等、non-JSON が来たケースは `submission.error` に
`{name: "NetworkError", message: "non-JSON response (status N)"}` として流す。
SyntaxError (= JSON parse 失敗) を catch に流すよりも consumer 側で読みやすい。

### concurrent submit / 連打は最初の 1 回のみ通す

R-min は global state 1 個なので、`handleFormSubmit` 冒頭で
`_isSubmissionPending()` を見て in-flight 中は追加 submit を弾く (review fix #1)。
連打 → bootstrapData 上書き競合 / pending leak / loader fetch 競合を構造的に
避ける。

R-mid で per-form binding API (`<form {...sub.bind()}>`) が入った時に per-form
pending guard に格上げ予定。

### redirect 後の pending UI 空白期間

`Response.redirect(...)` 経路で `navigate(path)` した後、新 path の loader fetch
が完了するまでの間 `submission.pending.value` は false (= submit response 受信
直後の finally で解除)。短時間だが「submit 完了を示す pending=false」と
「navigation 中の loading」が同 UX で見えにくい。

R-mid で navigation 中の pending state を別 signal で持つ拡張案件 (`submission`
と navigate の合流点を整理)。

### Vidro の Show は accessor pattern ではない

`<Show when={...}>{(value) => ...}</Show>` の Solid 流 accessor は Vidro 未対応
(= children に value 引数が渡らない)。children 内で signal を直接読む形が
Vidro 流の reactive。demo でも `(r) => ...` 形式で書こうとして hit、`() => ...`

- 内部で signal 直接読みに修正した。

## 結論

- Phase 3 の書き込み側を最小スコープ R-min で着地
- `submission()` factory + Web 標準 form + Router の event delegation + server
  side handleAction + loader 自動 revalidate の 5 点で完結
- 既存 bootstrap data consume 経路の再利用で fetch 重複を回避
- R-mid 以降の拡張点 (per-form / mutate / programmatic submit / RPC) は
  `submission` API を壊さずに opt-in で追加可能な構造

次のステップ:

- Phase 4 resource 拡張 (mutate / AbortController) と一緒に R-mid 設計
- 楽観的更新 (optimistic UI) は mutate と submission の連動として設計
