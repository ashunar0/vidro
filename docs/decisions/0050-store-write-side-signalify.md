# 0050 — store の write-side: explicit `signalify()` で plain → Store 昇格

## Status

**Accepted** — 2026-04-30 (40th session)

依存: ADR 0047 (store primitive) / ADR 0048 (props snapshot 規則) / ADR 0049 (`loaderData()`)

## Context

### 痛みの起点 (= 40th session 実機体感)

ADR 0049 で `loaderData()` を入れた直後、apps/router/notes に楽観更新を書こうとして TS error:

```tsx
const data = loaderData<typeof loader>(); // Store<{ notes: Note[] }>

function add(title: string) {
  data.notes.push({ id: -1, title }); // ❌
}
```

```
TS2322: Type 'number' is not assignable to type 'Signal<number>'.
TS2322: Type 'string' is not assignable to type 'Signal<string>'.
```

`Store<Note[]>` の `push` が要求するのは `Store<Note>` (= `{ id: Signal<number>; title: Signal<string> }`)。plain `Note` を投入できない。FormData の `title` 文字列を leaf に持つ plain object を、毎 callsite で `{ id: signal(-1), title: signal(title) }` のように手で wrap するのは boilerplate 爆発。

### Vidro identity から見た痛みの本質

ADR 0048 (props snapshot 規則) で「**plain snapshot か reactive primitive かを明示分離**」する identity を選んだ。FormData / props は plain snapshot、Store / Signal は明示 primitive (`signal()` / `store()` / `loaderData()`) で declare。

楽観更新の場面では:

- 入力源 (FormData / 演算結果 / WebSocket push 等) は **plain snapshot**
- store の append 先は **reactive Store**

つまり「**plain snapshot を Store に昇格させる**」操作が必要で、これを誰がどの API でどう書くかが論点。

## Options

### A=D — write 型を plain `E` に統一、fw が裏で signalify

```tsx
data.notes.push({ id: -1, title }); // ✓
```

```ts
type StoreArray<E> = {
  readonly [i: number]: Store<E>;
  push(item: E): number;     // ← 引数は plain E
};

push(item: E): number {
  const wrapped = signalifyDeep(item);  // fw が裏で変換
  this._raw.push(wrapped);
  this._notify();
  return this._raw.length;
}
```

- Pros: user コード最短、boilerplate ゼロ
- Cons: 「fw が裏で signalify する」magic を 1 つ持ち込む。Vidro の他 primitive (`signal` / `store` / `loaderData` / `signal_resource`) は全て explicit name で declare する流儀から外れる。push に渡した object と実際に store に乗る要素が **別 instance** という invariant が runtime で隠れる

### B — `E | Store<E>` union で両受け

```tsx
data.notes.push({ id: -1, title }); // ✓ plain
data.notes.push(otherStoreNote); // ✓ Store も
```

- Pros: 既存 Store の持ち回しもサポート
- Cons: 型が広い (= `E | Store<E>` を読み手が解釈)。「既存 Store を push 引数にしたい」ユースケースは現時点で無い (= YAGNI)

### C — 諦め (`as any` 各 callsite)

```tsx
data.notes.push({ id: -1, title } as any);
```

- Cons: 各 callsite で escape hatch、legibility 完全破綻 (= 即却下)

### E — explicit `signalify()` を export、user が明示昇格

```tsx
import { signalify } from "@vidro/core";

data.notes.push(signalify({ id: -1, title }));
```

```ts
type StoreArray<E> = {
  readonly [i: number]: Store<E>;
  push(item: Store<E>): number; // ← 据え置き (read 型と統一)
};

export function signalify<T>(value: T): Store<T>;
```

- Pros: ADR 0048 の流儀 (= reactive 化は explicit primitive で declare) と整合、既存 primitive 群と consistent、magic ゼロ、push 前後の identity 関係が type 上 expressive
- Cons: 各 callsite で 1 token (`signalify(...)`) 増える

## Decision

**E** を採用。

| 観点                                                                                | E                                                              |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Vidro identity (ADR 0048 + memory `feedback_props_unification_preference`) との整合 | ◎ 既存 primitive (signal / store / loaderData) と同流儀        |
| legibility test (memory `project_legibility_test`)                                  | ◎ 「plain を Store にして push する」と 1 行で訳せる           |
| boilerplate コスト                                                                  | △ 1 token (許容範囲)                                           |
| 実装コスト                                                                          | 軽 (= signalify を 1 関数 export、既存 push 型は変更なし)      |
| 拡張性                                                                              | ◎ 後で B (union) を加えるのも容易、A=D の auto-wrap も後付け可 |

A=D は user コード最短だが、ADR 0048 で「**plain snapshot か reactive primitive かを明示**」する identity を選んだ流れと一貫しない。「fw が裏で signalify する」magic は ADR 0048 の Soft supersede で残置した Proxy / transform 機構と異質で、新たな magic 帯を 1 つ持ち込む。

B (union) は **E の上位互換** だが現時点で「既存 Store を push 引数にしたい」ユースケースが無い (= YAGNI)。E を入れた後で痛みが出たら ADR amendment で union に拡張可能。

## Rationale

### 1. props snapshot / reactive primitive の identity 統一

ADR 0048 は「props は静かな snapshot、reactive にしたいなら primitive で declare」と決めた。`loaderData()` も props.data を削除して explicit primitive 経由に統一した (ADR 0049)。

push 引数は概念的には「これから store に入れる data の origin」 = FormData / 演算結果 等の **plain snapshot**。これを Store に昇格させる時に explicit primitive 経由で書くのが ADR 0048 / 0049 の流儀の自然な延長。`signalify()` は「`signal()` / `store()` / `loaderData()` 群」の write side counterpart。

