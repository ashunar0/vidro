# 0051 — derive 楽観更新と intent pattern: `submission()` / `submissions()` で key 引数廃止

## Status

**Accepted** — 2026-04-30 (41st session)

依存: ADR 0038 (action primitive `submission()` の per-key registry) / ADR 0040 (`submission.input` 楽観 preview) / ADR 0049 (`loaderData()` 痛み B 解消) / ADR 0050 (`signalify()` plain → Store 昇格)

## Context

### 痛みの起点 (= 41st session 議論)

ADR 0050 完了直後、`/notes` に「Delete ボタン」「Add 連打 (= 複数 in-flight 楽観)」「failure rollback」を加えようとして、楽観更新の **構造的決断が未着地** であることが顕在化:

```tsx
// ADR 0050 で書ける形 (= imperative push)
data.notes.push(signalify({ id: -Date.now(), title }));
```

これは:

- **id-keyed reconcile (ADR 0049)** が server 戻り `id: 3` と楽観 `id: -174...` を別 entry 扱いし、reconcile 過程で flicker / 重複表示が起きる
- 失敗時の rollback コードを user が手書きする必要がある (= snapshot / restore)
- TanStack Query 流の client cache 機構 (= `onMutate` / `onError` / `onSettled` の 3 点セット) を Vidro core が自前で持つ重さに繋がる
- `data.notes` (= server 由来 canonical store) を user code が直接書き換える ⇒ 「server-driven な data lifecycle」という Vidro identity と矛盾

### Vidro identity から見た痛みの本質

memory `feedback_props_unification_preference` / ADR 0048 で「**plain snapshot か reactive primitive かを明示分離**」を選んだ流れ。memory `project_html_first_wire` で「**HTML-first wire format**」、memory `project_cache_as_fw_concern` で「**薄い core + 厚い optional pack (`@vidro/query`)**」を選んだ流れ。

これらと整合する楽観更新の流派は **derive (Remix 流)** なのだ:

- canonical store (= `loaderData()`) には書き込まない
- `submission` の pending / input から **UI で derive** して仮表示
- 失敗時は submission が array から外れるだけで rollback **不要** (= 構造的アドバンテージ)
- client cache 機構を持たないので core が薄いまま

逆に **imperative (TanStack 流)** は client cache 機構が必須で、Vidro `@vidro/router` の責務範囲を超える。これは将来 `@vidro/query` (= TanStack 流 cache pack) で別途扱う。

### `submission(key)` API の string key 違和感

ADR 0038 の `submission<typeof action>("create")` は:

- string key (`"create"`) と type (`typeof action`) の **2 重指定**
- typo 検出が build 時に効かない (`"creatd"` も通る)
- `<form data-vidro-sub="create">` と `submission("create")` で **dual source of truth**
- key の命名が action 関数や route と独立 (= user が勝手に決める)

memory `project_type_vertical_propagation` の「型貫通が Vidro identity の核」と整合せず、`feedback_dx_first_design` の「user が書くコードの見た目」観点でも noisy。

「**1 route = 1 action**」規約 (= 設計書) を維持する限り、key は本質的には不要で、複数 form の区別は **HTML 標準の `<button name="intent" value="...">`** (= Remix `<Form>` 慣習) で取れる。

### 単数 / 複数 in-flight

ADR 0038 の現実装は **単数 in-flight** (`if (mutator.isPending()) return;` で連打 silent drop)。Settings 保存のような単発 form では足りるが:

- like ボタン連打 (Twitter 風)
- list への並列 add
- chat 連続送信
- ファイル一括 upload

等の現実 UX (= memory `project_design_north_star` で目指す RealWorld 規模) では **複数 in-flight 必須**。Solid Start `useSubmissions(action)` / Remix `useFetchers()` は両者ともこの形。最初から複数前提で設計する方が後付け破壊変更を避けられる。

## Options

### A — imperative (TanStack 流) を `@vidro/router` で完備

`onMutate` / `onError` / `onSettled` 相当の機構を core に。

- Pros: 高度な cache 制御、cross-route invalidation
- Cons: core が厚くなる (= 設計書「2-layer product structure」の core 哲学に逆行)、memory `project_cache_as_fw_concern` で決めた「@vidro/query で扱う」と二重実装、Vidro identity と齟齬。**即却下**。

### B — derive (Remix 流) を `@vidro/router` の canonical 楽観更新に

`submission` の pending / input を peek して UI で derive。canonical store は触らない。

