# ADR 0038 — Phase 3 R-mid-1: per-key submission + programmatic submit

- Status: Accepted
- Date: 2026-04-27
- 関連 ADR: 0028 (resource), 0037 (Phase 3 R-min action primitive)

## 背景 / 動機

ADR 0037 で Phase 3 R-min が着地し、`<form method="post">` から server `action`
への往復が動くようになった。一方、R-min は **module global signal 1 個** という
意図的な制約があり、複数 form が同 page にあると最後の submit が両方に表示される。
また programmatic submit (= form 経由でない、JSON や custom encoding) もまだ
未対応。Phase 4 で予定している mutate / 楽観的更新も per-form state を前提にする
方が筋がいい。

本 ADR は R-mid を 3 段階に切り、**最も投資効率の高い R-mid-1 だけ** を着地させる。

## R-mid のスコープ分割

memo (project_action_phase3) で「R-mid 候補」として並んでいた 4 項目を、改修
コストと依存で並べ直して段階分けした:

| 段階    | 内容                                           | 改修コスト | 依存                      |
| ------- | ---------------------------------------------- | ---------- | ------------------------- |
| R-mid-1 | per-form state + `sub.submit()` (programmatic) | 中         | なし                      |
| R-mid-2 | `name="intent"` での multiple action 分岐      | 極小       | framework 改修なし (demo) |
| R-mid-3 | nested route の action 階層                    | 大         | route-tree 構造変更       |

**本 ADR は R-mid-1 を実装**し、R-mid-2 は demo の書き方として同梱、R-mid-3 は
別 ADR に切り出す。理由:

- per-form state が入れば mutate API (Phase 4) の土台になる (= 一番投資価値が高い)
- programmatic submit は per-instance state にそのまま attach できる (1 改修で 2
  機能取れる)
- nested action は route-tree 改修が広範で、別観点 (= layout / leaf の階層 +
  fallthrough 規則) を持つので分離した方が思考が綺麗
- intent 分岐は framework が何もしなくても動く (= server action 内で
  `fd.get("intent")` 分岐するだけ)

## 設計判断

### 大論点 1: `submission(key)` を per-key registry 化

R-min は global signal 1 個 (action.ts の module scope `_submissionResult` 等)。
R-mid-1 では **state を `Map<string, signals>` の registry に格納し、user が
明示する文字列 key で引き当てる** 形にする。`submission(key)` を 2 回呼ぶと
同じ signal セットが返り、別 key なら独立。toy 段階なので breaking change を
許容し、demo (`/notes`) も同時に更新する。

**当初検討した「per-instance (call ごとに新規 signal)」を却下した理由**:

per-instance だと、`reset()` による loader 自動 revalidate (= component swap) で
古い NotesPage が破棄され、新 NotesPage が `submission()` を呼んで **空の新
instance を生成** する経路に乗る。submit 直後の "Added: ..." メッセージが
swap で消えてしまい、Remix UX (POST/Redirect/GET の体験) が損なわれる。

→ state のライフサイクルを **component lifetime ではなく module scope** に
持ち上げる必要がある。

### 大論点 1.5: registry の key 戦略 — 案 B-γ 採用

候補:

| 案     | 形                                     | 評価                                                      |
| ------ | -------------------------------------- | --------------------------------------------------------- |
| B-α    | call-order で自動採番 (React hooks 風) | magic、order 依存で fragile、Vidro 哲学 (透明性) と逆向き |
| B-β    | route + call-order                     | route 内では安定、別 route 切替で reset。中途半端         |
| B-γ ⭐ | **explicit string key** (user が明示)  | 明示的、衝突は user 責任、Hono的透明性と整合              |

**B-γ 採用**。`submission("create")` のように user が key を渡すことで、何が
共有されているかコードを読めば即座に分かる。React hooks の magic を持ち込まず、
Vidro の "Hono的透明性" 哲学と整合する。

key 省略時は `"default"` で R-min 互換 (= 1 form の単純ケースは何も書かなくていい)。
複数 form は明示 key を渡して独立管理。

### 大論点 2: form ↔ submission の binding 方式 — 案 X 採用

