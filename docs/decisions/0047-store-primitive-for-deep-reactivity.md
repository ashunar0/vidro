# 0047 — `store` primitive: leaf signal + 中間 proxy hybrid (path F)

## Status

**Accepted** — 2026-04-30 (38th session で Open → Accepted に格上げ + Decision 化)

提起: 2026-04-29 (36th session、ADR 起票 Open status)
再発火: 2026-04-30 (37th session、apps/router の dogfood で page state 消失痛み)
Decision: 2026-04-30 (38th session、path F = leaf signal + 中間 proxy hybrid)

## Context

### 起源 — fine-grained reactivity の grain が合わない問題 (36th session)

`signal<T[]>([])` で配列を扱うと field 更新時に item identity が変わり、For が
1 row remount する (全 row ではない)。視覚影響は無いが、本来 fine-grained
reactivity を売りにする FW なら **toggle で `<input>` の `checked` 属性 1 個**
だけが in-place 更新されて DOM node はそのまま、が理想形。

```ts
type Todo = { id: number; text: string; done: boolean };
const todos = signal<Todo[]>([]);

const handleToggle = (id: number) => {
  todos.value = todos.value.map((t) => (t.id === id ? { ...t, done: !t.done } : t));
};
```

`t.done` が plain boolean だから、Vidro が「変化を field 単位で観測する手段」を
提供できていない。

### 現状の primitive

| 道具       | 用途                                               |
| ---------- | -------------------------------------------------- |
| `signal`   | 値 1 個の reactive 箱 (≒ Solid の createSignal)    |
| `computed` | 派生 reactive (≒ Solid の createMemo)              |
| `effect`   | reactive 変化に反応する side effect                |
| `ref`      | DOM 要素を掴む箱、**reactive じゃない** (ADR 0003) |

→ object/配列の deep reactive は **未提供**。

### 37th session — 再発火

apps/router の `/notes` dogfood で同じ問題が別 angle から再発火:

1. **action 後 page remount で page-local state が全消失** (= filter signal /
   count signal / accordion / focus / scroll が全部 reset)
2. **path B 議論で `loaderData()` primitive が立ち上がる** (memory
   `project_loader_data_primitive`)
3. `loaderData()` の戻り値を **deep reactive store** にすると
   `data.notes.push(x)` で楽観更新 + page 維持が両立する
4. **store primitive は loaderData() の依存先として必須**

Open status の「再発火条件」のうち以下が満たされた:

- ✅ 別 sample app で同じ困りが再発 (= apps/core todo + apps/router page state、
  定常化サイン)
- ✅ user 自身が「store やっぱ要る」相当の発言 (= path B 議論で「store として
  渡す」を decided)

### 38th session — API 形式の議論

ADR 0007 (component props proxy reactive) を 37th session で **superseded** に
する流れと並行して、props は snapshot / reactive は明示 primitive で declare、
という Vidro identity が decided 済 (memory `feedback_props_unification_preference`)。
store はその primitive 群の 1 つとして位置付く。

API 形式を 6 path で比較した上で、**path F (leaf signal + 中間 proxy hybrid)** を
採用する流れに到達。詳細は Options / Decision で展開。

## Options

論点は「fine-grained を取りつつ、罠と verbose のどちらを払うか」のトレードオフ。
6 path が成立する。

### path C — deep mutate (Vue reactive 流)

```ts
const data = store({ notes: [{ id: 1, title: "a" }] });

data.notes.push({ id: 2, title: "b" }); // 配列操作、proxy hook
data.notes[0].title = "x"; // 直 mutate
const t = data.notes.find((t) => t.id === 1);
if (t) t.title = "renamed";
```

- **書き味**: ◎ (`data.notes.push(x)` がそのまま動く)
- **罠**: 多 (destructure / proxy chain 境界曖昧 / Date/Map 壊れる /
  ref equality / SSR serialization)

### path F — leaf signal + 中間 proxy hybrid (**採用**)

