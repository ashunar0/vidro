# 0082 — Hibana form submit も HTML swap で実装する (`<Form>` + 既存 partial wire 再利用)

## Status

**Draft** — 2026-05-13 (= 第 26 周目で起票、Phase 1〜7 着地後に Accepted へ昇格)

経緯:

- 2026-05-13 (= 第 25 周目、76th session): CRUD form dogfood (= Pure server 流 / island ゼロ) を両 app で完走 (`5cfeb87`)、痛み点 F2 (PRG URL 不整合) + F3 (form submit が ADR 0080 `<Link>` intercept 対象外で full page reload) を発見、`<Form>` + flash の起票候補として持ち越し (= memory [[project_hibana_crud_dogfood_findings]])
- 2026-05-13 (= 第 26 周目、77th session): F2/F3 一緒解消の本 ADR 起票 (Phase 0)。flash 機構 (= cookie/session) は別 ADR (= 候補 0083) として後回し、F2/F3 解消は **redirect follow + pushState の制御だけで成立する**ことを設計時点で確認

着地時 commit:

| commit | Phase   | 内容                                                                |
| ------ | ------- | ------------------------------------------------------------------- |
| TBD    | Phase 0 | ADR 0082 Draft 起票 + roadmap update                                |
| TBD    | Phase 1 | `<Form>` JSX component (= packages/hibana/src/form.ts)              |
| TBD    | Phase 2 | client submit intercept (= client-navigation.ts に submit listener) |
| TBD    | Phase 3 | redirect follow + partial swap + 成功時のみ pushState               |
| TBD    | Phase 4 | dev warning (= action / method 書き忘れ検出)                        |
| TBD    | Phase 5 | dogfood (apps/hibana-demo + apps/hibana-demo-fs 両方 + Playwright)  |
| TBD    | Phase 6 | code-reviewer agent review + Critical fix                           |
| TBD    | Phase 7 | ADR Accepted 昇格 + memory update                                   |

依存: ADR 0080 (= `<Link>` + `<Frame>` + partial HTML wire) — 本 ADR は ADR 0080 の **form sibling**。partial wire / 共通祖先計算 / Frame swap 機構を **そのまま再利用**する、server 側変更ゼロを目指す
関連: [[project_hibana_crud_dogfood_findings]], [[project_adr_0080_status]], [[project_hibana_overview]], [[project_html_first_wire]], [[project_legibility_test]], [[feedback_dx_first_design]]

## Context

第 25 周目 CRUD form dogfood (= Pure server 流 / island ゼロ) を両 app で完走後、2 つの痛み点が残った:

### F2 — PRG (Post/Redirect/Get) 失敗 path で URL bar が action target に変わる

POST `/posts` (= create handler) が validation failure で `c.render(PostNewPage, {values, errors})` を返すと:

- URL bar = `/posts` (= form の action 属性)
- body = `PostNewPage` (= 新規作成 form の HTML)
- reload で「再 POST しますか?」警告 + 同 form 再表示

これは HTTP 仕様通り (= POST 後の URL は action target、200 で body returning means same URL) だが、UX 上「URL と form の不整合」「reload で warn」が発生する。Rails 流の flash + redirect (= 失敗時も別 URL) で解決するが、Hibana は flash 機構 (= cookie / session) を持たない。

### F3 — form submit が ADR 0080 `<Link>` intercept 対象外、全部 full page reload

ADR 0080 Step 5 で `<Link>` click を intercept して fetch + partial swap で SPA 化したが、`<form method="POST">` submit はそのまま browser default = full page reload。CRUD dogfood で form submit する度に page reload が走り、persistent island の Counter (= app shell の banner 右) も毎回 teardown + re-hydrate される。

業界先行例:

| FW              | form intercept         | wire                 | flash 機構            |
| --------------- | ---------------------- | -------------------- | --------------------- |
| Turbo (Hotwire) | `<form>` 自動 boost    | full HTML or Streams | server-side cookie    |
| HTMX            | `hx-post` opt-in       | partial HTML         | (機構なし、user 自由) |
| Inertia         | `useForm` hook 経由    | JSON tree            | server-side session   |
| Remix           | `<Form>` 明示 + action | JSON loader + HTML   | session-based flash   |
| Astro           | (機構なし、素の form)  | full reload          | (機構なし)            |