候補:

| 案  | 形                                           | 評価                                                                |
| --- | -------------------------------------------- | ------------------------------------------------------------------- |
| X   | `<form {...sub.bind()}>` (data attribute)    | spread だけで 1 attribute 注入、ref API 不要、capture 経由で hijack |
| Y   | `<form ref={sub.register}>` (ref 経由)       | DOM Node を直接保持 → in-flight 中 form 自体への参照が増える        |
| Z   | submission を child 宣言 (`<Submission>...`) | JSX 制約強すぎ、Vidro 哲学 (HTML-first) と逆向き                    |

**X 採用**。`bind()` は `{ "data-vidro-sub": key }` という 1 attribute object を
返し、`<form method="post" {...sub.bind()}>` で spread する。Router の
capture-phase submit listener が `data-vidro-sub` を読んで registry から該当
key の mutator を lookup する。

`bind()` を呼んだ form だけ hijack 対象にする (= attribute なしの form は browser
default 動作)。これにより「Vidro が hijack するか否か」が JSX で明示的になる。

### 大論点 3: `submit()` method の input 型推論

候補:

```ts
type SubmitInput = FormData | URLSearchParams | Record<string, unknown>;
type SubmitOptions = {
  encoding?: "json" | "form"; // 明示時はこれが優先
  action?: string; // default: currentPathname
};

sub.submit({ title: "foo" }); // → JSON (default)
sub.submit(formData); // → multipart (browser 推論)
sub.submit(urlSearchParams); // → form-urlencoded
sub.submit({ title: "foo" }, { encoding: "form" }); // → form-urlencoded
sub.submit({ title: "foo" }, { action: "/other" }); // → JSON, /other に POST
```

**推論ルール**:

- `FormData` → multipart (Content-Type は browser が boundary 込みで設定)
- `URLSearchParams` → `application/x-www-form-urlencoded`
- plain object + `encoding: "form"` → URLSearchParams 化 (= form-urlencoded)
- plain object (default) → `application/json` で JSON.stringify

server 側は action 内で `request.formData()` か `request.json()` を user code が
選ぶ (framework は content-type を見ない)。R-min から不変。

### 大論点 4: dispatcher の inversion of control

`submission()` モジュール自体は Router の closure 状態 (bootstrapData / reset /
navigate / currentPathname) を持っていない。`submit()` method がこれらに依存
しないと「programmatic submit 後の loader 自動 revalidate」が組めない。

→ **dispatcher pattern**: action.ts に `_registerDispatcher(d)` を export。
Router の client mode が dispatcher を作って register、unmount 時に
`onCleanup(() => unregister())` で解除。`submission()` の `submit()` method は
登録された dispatcher を呼ぶだけ。

```ts
// action.ts
let _dispatcher: SubmitDispatcher | null = null;
export function _registerDispatcher(d: SubmitDispatcher): () => void {
  _dispatcher = d;
  return () => {
    if (_dispatcher === d) _dispatcher = null;
  };
}

// router.tsx (Router 内 client mode)
const dispatcher = { dispatch: (path, mutator, fetchInit) => { ... bootstrapData / reset / navigate を closure 経由で参照 ... } };
const unregister = _registerDispatcher(dispatcher);
onCleanup(unregister);
```

SSR 時 / Router unmount 中は dispatcher 不在で `submit()` は no-op (= warn + return)。

### 大論点 5: 連打 guard は per-key に格上げ

R-min は global state 1 個なので「最初の 1 回だけ通す」global guard だった。
R-mid-1 では **same key での連打** だけを弾く (= 別 key の form は並列 submit
可能)。

```ts
const submit = async (input?, opts?) => {
  if (mutator.isPending()) return; // per-key guard
  // ...
};
```

別 key が並列 submit した場合、loader 自動 revalidate (= bootstrapData 上書き

- reset()) は **client 側 response 受信順で last-wins**。R-min と違い、複数
  form が同時に動く状況を許容するのが per-key 化の意図。