```ts
type Note = { id: number; title: string };
const data = store({ notes: [] as Note[] });
// data         → proxy
// data.notes   → proxy (Note[])
// data.notes[0] → proxy (Note)
// data.notes[0].title → Signal<string>  ← leaf

data.notes.push({ id: 1, title: "a" }); // 配列操作、proxy hook
data.notes[0].title.value = "x"; // leaf write、`.value` 経由
const t = data.notes.find((t) => t.id.value === 1);
if (t) t.title.value = "renamed";

// destructure 安全 ✨
const note = data.notes[0];
const { title } = note; // title は Signal<string>
title.value = "x"; // ← reactive 維持
```

- **書き味**: ◎ (push そのまま、leaf は `.value`)
- **罠**: 中 (中間 proxy 階層の罠は残る、Date/Map / 中間 destructure / batch /
  実装重さ)
- **destructure 罠が leaf で消える**: signal 取得経由なので reactive 維持
- **signal triad 一貫性**: ◎ (`.value` が末端の蓋として揃う)

### path B — produce/draft (immer 流)

```ts
const data = store({ notes: [] as Note[] });

// 読み: 透明 (raw に見える)
console.log(data.notes[0].title);

// 書き: update() 内 draft で普通の mutate
data.update((draft) => {
  draft.notes.push({ id: 1, title: "a" });
  draft.notes[0].title = "x";
});
// 自然に 1 transaction (= 複数 field 同時更新で batch 不要)
```

- **書き味**: ◯ (読みは軽い、書きは update wrap)
- **罠**: 少 (mode 切替で時間分離、罠半減)
- **mode 切替**: 「読み」と「書き」で世界が変わる、認知負荷あり
- **signal triad との不整合**: 別系譜 (immer 由来)

### path D — 全部 signal (verbose だが罠ゼロ)

```ts
type Note = {
  id: Signal<number>;
  title: Signal<string>;
};
const notesSignal = signal<Note[]>([]);

notesSignal.value = [...notesSignal.value, { id: signal(1), title: signal("a") }];
notesSignal.value[0].title.value = "x";
```

- **罠**: ゼロ (全部 signal、shallow)
- **verbose 度**: 高 (型定義 + signal wrap が露出)
- **配列追加と field 更新の書き味**: 大きく乖離

### path E — signal シャロー (= 現状維持、store 作らない)

```ts
const data = signal({ notes: [] as Note[] });
data.value = { ...data.value, notes: [...data.value.notes, x] };
```

- **fine-grained**: ✗ (object 全体が 1 subscription)
- **罠**: ゼロ
- **書き味**: spread 多用で辛い

### path A (Solid 流 path-based setter) は早期に却下

```ts
const [todos, setTodos] = store([]);
setTodos(
  (t) => t.id === id,
  "done",
  (d) => !d,
);
```

string literal の path 言語を覚える必要、loaderData 等との合成が悪い、Vidro が
ADR 0006 で factory 一本化と決めた方針との整合性も悪い。memory
`project_legibility_test` (読んで日本語に訳せる) からも遠い。

## Decision

**path F (leaf signal + 中間 proxy hybrid)** を採用する。

### 構造

- `store(initial)` で deep proxy を作成
- 中間階層 (object / array) は透明 proxy → access が `proxy.x` 形式で透過
- 末端 (primitive: number / string / boolean / null / undefined) は signal で
  自動 wrap → access は `proxy.x.y.value` (`.value` が leaf の蓋)

### API shape (実装時に詰める)

```ts
// factory
function store<T>(initial: T): Store<T>;

// 型 (概念):
type Store<T> = T extends Primitive
  ? Signal<T>
  : T extends Array<infer U>
    ? Array<Store<U>> // proxy で wrap、配列メソッドは透過
    : T extends object
      ? { [K in keyof T]: Store<T[K]> }
      : never;
```

実装で詰めるべき項目 (= 実装着手時に追加 ADR か commit message で記録):

- 配列メソッド (`push` / `splice` / `find` / `filter` / `map`) の戻り値が proxy
  chain を保つか