Hibana の制約 + 哲学:

- **MPA ベース** (= `<Form>` 書き忘れ / JS 切れで素の form submit に倒れる graceful degradation 必須)
- **server は reactivity を知らない、props = 静的 snapshot** (= 設計書、Hibana 中核哲学 2)
- **第 25 周目 CRUD dogfood で Pure server 流 (= island ゼロ) が成立**、Inertia の `useForm` (= client state hook) は哲学不整合、入れない
- **ADR 0080 が partial HTML wire + 共通祖先計算 + Frame swap を既に完成**、本 ADR はこれを form 経路でも再利用するのが筋

これらを満たす 3 軸 (= intercept opt-in / form state location / URL update policy) を本 ADR で確定する。memory [[feedback_dx_first_design]] に従い target syntax 起点で逆引き設計、第 26 周目 77th session で user との設計議論経由で確定。

## Options

### 軸 1: intercept の引き金 (= どの `<form>` を hijack するか)

#### 軸 1-案 A: 全 `<form method="POST">` 自動 boost (Turbo 流)

書く側は何もしない、`<form>` が default で boost、書きたくない時だけ `data-turbo="false"` 等で opt-out。

**却下** — ADR 0080 と整合性を取る (= `<Link>` で明示 opt-in を選択した同じ理由)。Hibana 他機構 (island / layout / metadata / `<Link>`) は全て「明示的に何か書いた時だけ効く」、`<form>` 自動 boost は 1 機構だけ default ON になり Hibana 内対称性に反する。external 送信 (= `<form action="https://...">`) や file upload 等の特殊 case との相互作用も増える。

#### 軸 1-案 B: `<Form>` component (= 採用)

```tsx
import { Form } from "@vidro/hibana";
<Form method="POST" action="/posts">    // FW 機能 opt-in、partial swap で submit
  <input name="title" />
  <button type="submit">Create</button>
</Form>
<form method="POST" action="/external"> // 素の <form>、MPA 動作 (= full reload)
  ...
</form>
```

**採用**。理由:

- **"書いた分だけ" + ADR 0080 整合** = `<Link>` (= GET の SPA 風) と sibling、書く = 明示 opt-in
- **graceful degradation** = `<Form>` 書き忘れ / JS 切れ → 素の form submit で MPA 動作、壊れない (= 既存 CRUD dogfood の挙動そのまま)
- **Remix familiarity** = `<Form>` import + `method` + `action` props で書き味が既知
- **legibility test** (memory [[project_legibility_test]]) = 読んで「これ Form なので SPA 風 submit する」と訳せる

cons:

- 書き忘れリスク (= 内部 form なのに素の `<form>`) = ただし graceful degradation で MPA 動作する、壊れない
- internal/external action の判別を user が頭で判断 = `<Link>` と同じ業界 default cost

#### 軸 1-案 C: `data-hibana-boost` attribute opt-in (HTMX 流)

**却下** — `<Link>` で軸 1-案 C を却下したのと同じ理由。HTML 純度は高いが書く量増、`<Form>` component の familiarity に劣る、Hibana の component API (= Link / Frame と統一) に非整合。

### 軸 2: form state の置き場所 (= client reactive か server 再 render か)

#### 軸 2-案 A: client-side reactive form state (Inertia `useForm` 流)

```tsx
const { data, setData, post, errors, processing } = useForm({ title: "", excerpt: "" });
<input value={data.title} onChange={(e) => setData("title", e.target.value)} />;
{
  errors.title && <span>{errors.title}</span>;
}
<button onClick={() => post("/posts")} disabled={processing}>
  Create
</button>;
```

client が reactive state (= `data` / `errors` / `processing`) を hook で持つ、controlled input、submit hook 経由で server に投げる。