**ただし重要な注意点**: 「last-wins」は **server 側 mutation 順** ではなく
**client への response 受信順**。例えば create を先に投げて delete を後に
投げた場合でも、ネットワーク順で delete response が先に着くと、後から着く
create response が bootstrapData を上書きして「delete 後の list」が「create
前の list」で上書きされる現象が起きる (= cross-contamination)。toy 段階では
受容するが、production 化するなら request id で順序保証する仕組みが必要
(= R-mid-3 / Phase 5 で再検討、project_pending_rewrites 記録)。

## 実装

### 1. `packages/router/src/action.ts` 改修

- `submission(key = "default")` を per-key registry 化:
  - `_registry: Map<string, SubmissionMutator>` を module scope に配置
  - `submission(key)` 呼出時に registry から mutator を引き当て or 新規作成
  - signal は mutator 内に保持 (= state は registry が GC されない限り永続)
  - `bind()`: `{ "data-vidro-sub": key }` を返す
  - `submit(input?, opts?)`: dispatcher 経由で fetch + state mutator 呼び出し
  - `onCleanup` 不要 (= state は意図的に永続化)
- 旧 `_setSubmissionPending` / `_setSubmissionResult` / `_setSubmissionError` /
  `_isSubmissionPending` は廃止 (= breaking)
- 新 internal API:
  - `_getSubmissionMutator(key)`: registry lookup (= router.tsx の form delegation 用)
  - `_registerDispatcher(d)`: dispatcher 登録 (= router.tsx の Router 内 mount 時)

### 2. `packages/router/src/router.tsx` 改修

- form submit listener:
  - `target.dataset.vidroSub` が無ければ hijack せず browser default 動作
  - key があれば `_getSubmissionMutator(key)` で lookup → 該当 mutator で書き込み
- dispatcher 作成:
  - `dispatch(path, mutator, fetchInit)`: 旧 `handleFormSubmit` のロジックを共通化
    (form 経由 / programmatic 経由の両方が呼ぶ)
  - mount 時 `_registerDispatcher(d)`、`onCleanup` で unregister

### 3. `packages/router/src/index.ts`

`submission` 公開 API は不変 (型 augment のみ)。`Submission<T>` 型に `bind()` と
`submit()` を追加。

### 4. demo: `apps/router-demo/src/routes/notes/`

- `index.tsx`: `submission<typeof action>("create")` と `submission<typeof action>("delete")`
  で 2 form の state を独立管理。各 note に delete button (per-note form)。
  `{...sub.bind()}` を spread。
- `server.ts`: action で `fd.get("intent")` 分岐 (`create` / `delete`)。delete は
  `id` (number) で lookup → splice。intent 不正 / 該当 note なしは throw。

これにより R-mid-2 (intent 分岐) の書き方も同 demo でカバーされる。

## 検証

### unit test

`packages/router/tests/submission.test.ts` を per-key 用に書き換え:

- 同 key 共有 (`submission("k1")` を 2 回呼ぶと同じ signal セット)
- 別 key 独立 (k1 / k2 の signal は互いに干渉しない)
- `bind()` は data-vidro-sub に key を入れる
- **state 永続**: setResult 後の再 `submission(key)` で value 保持 (= swap simulation)
- reset() は当該 key の field のみ初期化 (別 key には影響なし)
- `submit({title:"x"})` → `Content-Type: application/json` + body は JSON
- `submit(formData)` → multipart (browser default)
- `submit(input, { encoding: "form" })` → urlencoded
- `submit` の lifecycle (pending true → result/error → pending false)
- 連打 guard が per-key (k1 in-flight 中の k1 は弾く、k2 は通る)
- dispatcher 不在時 no-op + warn

### server-action.test

R-min から不変 (server 側は per-instance 関係ない)。

### 実機検証 (wrangler dev + Playwright)

`/notes` で:

1. 初回 SSR + hydrate: notes list、console error 0
2. create form submit: 新 note が list に追加 + create success message
   (= state が swap を超えて保持される、Remix UX 維持)
3. delete button: 該当 note が消える + delete success message
4. 2 form を高速連打: 別 key の状態が干渉しない (= create と delete の value が
   両方表示される)
5. delete 中の同 form 再 submit: 連打 guard で弾かれる