- 動的 field 追加 (`data.newField = "x"`) で leaf signal 化が走るか
- Date / Map / Set / class instance の扱い (= proxy 化を skip する `markRaw`
  相当の escape hatch)
- SSR で server raw → client store への hydrate 経路
- store と signal の比較 (`===`) / `JSON.stringify` 時の unwrap 規約

## Rationale

### 1. signal triad との一貫性 (Vidro identity)

memory `feedback_props_unification_preference` で decided した「props は snapshot、
reactive は明示 primitive で declare」という Vidro identity に対し、F は
**signal の延長として一貫した primitive** を提供する:

```ts
const count = signal(0);             count.value
const data = store({ x: 0 });        data.x.value
const total = computed(() => ...);   total.value
```

`.value` で raw を取り出すという mental model が **3 primitive 全てに通る**。
B (produce) や C (deep mutate) はこの一貫性を持たない。

### 2. legibility test と整合 (memory `project_legibility_test`)

「読んで日本語に訳せる」基準で見ると:

- F: `data.notes[0].title.value = "x"` → 「data の notes の 0 番目の title を x にする」
  → 一直線、`.value` は signal triad の規約として既知
- B: `data.update(d => { d.notes[0].title = "x" })` → 「data を更新する関数を
  呼び、その中の draft の notes の 0 番目の title を x にする」
  → 1 段間接、update / draft の概念を理解してる前提
- C: `data.notes[0].title = "x"` → 一見軽いが、proxy chain の境界が見えない
  ため「これが effect を発火するか」が文法から見えない

F は legibility ◎。

### 3. destructure 罠が leaf で消える

reactive primitive の最も多い罠は「destructure で reactivity 切れ」。F は leaf
を signal にすることで、user が destructure で primitive を取り出した瞬間に
**signal が手に入る** ため、reactivity が維持される。

```ts
const note = data.notes[0];
const { title } = note; // title は Signal<string>
title.value = "x"; // ← 動く、reactive 維持
```

これは C / B / D には無い構造的安全性。

### 4. memory sketch との完全整合

memory `project_loader_data_primitive` の sketch (`data.notes.push(x)`) は F で
完全に動く。loaderData() primitive (= ADR 0050 起票候補) との合成も自然。

### 5. Vue / Solid に無い独自路線

- Vue 3 reactive: 全部透明 proxy (= path C)
- Solid createStore: path-based setter (= path A) または getStores 経由
- Vidro F: 中間 proxy + leaf signal で `.value` 蓋を末端に

これは memory `project_design_north_star` (= 個人/hobby/cf 規模で simpler than
RSC) の独自路線として legitimate。Vue 流の便利さを取りつつ、signal triad の
明示性を leaf で保つ。

### 6. batch は store 特有じゃない、reactive 全般の問題 (38th 議論)

「1 write = 1 notify、複数書きで batch 必要」という現象は signal でも store でも
起きる。store は構造上 batch を使う頻度が高くなるだけ。これを path 比較から
**外し**、batch primitive 確定 (memory `project_pending_rewrites`) と並行して
詰める。

## Consequences

### 公開 API

- `store<T>(initial: T)` factory が `@vidro/core` から export される (概念 +1)
- 既存 `signal` / `computed` / `effect` / `ref` と並ぶ primitive
- 型 `Store<T>` は `export type` で提供 (memory `project_signal_api_decision` の
  factory 一本化方針と整合)

### user に課す mental model

1. **leaf == primitive ルール**: `data.x` が object/array なら proxy
   (`.value` 不要)、primitive なら signal (`.value` 必要)
2. **`.value` が末端の蓋**: signal triad と同じ規約
3. **中間階層の destructure は proxy chain を保つ限り OK** (= `const { notes } = data`
   は OK、`notes` は proxy で reactive)
4. **batch との組み合わせ**: 複数 field 同時更新は batch() で囲む

### 残る罠 (受け入れる代償)