**却下** — Hibana 中核哲学 2 「server は reactivity を知らない、props = 静的 snapshot」と不整合。useForm を入れると form 自体が island 化する (= client-side reactive)、第 25 周目 CRUD dogfood で確立した「Pure server 流 / island ゼロ」が崩れる。Vidro 側の `formControl()` (= ADR 0069) と同路線になり、Vidro と Hibana の identity 差別化が薄まる。

#### 軸 2-案 B: server 再 render に任せる、`<Form>` は dumb (= 採用)

```tsx
<Form method="POST" action="/posts">
  <input name="title" value={values?.title ?? ""} /> {/* uncontrolled */}
  {errors?.title && <span class="error">{errors.title}</span>}
  <button type="submit">Create</button>
</Form>
```

form state は server side で `values` + `errors` props として保持、validation 失敗時は同 page を再 render するだけ。client は素の uncontrolled `<input>`、`<Form>` は submit を intercept して fetch に変換するだけの dumb component。

**採用**。理由:

- **Hibana 中核哲学整合** = server は reactivity を知らない、props = snapshot
- **第 25 周目 CRUD dogfood の Pure server 流維持** = island ゼロのまま F2/F3 解消可能
- **書く量最小** = useForm の data / setData boilerplate なし、素の `<input name>` + value
- **Vidro `formControl()` との差別化** = client reactive 必要なら formControl の Hibana 版を別 pack で opt-in、本 ADR には含めない

cons:

- 入力中の client-side validation 不可 (= submit 後の server validation のみ) — dogfood で痛みになったら opt-in pack 起票
- form state を server round-trip しないと反映されない = ただし fetch + partial swap で round-trip 自体は SPA 風

#### 軸 2-案 C: ハイブリッド (= `<Form>` 内に client state primitive を opt-in で追加)

**保留** (= 将来余地)。理由: 本 ADR の F2/F3 解消には不要、dogfood で client validation の痛みが出たら別 ADR で `formControl()` の Hibana 版を opt-in pack として起票する選択肢を残す。

### 軸 3: URL update policy (= submit 後の URL bar 制御)

#### 軸 3-案 A: 常に action target で pushState (= 普通の form の挙動を踏襲)

**却下** — これは普通の `<form>` と同じ挙動 (= F2 の根)。validation 失敗時に URL bar = action target になり、reload で再 POST 警告。本 ADR の目的に反する。

#### 軸 3-案 B: 成功時のみ pushState、失敗時は URL 据え置き (= 採用)

submit response の挙動で分岐:

- **server が redirect (303 / 302) 返す → fetch が自動 follow → 最終 GET 先 URL を pushState** (= 成功 path、Rails PRG 流)
- **server が 200 + partial body 返す → body swap だけ、URL bar は元のまま** (= validation 失敗 path、F2 解消)

判定は `response.redirected` flag (= fetch standard、redirect が follow されたか) で行う。

**採用**。理由:

- **F2 解消** = validation 失敗時に URL bar = form の元 URL のまま、reload で再 GET (= 再 POST 警告なし)
- **graceful degradation** = JS 切れ時は素の form submit → server の 303 redirect が browser で follow され、結果として URL も同じ位置に着地する (= JS あり/なしで body 内容も URL も同じ)
- **fetch standard 整合** = `response.redirected` は fetch spec の standard、特殊実装不要
- **server logic 変更ゼロ** = handler 側は既存 `c.redirect(success)` / `c.render(failure)` のままで動く

cons:

- POST 後の最終 GET 先 partial response は `Accept: text/html;hibana-partial` 引き継ぎ前提 (= fetch redirect follow が same-origin で headers を引き継ぐ仕様)、Hibana の hibana() middleware が POST 後の partial Accept 経路に対応している必要がある (= 既存 partial mode 経路で対応済)

#### 軸 3-案 C: 失敗時に form action URL を pushState、reload で再 GET 想定

**却下** — server に「POST /posts 失敗時に GET /posts/new に倒れる」routing 規約を追加する必要、機構が増える + handler の自由度を制約。案 B が server 変更ゼロで成立するので不要。

## Decision

**`<Form>` component + 軸 2-案 B (= server 再 render) + 軸 3-案 B (= 成功時のみ pushState)** で確定。

### API shape