- Pros: rollback コード不要、client cache 機構不要 (= core 薄いまま)、Vidro identity 整合、HTML-first 整合
- Cons: 楽観行と server 戻りを「同じ list 内で in-place 更新」する UX (= 一部の cache 系 UI) は表現できない (= scope 外、`@vidro/query` 案件)

### C — 両流派をどちらも公式パターンとして提供

`derive` も `imperative` も「user の選択」として両方推奨。

- Cons: 流派が分裂すると user 学習コスト増、"Vidro 流" の identity が立たない、API surface も両対応で重い。**却下**。

### D — derive 派内で `submission(key)` を残す (= 案 B + 既存 string key 維持)

derive 派に倒すが key 引数は keep。

- Cons: string key 違和感が残ったままで identity 弱い。複数 in-flight 対応するなら API が `submission(key)` (latest) と `submissions(key)` (array) で 2 系統の key 引数を増やすことになり API noise 過多。

### E — derive 派 + intent pattern + key 廃止 + 複数 in-flight 対応

案 B を core decision にした上で:

- `submission()` (= latest) / `submissions()` (= array) の 2 factory **どちらも key 引数なし**
- form 区別は HTML `<button name="intent" value="...">` で
- registry は **route path で索引** (= 1 route = 1 action 規約)
- 複数 in-flight: 各 submit 呼び出しが新 instance を生み array に積まれる
- pending は boolean (= 3-state は future)

- Pros: string key 完全消滅、HTML 標準活用、type vertical propagation 整合、複数 in-flight 自然対応、memory 全方位整合
- Cons: 既存 `/notes` の migration 必要 (= 1 ファイル)、`data-vidro-sub` attribute / `bind()` API も廃止

## Decision

**E** を採用。

| 観点                                                | E                                                                          |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| Vidro identity (server-driven data lifecycle)       | ◎ derive 派 = Remix 流の継承                                               |
| memory `project_html_first_wire` 整合               | ◎ HTML 標準 `<button name="intent">` 活用                                  |
| memory `project_type_vertical_propagation` 整合     | ◎ string key 廃止 = `typeof action` 1 経路で型貫通                         |
| memory `feedback_dx_first_design`                   | ◎ user code から noise 除去 (`("create")` 消滅)                            |
| memory `project_cache_as_fw_concern` 整合           | ◎ core は derive のみ、imperative は `@vidro/query` 将来                   |
| memory `project_design_north_star` (RealWorld 規模) | ◎ 複数 in-flight 対応で like / chat / 連続 add 表現可                      |
| 設計書「2-layer product structure」                 | ◎ core 薄いまま、cache 系は pack 化                                        |
| legibility test (memory `project_legibility_test`)  | ◎ 「submissions を intent で filter して表示する」と訳せる                 |
| 実装コスト                                          | 中 (= registry を per-key から per-route に変更、複数 in-flight 配列管理)  |
| migration コスト                                    | 軽 (= `apps/router/src/routes/notes/index.tsx` 1 ファイル + `bind()` 削除) |

## Rationale

### 1. derive 派の構造的アドバンテージ

```tsx
// derive 派 — 失敗時の rollback コードが不要
const subs = submissions<typeof action>();
const pendingCreates = computed(() => subs.value.filter((s) => s.input.value?.intent === "create"));

<For each={pendingCreates.value}>
  {(s) => <li class="opacity-50">{String(s.input.value?.title)} (...adding)</li>}
</For>;
```

- 成功時: action 完了 → loader 再実行 → submission が array から外れる → derive 元から自然消滅、本物 entry が `data.notes` に現れる
- 失敗時: submission が array から外れる (or error 状態で残る) → 仮行が消える、`data.notes` は元のまま (= 何も触ってない)

「**書き込んでないものは消す必要がない**」という単純な理屈で、TanStack の `onError` snapshot/restore に相当する手書きコードがゼロになる。

### 2. intent pattern の HTML 標準性

```html
<form method="post">
  <input name="title" />
  <button name="intent" value="create">Add</button>
</form>
<form method="post">
  <input type="hidden" name="id" value="3" />
  <button name="intent" value="delete">Delete</button>
</form>
```

`<button name="X" value="Y">` を submit 時に FormData に乗せる挙動は **HTML 標準 (HTML Living Standard §4.10.6)**。Vidro / Remix が独自に発明した規約ではない。`name="intent"` は Remix が広めた convention (= 慣習) だが、`name="op"` / `name="kind"` 等 user 命名でも同等動作。

memory `project_html_first_wire` の「HTML-first wire format」哲学と直接整合。JS off でも form は POST で動く (= progressive enhancement 維持)。