## Review fix (内蔵)

`feature-dev:code-reviewer` agent の Important 5 件を全 fix 済み:

- Issue #1 (parallel submit cross-contamination): 大論点 5 に「client response
  受信順での last-wins、server mutation 順とは異なる」明記。toy 段階の受容を
  明示
- Issue #2 (redirect 後の state 残留): `dispatchSubmit` の redirect 分岐に
  「submission の value/error は前回の値が残る、navigation 単位の clear は別 ADR」
  コメント追加
- Issue #3 (mutator 不在 fallthrough): `onSubmit` に「hydrate 完了前の極小窓
  で発生、browser default の full-page POST に委ねる、preventDefault しないのは
  意図的」コメント追加
- Issue #4 (encodeSubmitBody の File/Blob 欠落): `stringifyFormValue` の JSDoc
  に「File/Blob は JSON で `{}` に潰れる、バイナリは FormData を直接渡す」追記
- Issue #5 (test の `beforeEach` key 漏れ): `_resetRegistryForTest()` を export
  に追加、test の `beforeEach` を切替え

## Trade-off / 残課題

### state は意図的に永続 (= 軽い leak を許容)

per-key registry は **module scope で永続** する。component swap で破棄され
ない設計が Remix UX (POST/Redirect/GET の表示維持) の核だが、副作用として:

- `/notes` で submit → `/about` に navigate → `/notes` 戻ると古い "Added: ..."
  が見える (= state 残存)
- 一度使った key の registry entry は app 寿命まで残る (= 軽い memory leak)

R-mid-1 では受容。navigation 単位の state clear API は別 ADR (Phase 5 の
`useRevalidator` 相当と一緒に設計するのが筋)。

### dispatcher が register されてない時の `submit()` 呼出

SSR 時 / Router unmount 中 / Router の外で `submit()` を呼ぶと dispatcher 不在。
この時は **silent no-op + console.warn** (= "no router dispatcher registered")。
プログラム動作を止めず、debug しやすい。

### intent 分岐の type-safety

R-mid-2 の intent 分岐は runtime のみ (= `fd.get("intent")` で分岐)。type-safe な
multi-action API (= named export `{ create, delete }` を framework が認識する) は
R-mid-3 以降。R-mid-1 では `submission<typeof action>()` の generic は action
全体の戻り値 union になる前提で、user 側で narrow する。

### loader 自動 revalidate は same-path のみ

R-min から不変。`submit({ action: "/other" })` で別 path に POST すると、現在の
pathname の loader は revalidate されない (= `navigate(/other)` 経路に流れて新 path
の loader が走る)。Remix の `useRevalidator()` 相当は別 ADR。

### key 衝突は user 責任

同じ key で 2 つの component から `submission(key)` を呼ぶと、同じ signal
セットが共有される。これは **意図的な使い方** (= layout と leaf で同 submission
を読む等) が可能になる利点もあるが、誤 collision は防げない (= TypeScript の
string literal で enforce する仕組みは入れていない、過剰な abstraction を
避けるため)。

実用上は:

- 1 component 内で複数 form → ユニーク key で書く (`"create"` / `"delete"`)
- 別 component 間の意図せぬ衝突 → 同 app 内で key 名を予約しない方針 (= 短すぎる
  key を避け、`"notes/create"` 等 namespace 化する)

R-mid-3 で nested action / action arg の RPC type 化を入れる時に再検討。

## 結論

- R-mid-1 で `submission(key)` per-key registry 化 + `bind()` + `submit()` を
  最小投資で着地。Remix UX (state を swap 跨ぎで維持) を保つために state を
  module scope に持ち上げた
- R-mid-2 (intent 分岐) は demo に同梱、framework 改修ゼロ
- R-mid-3 (nested action) は別 ADR に分離
- mutate API (Phase 4) は per-key state を前提に設計可能になった

次のステップ:

- Phase 4 mutate API を per-key submission に attach する形で設計
- navigation 単位の state clear API (= `useRevalidator` 相当) を Phase 4 で設計
- R-mid-3 (nested action) は route-tree 改修と一緒に別 session