| 罠                                | 影響                                                  | 対処                                                      |
| --------------------------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| 中間階層の primitive destructure  | `const { x } = obj` で signal が取れず stale          | 慣例として「leaf access は最後まで proxy 経由」を案内     |
| Date / Map / Set / class instance | proxy で wrap すると method が壊れる                  | `markRaw` 相当の escape hatch を設計                      |
| 配列メソッドの戻り                | 実装次第で proxy chain が切れうる                     | Vue 3 流に配列メソッドを wrap する                        |
| Reference equality                | proxy で wrap で `===` が崩れる                       | 受容 (= store 化したら identity は使わない、と案内)       |
| SSR serialization                 | proxy を `JSON.stringify` で raw に戻す必要           | `_unwrap` 内部 helper、ADR 0050 (loaderData) 整合と並行   |
| 実装重さ                          | leaf 自動 signal 化 + 中間 proxy 連鎖、bundle size 増 | `@vidro/core` のサイズ予算を超えそうなら別 package 化検討 |

### 影響を受けるドキュメント / コード

- ADR 0007 (component props proxy reactive) — 37th session で superseded 路線
  (= 別 ADR で明文化予定)、F の実装で props proxy の reactive 規約が消える方向
- 設計書 `~/brain/docs/エデン 設計書.md` の primitive section に store を追記
  (brain repo は別 commit)
- 将来の loaderData() primitive (ADR 0050 起票候補) の戻り型は `Store<T>` 想定
- todo demo (`apps/core` 系) が将来 store で書き直される (現状は signal シャロー
  のまま放置で OK、移行は後追い)

## Revisit when

以下のいずれかが起きたら設計判断を再評価する:

- **B (produce/draft) に振れたくなる signal**:
  - 複数 field 同時更新 (`data.x = 1; data.y = 2; data.z = 3`) が頻出して
    `batch()` が雑音化する
  - update() による「読みと書きの mode 分離」を user が「むしろ明示性として
    良い」と感じる場面が複数発生
- **leaf == primitive ルールの罠**:
  - user が `n.title.value` の `.value` 忘れを繰り返すパターンが定常化
  - leaf vs 中間の境界判定で型エラーが頻出
- **実装コスト超過**:
  - leaf 自動 signal 化の実装が proxy 連鎖と噛み合わない場面が複数出る
  - `@vidro/core` の bundle size が予算 (現状目安なし、将来定義) を超える
- **C (透明 proxy) に振れたくなる signal**:
  - leaf の `.value` が読み味で重く感じるシーンが頻出
  - Vue 3 経験者が乗り換える時に「`.value` 不要にしてほしい」を訴える

## Implementation roadmap (=次セッション以降の手順)

1. ADR 0047 確定 commit (= 本ファイル update + memory 更新)
2. ADR 0049 (props snapshot 規則明文化、ADR 0007 supersede) を起票
3. ADR 0050 (loaderData() primitive、戻り型 `Store<T>`) を起票
4. `@vidro/core` に `store` factory を追加 (= 実装着手)
5. apps/router の `/notes` を loaderData() + store で書き換え、痛み B 解消の
   実機証跡を取る

API shape の細部 (配列メソッド wrap / Date escape hatch / SSR serialize) は
実装着手時に追加 ADR か commit メッセージで記録する。

## 関連

- ADR 0006 (factory 一本化) — store も factory で `store(initial)` 形式
- ADR 0007 (props proxy reactive) — 37th session で superseded 路線
- 起票候補 ADR 0049 (props snapshot 規則明文化)
- 起票候補 ADR 0050 (loaderData() primitive)
- memory `project_loader_data_primitive` — 38th session 議論の起点
- memory `feedback_props_unification_preference` — Vidro identity の reframe
- memory `project_legibility_test` — 「読んで日本語に訳せる」基準
- memory `project_design_north_star` — RSC simpler 代替路線
- memory `project_3tier_architecture` — split-when-confused 原則
- memory `project_pending_rewrites` — batch primitive 確定との並行
- 設計書 `~/brain/docs/エデン 設計書.md` の primitive section (brain repo)