### 3. 複数 in-flight が無痛に成立する構造

各 submit 呼び出しが **独立 Submission instance** を生んで array に積まれるだけ。Submission の identity は instance 参照そのもので、key 引数も call-site magic (= React Hooks 流) も不要。

```ts
// 内部実装イメージ
type RouteSubmissions = {
  active: Signal<Submission[]>; // 複数 in-flight
  latest: Signal<Submission | undefined>; // 最新 1 個 view (active 末尾)
};

// route path で registry 索引、key 不要
const _routeRegistry = new Map<string, RouteSubmissions>();
```

intent ごとの分離は user 側で `subs.value.filter(s => s.input.value?.intent === "create")` で行う。fw が intent を特別扱いしない (= "Hono的透明性")。

### 4. boolean pending 維持の理由

3-state (`idle / submitting / loading`) は Remix `useFetcher` が提供する nuance だが:

- 「submitting」と「loading」を区別したい UX は実用上稀 (= "Sending..." → "Saving..." のような細かい text 切替)
- derive 楽観の主要 use case (= isDeleting 判定 / 楽観行表示 / disabled 制御) は **「pending かそうでないか」** だけで足りる
- API surface 拡大はコスト
- 後で `state` プロパティ追加で boolean と共存可能 (= API 互換)

`project_app_scaffolding_strategy` の「痛みベースで進める」原則に従い保留。

### 5. `submission()` (latest) / `submissions()` (array) を分ける理由

| 用途                   | API             | 例                                      |
| ---------------------- | --------------- | --------------------------------------- |
| Settings 保存 (= 単発) | `submission()`  | `<button disabled={sub.pending.value}>` |
| like 連打 (= 複数並列) | `submissions()` | `<For each={subs.value}>`               |
| /notes Add (= 中間)    | どちらでも可    | latest 1 個でも、配列でも書ける         |

両方 export する方が user が意図を表現しやすい (Solid Start `useSubmission` / `useSubmissions` 並走と同じ理由)。実装は内部で同じ registry を参照する 2 view。

### 6. `bind()` / `data-vidro-sub` 廃止

key 不要なので form delegation の attribute marker も不要。**route page 内の全 `<form method="post">` を Router が自動 intercept** する形に変える:

```tsx
// before (ADR 0038)
<form method="post" {...subCreate.bind()}>...

// after (本 ADR)
<form method="post">...
```

opt-out が必要な場合は `<form method="post" data-vidro-no-intercept>` 等の escape attribute (= future、痛みが出てから)。

## Consequences

### 公開 API (= `@vidro/router` から export)

```ts
/** route の latest submission を取る (= 単発 form 用、Settings 等)。 */
export function submission<A extends AnyAction = AnyAction>(): Submission<Awaited<ReturnType<A>>>;

/** route の全 in-flight submission を array で取る (= 複数 in-flight 楽観 UX 用)。 */
export function submissions<A extends AnyAction = AnyAction>(): Signal<
  Submission<Awaited<ReturnType<A>>>[]
>;

export type Submission<T> = {
  /** 各 submission の固有 id (= UUID か counter、楽観行の key prop に使える)。 */
  id: string;
  value: Signal<T | undefined>;
  pending: Signal<boolean>;
  error: Signal<SubmissionError | undefined>;
  input: Signal<Record<string, unknown> | undefined>;
  /** 失敗時の retry。同じ input で再発射。 */
  retry(): Promise<void>;
  /** array から外す (= 楽観行を即消す escape)。 */
  clear(): void;
};
```

### 廃止 API (= breaking change、個人開発なので一斉 migration)

- `submission(key: string)` の string key 引数
- `Submission.bind()` メソッド
- `data-vidro-sub` HTML attribute

### lifecycle 規定

各 Submission instance:

- **生成**: form submit (or `submit()` programmatic) 時に新 instance、`submissions()` array に push、`pending = true`
- **success**: `pending = false`、`value` に action 戻り、loader 自動 revalidate がスケジュール
- **失敗**: `pending = false`、`error` に SerializedError、array には残留 (= retry 可)
- **clear**: array から外す。success 後は user が clear するか navigation で flush
- **default cleanup policy** (= 推奨): success の場合は loader revalidate 完了後に array から自動 remove (= 楽観行が server 戻りで自動消滅、derive 派の核体験)

### 実装ステップ