### 2. legibility test 通過

```tsx
data.notes.push(signalify({ id: -1, title }));
```

→ 「**`{ id: -1, title }` を `signalify` で Store 化してから `data.notes` に push する**」と日本語で訳せる。token 1 つで「ここで境界を跨いでる」と読める = memory `project_legibility_test` 合格基準。

### 3. signal / store / loaderData / signalify の流儀統一

```ts
const count = signal(0); // primitive 値 → Signal
const local = store({ items: [] }); // plain object → 起点 Store
const data = loaderData<typeof loader>(); // server 戻り → Store
data.notes.push(signalify({ id: -1, title })); // plain → Store (一時昇格)
```

「**reactive 化したい時は名前を呼べ**」の流儀で全部揃う。grep で reactive boundary を発見でき、AI-native 規約 (= 設計書 5 哲学) との整合も良い。

### 4. `store()` と `signalify()` を別名にする理由

両者は **内部 implementation を共有** する (= deep に signal 化する処理は同じ helper)。違いは usage convention:

- `store(plain)` = **page-local state の起点宣言** (= signal / resource 群と並ぶ primitive declaration)、page Owner にぶら下がる lifecycle
- `signalify(plain)` = **既存 Store に append する一時 value の昇格** (= utility)、独立 lifecycle なし、親 Store に push されたら親の lifecycle に従う

意味が違うので別名 export が筋。実装は内部 `signalifyDeep` を共有。

### 5. A=D の magic を避ける理由

A=D の `push(item: E)` で fw が裏 signalify する案は、見た目は楽だが:

- push に渡したオブジェクトと実際に store に乗る要素が **別 instance** という invariant が runtime で隠れる
- destructure / 外部 ref で「push したオブジェクト」を持ち回した user が驚く
- AI 視点で「push の前後で identity が変わる」が grep / static analysis で見えない
- ADR 0048 で explicit-first を選んだ判断を弱める

E は 1 token のコスト負担で identity 関係を type 上 expressive にする (= `signalify(plain) → Store<E> → push → 配列要素 = Store<E>`)。

### 6. 楽観更新 reconcile は別 ADR scope

楽観 push (`id: -1`) と server からの本物 (`id: 3`) の id-keyed merge での flicker / 重複表示 は ADR 0049 の Consequences で言及済の宿題。本 ADR の scope 外 (= 楽観更新 declarative API γ の別 ADR で扱う)。本 ADR は **「plain → Store の昇格 API をどう公開するか」** に絞る。

## Consequences

### 公開 API (= `@vidro/core` から export)

```ts
export function signalify<T>(value: T): Store<T>;
```

- 入力: plain JSON-like value (`T`)
- 出力: `Store<T>` (= primitive 葉は `Signal<T>`、object / array は中間 proxy)
- 実装: `store()` factory が内部で使っている `signalifyDeep` helper を独立 helper として export
- 引数 `T` は `Store<T>` を含まない pure plain (= 既存 Store を渡されたら型エラー、これは B 拡張時に解禁)

### 既存 API への影響 (= 変更なし)

- `Store<T[]>` の write API (`push` / `splice` / `unshift` 等) の引数型は **`Store<E>` のまま据え置き**
- 既存 store の read 側も変更なし
- 既存 sample apps / template に修正不要 (= 楽観更新を書いていない箇所はそのまま)

### 実装ステップ

1. `@vidro/core` の store 内部 helper `signalifyDeep<T>(value: T): Store<T>` を抽出 (= 既存実装からの refactor)
2. 同 helper を `signalify` として export
3. `apps/router/src/routes/notes/index.tsx` に楽観更新 sample を追加 (= dogfood)、`signalify` を使う
4. unit test で `signalify(plain)` が `store(plain)` と同じ shape (= leaf signal + 中間 proxy) を返すことを確認
5. `apps/temp-router` (canonical SSR template) には楽観更新を入れる必要は今は無い (= dogfood は apps/router で十分)

### user が遭遇する場面

- 楽観更新 (`data.notes.push(signalify(plain))`)
- WebSocket / SSE push で受けた plain JSON を store に注入 (`store.items.push(signalify(json))`)
- server 戻りを cross-page で持ち回す → cross-page cache が必要なら memory `project_cache_as_fw_concern` の query pack 案件 (= 別 ADR)

## Revisit when

- 「**既存 Store を push 引数にしたい**」ユースケース (例: cross-page cache、splice で取り出した要素を別 store に re-push) が定常化 → B (union) に拡張、`push(item: E | Store<E>)`
- 「**signalify を毎回書くのが boilerplate**」として user の体感痛みが定常化 → A=D の auto-wrap を再検討、または `data.notes.pushPlain(plain)` 等の sugar API
- 楽観 → server reconcile の flicker / 重複が定常化 → ADR 0049 の γ (declarative 楽観更新 API) ADR で submission ↔ store の link primitive

## 関連

- ADR 0047 — store primitive (= 戻り型 `Store<T>`、path F)
- ADR 0048 — props snapshot 規則 (= 本 ADR の identity foundation)
- ADR 0049 — `loaderData()` primitive (= 痛みの起点)
- ADR 0040 — `submission.input` 楽観 preview (= 楽観更新の現状 primitive、本 ADR の signalify と組み合わせる場面)
- ADR 0051 起票候補 — `searchParam()` primitive (= 痛み A 解決)
- memory `feedback_props_unification_preference` — props snapshot / reactive 明示の identity
- memory `project_legibility_test`
- memory `project_design_north_star`
- memory `project_store_primitive_decided` — path F (= leaf signal + 中間 proxy)
- memory `project_loader_data_primitive` — ADR 0049 の素材
- memory `feedback_dx_first_design` — 実装より先に user code の見た目から逆引き
