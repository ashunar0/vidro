# ADR 0040 — Phase 4 step 1: `submission.input` で楽観的 preview を可能にする

- Status: Accepted
- Date: 2026-04-27
- 関連 ADR: 0037 (R-min action), 0038 (per-key submission + programmatic submit)

## 背景 / 動機

ADR 0038 で per-key submission state (value / pending / error) と
`bind()` / `submit()` が揃い、form 送信の最低体験は完成した。次の段階は **Remix /
SolidStart 流の "楽観的更新" (optimistic UI)** で、submit 中に UI が「結果が成功
したかのように」即時反映するパターンを成立させること。

楽観的更新には 2 軸ある:

1. **入力そのものを見せる** — submit 中の入力を UI が直接 render して preview。
2. **結果データを仮置きする** — resource / loader data を仮上書き → error で revert。

`memo: project_action_phase3` の Phase 4 候補は両方 (`submission.optimistic`
field と `submission.mutate(updater)`) を挙げていたが、Vidro の `loader` data は
**毎 fold で作り直される plain prop** (signal-backed ではない) のため、軸 2 を
実現するには router の loader data 配信そのものを reactive 化する必要があり、
影響範囲が大きい。

→ **本 ADR では軸 1 だけを実装** する。`submission.input` (signal) を増やし、
JSX 側で `<Show when={pending && input}>` パターンで pending 行を仮表示するだけで
demo (`/notes`) の体験を完成させる。軸 2 (resource.mutate / loader 連動) は別 ADR。

## 設計判断

### 公開 API 追加 (Submission 型)

```ts
export type Submission<T> = {
  // 既存
  value: Signal<T | undefined>;
  pending: Signal<boolean>;
  error: Signal<SubmissionError | undefined>;
  reset(): void;
  bind(): { "data-vidro-sub": string };
  submit(input?: SubmitInput, opts?: SubmitOptions): Promise<void>;

  // 新規 (ADR 0040 Phase 4 step 1)
  input: Signal<Record<string, unknown> | undefined>;
};
```

### lifecycle

| タイミング                               | input.value                           |
| ---------------------------------------- | ------------------------------------- |
| 初期値                                   | `undefined`                           |
| `submit(rawInput)` 開始時 (programmatic) | `normalizeSubmitInput(rawInput)`      |
| form submit 経路 (`<form {...bind()}>`)  | `Object.fromEntries(formData)`        |
| 完了 (success / error / redirect)        | **保持** (= 直前入力を読める)         |
| 次の `submit()`                          | 上書き                                |
| `reset()` / `_resetRegistryForTest()`    | `undefined` に戻す                    |
| 連打 guard で no-op になった呼出         | 上書きされない (= 1 回目の入力が残る) |

「success/error 後も保持」は SolidStart の `submission.input` と同じ意味論。UI 側で
「直前入力をフォームに戻す」「直前入力を表示し続ける」等の需要に応える。

### normalize ルール (`normalizeSubmitInput`)

```ts
function normalizeSubmitInput(input: SubmitInput | undefined): Record<string, unknown> | undefined {
  if (input == null) return undefined;
  if (input instanceof FormData) return Object.fromEntries(input);
  if (input instanceof URLSearchParams) return Object.fromEntries(input);
  return { ...input }; // shallow clone
}
```

| 入力                 | 出力                             |
| -------------------- | -------------------------------- |
| `undefined` / `null` | `undefined`                      |
| `FormData`           | `Object.fromEntries` (last-wins) |
| `URLSearchParams`    | `Object.fromEntries` (last-wins) |
| plain object         | shallow clone                    |

**意図的に潰しているもの**:

- 重複 key (= `<input name="tag" multiple>` や同名複数 input) は last-wins で潰れる。
  toy 段階の妥協、production 化時は `qs` ライブラリ等で richer decoding。
- `File` / `Blob` 値はそのまま `Record` に入る。型は `unknown` なので caller が
  `value instanceof File` で判別する。
- nested object はそのまま参照される (deep clone しない)。caller が後から書き換えると
  input にも反映されるが、plain object 経路は `{ ...input }` で **トップレベルだけ
  shallow clone** している。

### form 経路の setInput タイミング (router.tsx)