```ts
// @vidro/hibana から export
export { Form } from "./form.js";

type FormProps = {
  /** HTTP method (= 通常 "POST"、明示必須にして書き忘れ防止) */
  method: "POST" | "PUT" | "DELETE" | "PATCH";
  /** submit 先 URL (= 必須、書き忘れたら current URL に submit する browser default を避ける) */
  action: string;
  /** form 内容 */
  children?: unknown;
  /** 標準 form attrs を pass-through (= encType, target, autoComplete 等) */
  [key: string]: unknown;
};
```

### Wire spec (= server ⟷ client contract)

**リクエスト**:

```
POST /posts
Accept: text/html;hibana-partial
X-Hibana-Current-Layouts: AppLayout,PostsLayout
Content-Type: application/x-www-form-urlencoded   (= multipart/form-data も可)

title=...&excerpt=...
```

**レスポンス (成功 = redirect)**:

```
HTTP/1.1 303 See Other
Location: /posts/4

(fetch が自動 follow して GET /posts/4 を partial Accept で再要求)
HTTP/1.1 200 OK
X-Hibana-Layouts: AppLayout,PostsLayout
X-Hibana-Title: <new title>
X-Hibana-Common-Ancestor: 1
Content-Type: text/html
Vary: Accept

<partial HTML for innermost Frame>
```

**レスポンス (失敗 = 再 render)**:

```
HTTP/1.1 200 OK
X-Hibana-Layouts: AppLayout,PostsLayout
X-Hibana-Title: <same title>
X-Hibana-Common-Ancestor: 1
Content-Type: text/html
Vary: Accept

<partial HTML for innermost Frame (= 同 form を values + errors 込みで再 render)>
```

通常の MPA submit (= `Accept: text/html` / `Accept: */*`) は **既存 full HTML 経路** で動く (= server logic 完全互換、JS 切れも素の `<form>` で動く)。

### 機構

1. **`<Form>` JSX component** (`packages/hibana/src/form.ts`):
   - `<form method="..." action="..." data-hibana-form>{children}</form>` を render
   - server render 時に `data-hibana-form` marker 付き、それ以外は素の `<form>`
   - method / action は browser native attribute、SSR でそのまま吐く (= JS 切れでも動く)

2. **client submit intercept** (`packages/hibana/src/client-navigation.ts` に追加):
   - `document.addEventListener("submit", handleSubmit)` で `[data-hibana-form]` 検出
   - `event.preventDefault()` → `new FormData(form)` で body 構築
   - `fetch(action, { method, body, headers: { Accept: "text/html;hibana-partial", "X-Hibana-Current-Layouts": ... } })`
   - `redirect: "follow"` (= fetch default) で 303 自動 follow、`response.redirected === true` で success 判定
   - AbortController で並行 submit race 回避 (= ADR 0080 と同じ機構を再利用)

3. **redirect follow + partial swap** (同上 runtime):
   - 成功 path = `response.redirected === true` → `window.history.pushState(null, "", response.url)` + body swap + `scrollTo(0, 0)`
   - 失敗 path = `response.redirected === false` && `response.ok === true` → body swap だけ、pushState なし、scroll 据え置き (= 同 form の error 表示なので scroll しない方が自然)
   - 5xx / network failure / Frame 不在 → `form.submit()` で素の form submit fallback (= graceful degradation)

4. **server 側変更ゼロ**:
   - 既存 hibana() middleware の partial mode 判定 (= `Accept` header) がそのまま POST 経路にも適用される
   - `c.redirect(success_url)` は 303 で返り、fetch が follow して GET partial に着地する自然な flow
   - `c.render(PostNewPage, {values, errors})` は 200 + partial body で返り、client 側で body swap される

5. **dev warning** (`packages/hibana/src/form.ts` runtime):
   - `<Form>` の props に `action` 無し / `method` 無し → console.warn (= dev only)
   - `<Form method="GET">` は warn (= GET なら `<Link>` を使う方が哲学整合、`<Form method="GET">` は意図不明)

### Phase 分割 (= 実装計画、tasks #1-#8 と対応)