1. `packages/router/src/action.ts` の registry を per-key string Map から **per-route Map** に refactor
2. 各 entry を「`Submission[]` を保持する slot」に変更、`submission()` は末尾を返す view、`submissions()` は配列 signal を返す
3. dispatcher (`packages/router/src/router.tsx` の form delegation) を `data-vidro-sub` 不要 / 全 post form intercept に変更
4. `apps/router/src/routes/notes/index.tsx` を migration:
   - `submission<typeof action>("create")` → `submissions<typeof action>()`
   - `data.notes.push(signalify(...))` を削除、`pendingCreates` derive computed に
   - Delete ボタン追加 (= dogfood 拡充)
   - intent pattern (`<button name="intent" value="create" / "delete">`)
5. `apps/router/src/routes/notes/server.ts` を intent 分岐に変更 (`create` / `delete`)
6. unit test: 複数 in-flight、intent filter、success cleanup、error retry
7. memory 更新 (= `project_next_steps` / `project_action_phase3` / `project_pending_rewrites`)

### dogfood 検証手順 (= 41st session 末で実機確認)

`apps/router` `vp dev` で:

1. /notes を開く
2. filter input に "Vidro" → count ボタン 5 回 → 楽観 add で `Foo`
   → filter "Vidro" 維持、count 5 維持、`Foo (...adding)` 仮行表示、loader 戻りで本物に置換
3. Add 連打 (= "A" → Add → "B" → Add → "C" → Add)
   → 3 つの楽観行が並行表示、各々が独立 lifecycle で消える
4. Delete を 2 件並列クリック
   → 2 行が opacity-50 line-through、loader 戻りで両方消える
5. action 例外をわざと起こす (= server 側で `throw`)
   → 楽観行が消えて `data.notes` は元のまま (= rollback コードゼロで復帰)

### scope 外 (= 別 ADR で扱う)

- **client cache (TanStack 流)**: dedupe / stale-while-revalidate / cross-route invalidation / prefetch → `@vidro/query` (= memory `project_cache_as_fw_concern`)
- **別 route action 呼び出し**: `<form action="/other-path">` で別 route の action を呼んだ際の submission 帰属。toy では受容、痛みが出たら別 ADR
- **3-state pending**: `state: "idle" | "submitting" | "loading"` API。nuance UX が必要になったら追加 (= boolean `pending` と共存)
- **declarative 楽観更新 helper**: `optimistic(subs, intent, predicate)` 等の sugar。derive 派の primitive で書ける限り user 側 utility に留め、core は薄く保つ
- **楽観行の visual UX**: struck-through / 即消し のどちらを default にするかは **user 選択** (= fw は両対応)、`/notes` dogfood では struck-through 採用

## Revisit when

- **複数 form を 1 route で扱う際の intent pattern boilerplate** が定常化 → `<form intent="create">` のような shorthand attribute を Vidro が認識する案、または `submission.form({ intent: "create" })` factory
- **別 route action 呼び出し**ユースケース定常化 → `submissions({ route: "/notes" })` 等の引数復活 (= 限定的 string key の再導入)
- **3-state UX 痛み**定常化 → `state` プロパティ追加
- **client cache 機能 (dedupe / stale-while-revalidate)** が必要になる規模感に到達 → `@vidro/query` ADR を起票、core はこのまま据え置き
- **楽観行の visual UX で迷う**頻度が高い → core に sugar primitive 追加検討

## 関連

- ADR 0038 — action primitive (= 本 ADR が refactor する対象、per-key registry → per-route registry)
- ADR 0040 — `submission.input` 楽観 preview (= 本 ADR の derive 派の素材、API 形は維持)
- ADR 0048 — props snapshot 規則 (= reactive 化は明示 primitive で declare、`submission` も同流儀)
- ADR 0049 — `loaderData()` (= server-driven data lifecycle 確立、本 ADR の前提)
- ADR 0050 — `signalify()` plain → Store 昇格 (= imperative 楽観更新の限界が露見した起点、本 ADR で「imperative はそもそもやらない」に倒す)
- memory `project_design_north_star` — RSC simpler 代替 / 個人 hobby 規模感
- memory `project_html_first_wire` — HTML-first wire format
- memory `project_cache_as_fw_concern` — 薄い core + 厚い query pack
- memory `project_type_vertical_propagation` — 型貫通 identity
- memory `project_legibility_test` — モデルなしで読めるか
- memory `feedback_dx_first_design` — user code 起点の API 設計
- memory `feedback_props_unification_preference` — props snapshot / reactive 明示分離
- memory `project_app_scaffolding_strategy` — 痛みベースで進める / YAGNI