`window` の capture submit listener (`handleFormSubmit`) で、**まず連打 guard
(`mutator.isPending()`) を確認してから** `new FormData(form)` し、`mutator.setInput`
で input 確定 → `dispatchSubmit` に進む。連打 guard を setInput より前に置くことで
ADR の lifecycle 表「連打 guard で no-op になった呼出 → 上書きされない」を form
経路でも守る (review fix #1)。programmatic 経路の `submit()` factory も同じ
guard-first 順序になっており、両経路で挙動が揃う。これにより:

1. 同期: `setInput` → `dispatchSubmit` 内で `setPending(true)`
2. JSX 側の `<Show when={pending && input}>` は次の microtask で正しく `true` に
3. `fetch` 結果が返ったら `setResult` / `setError` + `setPending(false)` で消える

programmatic 経路 (`submission.submit()`) も同じ順序を `submit` factory 内で守る:

```ts
const submit = async (input?: SubmitInput, opts?: SubmitOptions) => {
  if (mutator.isPending()) return; // 連打 guard が先
  if (!_dispatcher) { console.warn(...); return; }
  mutator.setInput(normalizeSubmitInput(input)); // ← dispatch 前
  const path = opts?.action ?? defaultPathname();
  const { body, headers } = encodeSubmitBody(input, opts?.encoding);
  await _dispatcher.dispatch(path, mutator, { body, headers });
};
```

「連打 guard が **先**」 = 2 回目連続呼出では setInput にすら到達しない。これにより
1 回目の input が残ったまま、画面の pending 行は 1 回目の値を保持できる
(test `input: 連打 guard で 2 回目 no-op の時は input も上書きされない` で確認)。

### demo (`/notes`) の最小活用例

```tsx
<ul data-testid="notes-list">
  {data.notes.map((n) => (
    <li>...</li>
  ))}
  <Show when={subCreate.pending.value && subCreate.input.value}>
    {() => (
      <li style="opacity: 0.5;" data-testid="pending-note">
        {`(adding) ${String(subCreate.input.value?.title ?? "")}`}
      </li>
    )}
  </Show>
</ul>
```

- `pending && input` の AND ガードが必須。pending=false の時 (= submit 完了後) は
  「最終入力の影」が出てしまうのでガードが要る。
- loader 自動 revalidate で `data.notes` に新 item が入ったタイミングで `pending`
  が `false` になる → pending 行は自然消滅。本物の note と二重表示にならない。

### 検討して却下したもの

- **`input` を `SubmitInput | undefined`** (= FormData をそのまま signal に保持) →
  caller が `input.value instanceof FormData` で分岐し `.get('title')` を読む形になり、
  楽観 preview の素材としては不便。`Record` に正規化する方が JSX で `?.title` の
  optional chain が効く。重複 key は失うが代償として acceptable。
- **`input` を `Signal<unknown>`** (= plain object はそのまま、FormData は raw) →
  上記と同じ理由で型不明瞭。
- **success 時に input を自動クリア** → 「直前入力を表示し続けたい」需要を握り潰す。
  Solid と同じく user に reset() 任せ。
- **error 時に input をクリア** → 「入力を form に戻して再 submit」UX を妨げる。保持。

## 影響範囲

### 改修ファイル

- `packages/router/src/action.ts`:
  - `Submission<T>` 型に `input` field 追加
  - `SubmissionMutator` に `_input: Signal<...>` + `setInput()` 追加
  - `submission(key)` で `mutator._input` を expose
  - `submit()` 内で `mutator.setInput(normalizeSubmitInput(input))` を dispatch 前に
  - `reset()` で `_input.value = undefined`
  - `_resetRegistryForTest()` で `_input.value = undefined`
  - `normalizeSubmitInput()` helper 新規
- `packages/router/src/router.tsx`:
  - 内部 `SubmissionMutator` 型に `setInput` 追加 (action.ts と整合)
  - `handleFormSubmit` の冒頭で `if (mutator.isPending()) return` (review fix #1) →
    `mutator.setInput(Object.fromEntries(fd))` → `dispatchSubmit` の順
- `apps/router-demo/src/routes/notes/index.tsx`:
  - `<Show when={subCreate.pending.value && subCreate.input.value}>` で pending 行を render
- `packages/router/tests/submission.test.ts`:
  - input lifecycle テスト 10 件追加 (初期 / 各形式の normalize / 引数なし / 連打 guard
    と input / error 後保持 / reset / 別 key 独立 / shallow clone)

### 互換性

- 既存 API の shape 変更なし (Submission 型に field 追加のみ)。
- ADR 0038 までの demo / app は `input` を読まない限り影響なし。
- registry 永続の lifecycle はそのまま (= module scope で共有)、`input` も同じ
  ライフタイムに乗る。

## review fix (本 ADR commit 直前に内蔵)

- **#1 (Important 85%)**: form 経路 (`handleFormSubmit`) で連打 guard が `setInput`
  の **後** にあり、連打時に input だけ 2 回目の値で上書きされる lifecycle 不整合
  を発見。`if (mutator.isPending()) return;` を `setInput` より前に追加して
  programmatic 経路と guard 位置を揃える。`dispatchSubmit` 冒頭の二重 guard は
  直接呼出防衛として残す。
- **#3 (推奨)**: form 経路の連打 guard と input 上書き挙動は unit test 不可
  (`handleFormSubmit` は router 内部 closure)。Playwright 経由の integration
  test か手動確認が要る。本 ADR では programmatic 経路のみ unit test カバー、
  form 経路は今後 integration test 追加課題として認識。

## 残課題 / 後続 ADR

- **軸 2: resource.mutate / loader 連動** (= Phase 4 step 2)
  - `resource.mutate(updater)` で resource data を仮上書き、submit 失敗で revert
  - `submission.mutate(resource, updater)` で submit と resource の bridge
  - loader data を reactive 化するか否かの大きい設計判断
- **navigation 単位の registry clear** (= 別 ADR、ADR 0038 大論点 6 と統合)
  - input / value / error を navigation 跨ぎで clear する機構
- **`input` の型を action signature から逆引き** — generic `A` から `Parameters<A>[0]`
  を経由して input shape を引き当てる。現状は `Record<string, unknown>` で固定。
  type 推論が安定するまで toy のまま。
- **重複 key を保持する形式** — `qs` ライブラリ統合や `URLSearchParams.getAll` 経由の
  array 化。
- **File / Blob を Record 経由で扱う** — 現状は `unknown` に潰れる。multipart 経路で
  楽観 preview を完全にやるには `File` を `URL.createObjectURL` で blob URL 化して
  preview するヘルパが要る。