| Phase   | 内容                                                                                  | 状態 |
| ------- | ------------------------------------------------------------------------------------- | ---- |
| Phase 0 | 設計 doc + roadmap update + ADR 0082 起票 (Draft)                                     | -    |
| Phase 1 | `<Form>` JSX component (`packages/hibana/src/form.ts` + index.ts export)              | -    |
| Phase 2 | client submit intercept (client-navigation.ts に submit listener + AbortController)   | -    |
| Phase 3 | redirect follow + partial swap + 成功時のみ pushState (response.redirected 判定)      | -    |
| Phase 4 | dev warning (= action / method 書き忘れ + GET method 使用検出)                        | -    |
| Phase 5 | dogfood (apps/hibana-demo + apps/hibana-demo-fs CRUD form を `<Form>` 化、Playwright) | -    |
| Phase 6 | code-reviewer agent review + Critical fix                                             | -    |
| Phase 7 | ADR Accepted 昇格 + memory update                                                     | -    |

## Consequences

### 良くなること

- **F2 解消** = validation 失敗時に URL bar が action target に変わらない、reload で再 POST 警告なし
- **F3 解消** = form submit も SPA 風 navigation、persistent island (= Counter) の state 維持
- **server logic 変更ゼロ** = 既存 `c.redirect` / `c.render` の handler コードがそのまま `<Form>` でも素の `<form>` でも同じ動作、wire 経路だけが client で分岐
- **書き味最小** = `<form>` → `<Form>` の 1 文字差、boilerplate なし、useForm hook 不要
- **graceful degradation** = `<Form>` 書き忘れ / JS 切れ / 5xx 全て素の form submit fallback で動く
- **ADR 0080 機構の最大利活用** = partial wire / 共通祖先計算 / Frame swap / Vary: Accept / dev warning 全てそのまま流用
- **flash 機構なしで F2 解消** = cookie/session 不要、Hibana が session 機構を持たないまま PRG 失敗 path の UX 改善

### Trade-off / 持ち越し

- **flash 機構は本 ADR では扱わない** = success message (= "Post created" 等の 1 回限り通知) は別 ADR (= 候補 0083) で扱う、cookie/session 機構の有無を含めて別途検討
- **client-side validation 不可** = 入力中に validation 出したい場合は formControl() の Hibana 版 (= 仮 `@hibana/form`) を opt-in pack で起票、本 ADR には含めない
- **multipart/form-data (= file upload)** = `<Form>` 経由でも `new FormData(form)` で自動対応するが、dogfood は v1 では skip、必要になったら別 dogfood で検証
- **submit 中の disable / loading 表示** = client reactive state なしの設計上、`<button type="submit" disabled={processing}>` は書けない。必要になったら formControl 版で対応 (= 持ち越し)
- **scroll restoration** = 失敗 path で scroll 据え置きとしたが、長い form の最下部 button で submit → 上部の error 表示が見えない可能性 = dogfood で痛みが出たら error field への auto-scroll を opt-in 化検討
- **`response.redirected` の信頼性** = `redirect: "follow"` で 303 follow した場合 fetch spec で `redirected: true` になる、ただし server が 200 で `Location` header だけ付けた case は redirect 扱いされない (= server logic として c.redirect を使う前提で動く)
- **AbortController による並行 submit race** = ADR 0080 review C-1 と同じ pattern、submit 中に再 submit すると前を abort、最後の submit が勝つ (= 業界 default、Remix と同じ)
- **non-POST method (= PUT/DELETE/PATCH)** = HTML form は POST/GET しか native 対応しない、JS あり経路では fetch で任意 method 可能、JS 切れだと \_method override 等の hack 必要。本 ADR は **POST/PUT/DELETE/PATCH を `<Form>` props で受け、JS あり経路でのみ fetch で送る**、JS 切れ時の non-POST は v1 で skip
- **status code policy** (= ADR 0082 review C-1) = client runtime は `status >= 500` のみ full reload fallback、4xx (= 422 / 400 等の validation 失敗) は redirected=false の partial swap 経路に流す。server 側は validation 失敗を `c.render(page, {errors})` で **200 or 4xx どちらで返しても F2/F3 解消が機能する**。これは `c.json({error}, 422)` 等の `c.redirect` 以外の慣用に道を残すための判断
- **fallback URL は現 URL の reload** (= ADR 0082 review C-2) = swapPartial 失敗 / 5xx / network failure 時は `window.location.reload()` で現 URL を full reload。`window.location.href = action` (= POST 先 URL を GET で叩く) は delete endpoint 等の POST only URL で 404 になりうるため不採用
- **`response.redirected` の厳密な定義** = fetch spec §4.5 の HTTP-redirect fetch が 1 回以上 follow された場合に true。`c.redirect` は 303 を吐くため fetch follow 後に true、`c.render` は 200 directに着地で false。`response.redirected === false && response.ok` = 「redirect なしで成功 status」= validation 失敗 partial と判定する。server が誤って 200 + Location header だけ返した case は validation 失敗と誤識別されるが、`c.redirect` を使う限り発生しない
- **303 follow 後の Accept / X-Hibana-Current-Layouts 引き継ぎ** = fetch spec §4.5 により request-body-header name (= Content-Type 等) のみ削除、それ以外の custom header は same-origin redirect で引き継がれる仕様に依存。dogfood (= 両 app の Delete / Update 経路) で動作確認済
- **dev warning の動作範囲** = `process.env.NODE_ENV === "development"` check のため Vite dev server (`@hono/vite-dev-server`) 経由で動作する。CF Workers production / Node.js prod build では `process` 未定義 or `NODE_ENV !== "development"` で早期 return、overhead ゼロ。tsdown (= `vp pack`) は `process.env.NODE_ENV` を build 時に置換しない (= ライブラリ側として正しい)、app 側 Vite が prod build で置換 → dead code elimination が動く
- **submitter override 無視** = `<button formaction="..." formmethod="...">` 等 SubmitEvent.submitter 由来 attribute は v1 では無視、`<button type="submit">` 1 個 + form 直 method/action の典型形に絞る。複数 submit button / formaction override が dogfood で必要になったら拡張

