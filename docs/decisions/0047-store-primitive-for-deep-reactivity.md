# 0047 — `store` primitive (deep reactive object/array container) の導入論点

## Status

**Open** — 2026-04-29 提起、未決。dogfood で再発火するまで保留。

## Context

36th session で apps/core に todo app (CSR) を実装し、`signal<Todo[]>([])` +
`map` で immutable 更新する流儀を試した。

```ts
type Todo = { id: number; text: string; done: boolean };
const todos = signal<Todo[]>([]);

const handleToggle = (id: number) => {
  todos.value = todos.value.map((t) => (t.id === id ? { ...t, done: !t.done } : t));
};
```

For は item identity-key reconciliation なので **toggle した row だけが unmount +
mount する** (全 row remount ではない)。視覚影響は無いが、本来 fine-grained
reactivity を売りにする FW なら **toggle で `<input>` の `checked` 属性 1 個**
だけが in-place 更新されて DOM node はそのまま、が理想形。

これが今できてないのは `t.done` が plain boolean だから。Vidro が「変化を field
単位で観測する手段」を提供できていない。

### 現状の primitive

| 道具       | 用途                                               |
| ---------- | -------------------------------------------------- |
| `signal`   | 値 1 個の reactive 箱 (≒ Solid の createSignal)    |
| `computed` | 派生 reactive (≒ Solid の createMemo)              |
| `effect`   | reactive 変化に反応する side effect                |
| `ref`      | DOM 要素を掴む箱、**reactive じゃない** (ADR 0003) |

→ object/配列の deep reactive は **未提供**。

### Solid との対比

Solid は同じ問題に **`createStore`** で対処:

```jsx
import { createStore } from "solid-js/store";
const [todos, setTodos] = createStore<Todo[]>([]);

setTodos((t) => t.id === id, "done", (d) => !d);
// または produce 経由:
setTodos(produce((todos) => {
  const t = todos.find((t) => t.id === id);
  if (t) t.done = !t.done;
}));
```

deep proxy で field 単位の subscription を track。`<input checked={todo.done}>`
は `todo.done` を読んだ effect として登録され、変化時に該当 effect だけ走る。

## Options

### 論点 1: そもそも追加するか

- **A. 追加する**: store primitive を新設して fine-grained 体験を user に提供
- **B. 追加しない (= signal を field ごとに書かせる)**:
  ```ts
  type Todo = { id: number; text: string; done: Signal<boolean> };
  ```
  YAGNI 哲学では成立。ただし verbose、配列の追加/削除と field 更新で書き方が
  乖離 (`signal<Todo[]>` の `.value =` と field の `.value =` が混在)
- **C. 追加しない (= 1 row remount を許容)**: 現状維持。性能困ってない以上 OK

### 論点 2: 名前 (A の場合)

- **A1. `store`** — Solid 由来、最も馴染み (推し、user 36th session で同意)
- **A2. `reactive`** — Vue 風。ただし signal も「reactive」なので名前で grain を
  伝えきれない
- **A3. `state`** — 一般的すぎて意味不明
- **A4. `box`** — 「中身が複雑なものを入れる箱」、シンプルだが Solid 経験者には
  伝わりにくい

### 論点 3: API 形式 (A の場合)

未決の小論点 (実装着手時に詰める):

- factory 形式 (`store([])`) のみか、class + factory か (`signal` と並列)
- 更新 API: Solid 流の path-based (`setStore("path", "to", value)`)、
  produce 流 (`store.update(s => s.x = y)`)、直接代入派 (`store[0].done = true`)
  のいずれか
- TypeScript 型推論をどう設計するか (path-based は type 厳しい)

## Decision

**未決 — 当面 (i)「論点として残す」**:

- 即時実装は **しない**
- `apps/core/` の todo app は `signal<Todo[]>` のままで放置 (1 row remount を許容)
- 次の dogfood (Phase 2 router、別 sample app 等) で **「やっぱ store 欲しい」と
  再発火するまで保留**

## Rationale

- **split-when-confused** (memory `project_3tier_architecture.md`): 困ってから
  境界見直す方針。1 回の dogfood では「常用するか」の確信が無い
- **YAGNI**: 論点 1 の C (追加しない) でも todo は完成する。性能要求が出てない
- **設計コストの大きさ**: deep proxy は Solid 経験者が踏んできた罠 (proxy 経由の
  identity equality / Date / Map の扱い / DevTools 表示 / serialization 境界) を
  一通り考慮する必要がある。30 分で書ける minimal proxy では罠の半分も拾えず、
  結局書き直しになる。**設計を詰める方が実装より先**

## Revisit when

- **Phase 2 router** で同じ問題が再発した時 (loader でサーバから取った object を
  toggle する等)
- **複数 dogfood で「store ほしい」が連続発火** した時 (= 困りが定常化したサイン)
- **fine-grained を体感させる demo が欲しい** とき (Vidro が React/Solid と何が違う
  かを external user に見せたい場面で、todo のような scenario が説得力を持つ)
- **Solid から乗り換えたい user の声** が出てきた時 (createStore 相当が無いと
  ergonomics が劣る)

## Consequences (if implemented later)

- 公開 API が 1 つ増える (概念 +1)
- localStorage / SSR serialization で proxy を unwrap する規約が必要
- For との相互作用 (proxy 配列を each に渡した時の identity 検出) の挙動を文書化
- @vidro/core の bundle size が deep proxy 実装分増える
- `signal` と `store` の使い分けガイドが必要 (= 何が grain の境界か)