### 拡張余地 (= 将来 ADR or dogfood trigger)

- **flash 機構 (= ADR 0083 候補)** = success/error の 1 回限り通知、cookie or session via Hono middleware、F2 の success path 体験改善
- **`@hibana/form` opt-in pack** = formControl() 相当の client-side reactive form state、入力中 validation / processing flag / reset、`<Form>` 内で opt-in 化
- **`<Form>` confirm prop** = `<Form confirm="本当に削除?">` で confirm dialog (= delete button 等で有用)、業界 (Remix / Rails) 既出
- **`<Form>` action callback** = submit 成功/失敗で client 副作用 (= toast 表示等)、`onSuccess` / `onError` prop、ただし client reactive 無いと書きにくいので formControl 経由が筋
- **file upload dogfood** = multipart/form-data + progress UI、別 dogfood テーマ
- **non-POST method の JS 切れ対応** = Rails 流 `_method` hidden field override、dogfood で痛みが出たら

## 関連

- [[project_hibana_crud_dogfood_findings]] = F2/F3 痛み点の dogfood ログ (= 第 25 周目)
- [[project_adr_0080_status]] = ADR 0080 (= `<Link>` + `<Frame>` + partial HTML wire)、本 ADR の前提機構
- [[project_hibana_overview]] = Hibana 全体像 + 3 哲学
- [[project_html_first_wire]] = HTML-first wire 哲学
- [[project_legibility_test]] = magic 許容基準
- [[feedback_dx_first_design]] = target syntax 起点設計
- [[project_hibana_layout_direction_pending]] = ADR 0081 (= layout 機構本採用判断)、本 ADR は ADR 0081 中立 (= handler / filesystem 両対応)
- [[project_form_design_decided]] = Vidro 側 form design (= 2-mode + formControl + island)、Hibana 側との対照
- ADR 0079 = per-route head metadata (= submit 後 partial response の `<title>` 更新で再利用)
- ADR 0080 = `<Link>` + partial HTML wire、本 ADR の sibling
- docs/roadmap-hibana.md = Step 5 follow-up として位置づけ
