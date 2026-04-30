# 0048 — Props は snapshot、reactive は明示 primitive で declare

## Status

**Accepted** — 2026-04-30 (38th session)

**Supersedes**: ADR 0007 (component props proxy reactive)

## Context

### ADR 0007 の現状 (= supersede 前)

ADR 0007 は「A 方式 JSX transform を component 境界まで貫通させる」目的で、user code から見て **props proxy で implicit reactive** を採用していた:

```tsx
// ADR 0007 のモデル
function Counter({ count }: { count: number }) {
  // props.count は実際は getter で、毎回読むと最新値
  return <p>{count}</p>;
}

<Counter count={signal.value} />;
// → transform で _reactive(() => signal.value) に書き換え
// → h() が Proxy で wrap、`count` access で関数を呼んで signal.value を track
```

実装の核 (`@vidro/core` + `@vidro/plugin`):

1. `_reactive<T>(fn: () => T): () => T` で marker 付きの関数を作る
2. vite plugin の transform で `{expr}` を `_reactive(() => expr)` に書き換え
3. `h()` が component の props を Proxy でラップ、marker 付き関数だけ unwrap
4. `Match` / `Show` / `For` が「effect 内で毎回 props を読む」形に refactor
5. user 制約: **"don't destructure props"** (= destructure すると reactivity 死亡)

### 37th session で出た不満 (= reframe trigger)

apps/router の `/notes` dogfood で:

1. **action 後 page remount で page-local state が全消失** (= count signal / filter / accordion / focus / scroll 全部 reset)
2. 解決策として「loader data を reactive 化する」path B (= ADR 0007 流の implicit reactive を loader data まで延長) が出た
3. user が「props は snapshot であるべき、reactive にしたいなら明示的に declare すべき」と判断
4. Solid の implicit reactive props は run-once の必然じゃなく **choice** (= Svelte 5 / Vue 3 / React は explicit 派) と確認、Vidro が explicit 派に move するのは legitimate

### 38th session で完成した primitive (= 規約の前提)

- ADR 0047 で `store` primitive 採用 (path F = leaf signal + 中間 proxy hybrid)
- `data.x.value` で signal triad と一貫する明示的 reactive 経路ができた
- `loaderData<typeof loader>()` の起票候補 (= ADR 0049) が立ち、戻り値は `Store<T>` で reactive

これにより **implicit reactive props は冗長**になった。user は store / loaderData() / signal 等の primitive を直接 component で declare すればよく、props 経由で reactive を渡す必要がない。

## Options

### (A) ADR 0007 を Hard supersede (= 即時撤廃)

- props は plain JS の値として渡る (= snapshot)
- `<Counter count={signal.value} />` は snapshot (= mount 時の値で固定)
- reactive を子に渡したいなら `<Counter count={signal} />` 等で Signal instance を渡し、子で `props.count.value` で読む
- ADR 0007 の `_reactive` / Proxy / transform を撤廃
- 既存 sample apps を新 rule で書き換え

**Pros**:

- mental model 1 つ ("`.value` が reactive 経由")
- legibility ◎ (memory `project_legibility_test`)
- destructure 罠が消える (= props は snapshot なので destructure 自由)
- bundle 軽量化 (= Proxy / transform 撤廃)

**Cons**:

- 既存コードの書き換え必要
- 実装変更が大きい (= transform / `h()` / `Match` / `Show` / `For` の refactor)

### (B) ADR 0007 を Soft supersede (= 規約だけ変えて implementation は残す)

- user-facing rule を「props は snapshot、reactive は explicit primitive」に変更
- 内部の Proxy / transform は backwards compat として残す (= 既存 user code は動く)
- 推奨 pattern を新規コードで shift、apps を順次書き換え

**Pros**:

- 段階的移行で risk 低い
- 既存 sample apps が即座に壊れない

**Cons**:

- 概念は変わったのに implementation は古いまま、不一致 (= memory `project_legibility_test` から見ると曖昧)
- bundle が太いまま、`don't destructure` 制約も残る

### (C) ADR 0007 をそのまま維持 (= reframe しない)

- 37th session の判断を覆す
- 個人開発の path として認められる選択ではある

**Cons**:

- ADR 0047 の path F (store) と mental model が二重 (= props は implicit reactive、store は explicit `.value`)
- memory `feedback_props_unification_preference` の Vidro identity reframe を捨てる

## Decision

**(B) Soft supersede** を採用する。

- user-facing **規約** (= 推奨される書き方) を新 rule に変更
- 内部の Proxy / transform / `_reactive` は **当面残す** (= backwards compat)
- 既存 sample apps を即座に書き換える必要なし
- 新規コード / 新規 sample apps は新 rule で書く
- 将来 (A) Hard supersede へ進む判断は別 ADR amendment で

これにより:

- ADR 0007 の implementation が当面動き続けるので app への影響ゼロ
- 「規約は新 rule、実装は旧 rule のまま暫く同居」状態を許容
- 移行 risk を払わず方向転換だけ宣言できる
- memory `project_pending_rewrites` に「Proxy props / `_reactive` transform は将来撤廃」を記録、dogfood で必要性が出たタイミングで Hard supersede 化

### 新 rule

| 軸                            | 規約                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| **props**                     | read-only snapshot (= 値を 1 度渡したらそれっきり、再 render しない限り変わらない)        |
| **page-local reactive state** | `signal()` / `store()` を component 関数内で declare                                      |
| **loader 戻り**               | `loaderData<typeof loader>()` で reactive 取得 (= ADR 0049 起票候補、戻り型 `Store<T>`)   |
| **URL / form 系 reactive**    | `currentParams` / `searchParam("q")` / `submission(key).input` 等の専用 primitive         |
| **親 → 子**                   | snapshot props (= 値を 1 度渡しておしまい)                                                |
| **子 → 親**                   | callback prop で操作伝達 (memory `feedback_callback_props_pattern`、ADR 0050 起票候補)    |
| **sibling 共有**              | 基本 lift up + callback、escape hatch として `Signal<T>` 型 prop も許容 (Stance 3 hybrid) |

### implicit reactive props は禁止

`<Counter count={signal.value} />` を書いた場合:

```tsx
// ADR 0007 (旧): implicit reactive、count は毎回 signal.value で track
// ADR 0048 (新): snapshot、count は mount 時の signal.value で固定

function Counter({ count }: { count: number }) {
  return <p>{count}</p>;
  // ↑ 新 rule では count は number、変わらない
}
```

reactive を子に渡したいなら **明示的に Signal を渡す**:

```tsx
<Counter count={signal} />;

function Counter({ count }: { count: Signal<number> }) {
  return <p>{count.value}</p>;
}
```

これは memory `feedback_callback_props_pattern` で示した「子は具体的な値か callback を受け取る、親が状態管理」哲学とも整合する (= sibling 共有の escape hatch、Stance 3 hybrid)。

## Rationale

### 1. signal triad / store との一貫性 (Vidro identity)

ADR 0047 で store primitive を path F (`.value` 蓋を末端) で採用した時点で、Vidro の reactive primitive triad は **「`.value` が末端の蓋」** という単一 mental model に揃った。

```ts
const count = signal(0);             count.value
const data = store({ x: 0 });        data.x.value
const total = computed(() => ...);   total.value
const note = loaderData(...);        note.x.value (= store)
```

ここに ADR 0007 の implicit reactive props を残すと、 **「props だけは透明な reactive」** という別 mental model が混在する。memory `project_legibility_test` (= 「読んで日本語に訳せる」) から見ると、`<Counter count={signal.value} />` を見て「これが reactive かどうかは Vidro の transform を理解してないと分からない」状態は legibility ✗。

新 rule では **`.value` 経由が reactive、それ以外は snapshot** が一貫する。

### 2. memory `project_legibility_test` と整合

「読んで日本語に訳せる」基準で:

- 旧 rule: `<Counter count={signal.value} />` → 「Counter に signal.value を渡す。けど内部で reactive に track される」 (= transform 知識前提)
- 新 rule: `<Counter count={signal.value} />` → 「Counter に signal.value (= 数値 snapshot) を渡す」 (= JS そのまま)
- 新 rule reactive: `<Counter count={signal} />` → 「Counter に signal を渡す。子は count.value で reactive に読む」 (= 一直線)

新 rule のが明示的。

### 3. destructure 罠の構造的解消

旧 rule: `const { count } = props` で reactivity が死ぬ (= getter が 1 回しか走らない、Solid と同じ罠)。

新 rule: props は snapshot なので destructure 自由。reactive 値 (Signal) を destructure しても Signal そのものが取れて reactive 維持 (= ADR 0047 path F の destructure 安全と同じ仕組み)。

```tsx
// 新 rule で安全
function Counter({ count }: { count: Signal<number> }) {
  const { value } = count; // value は number snapshot、これは reactive じゃないが見える
  // reactive 必要なら count.value を毎回読む
  return <p>{count.value}</p>;
}
```

### 4. memory `feedback_props_unification_preference` の reframe を ADR 化

37th session で:

- soft preference の escape clause (「強い理由あれば切替可」) を発動
- 「props proxy reactive (implicit)」を「props snapshot + explicit primitive」に reframe
- React の mental model + Solid の fine-grained 実装 + Vidro 独自の型貫通 という独自 niche を decided

これを ADR レベルで明文化することで、将来の判断 (= 「props を再度 reactive にしたくなった」) が **再評価のコスト** を払うことを保証する。

### 5. simpler than RSC (memory `project_design_north_star`) との整合

implicit reactive props は内部で transform + Proxy が必要、概念 +1。explicit primitive のみなら Vidro core を薄く保てる。memory `project_3tier_architecture` (= 薄い core) と整合。

## Consequences

### 撤廃候補の機構 (= ADR 0007 由来、Soft supersede では当面残置)

- `@vidro/core` の `_reactive<T>(fn): () => T` helper
- `h()` 内の props Proxy wrap ロジック
- `@vidro/plugin` の `{expr}` → `_reactive(() => expr)` transform + `_reactive` import auto inject
- `Match` / `Show` / `For` 内部の「effect 内で毎回 props を読む」refactor

→ Hard supersede に進む判断が出たら撤廃。memory `project_pending_rewrites` に追記。

### 既存コードの影響

- **apps/core (CSR sample)**: 現状の Counter / Todos / TodoItem は props を snapshot として扱える形なので影響軽微 (要確認)
- **apps/router (SSR sample)**: 同上、loaderData() に書き換える際は新 rule で書く
- **apps/temp / apps/temp-router (canonical templates)**: 触らない方針 (memory `project_app_scaffolding_strategy`)、ただし新 rule で動くか smoke check

### user code の書き方が変わる場面

| 旧 rule                                                | 新 rule                                                                                   |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `<Show when={signal.value}>`                           | 同じ (= signal.value で snapshot 渡し、Show 側が reactive に再計算する場合は内部実装変更) |
| `<Counter count={signal.value} />` (implicit reactive) | `<Counter count={signal} />` + 子で `count.value`                                         |
| `const { count } = props` (= 罠)                       | `const { count } = props` (= OK、snapshot として読める)                                   |

### Match / Show / For の内部実装

旧 rule では「props.when を effect 内で毎回読む」形だが、新 rule では:

- `<Show when={signal.value}>` の `when` は snapshot (= mount 時の値で固定)
- reactive な切り替えが欲しいなら `<Show when={signal}>` で Signal を渡し、Show 内部で `when.value` を effect で読む
- もしくは `<Show when={() => signal.value}>` で関数渡し、Show 内部で関数呼び出し

新 rule で primitives の API がどうなるか **decided** が必要。次セッション以降で touch up。

### bundle / perf

- Proxy hop が消える → component 境界の overhead 減
- transform が単純化 → vidro plugin が薄くなる

### 移行戦略 (= Soft supersede)

1. **本 ADR (0048) を Accepted** にして規約 fix (= 今日)
2. ADR 0007 の Status を `Superseded by ADR 0048` に update、内容は履歴として残す (= 今日)
3. memory `project_pending_rewrites` に「Proxy props / `_reactive` transform / Match-Show-For の props 受け方 refactor」を将来撤廃候補として追記 (= 今日)
4. 新規コード / 新規 sample apps は新 rule で書く (= 39th session 以降の ADR 0049 loaderData() 実装で実機確認)
5. 既存 sample apps の書き換えは **必要に応じて段階的** (= 急がない、dogfood で痛みが出た時に整理)
6. 「Hard supersede すべき」と感じる定常痛みが出たら別 ADR amendment で撤廃 commit を打つ

## Revisit when

- **新 rule で書きづらい場面が定常化**: 例えば「sibling 共有のために `Signal<T>` 型 prop が頻出」した時、escape hatch を default 化する判断を再評価
- **fine-grained component re-render の必要性が出た時**: 旧 rule の Proxy 経由 reactive が必要な場面 (= component 全体を再 render したくない、props の一部だけ subscribe したい)。現状は signal/store の primitive で代替可
- **JSX transform 抜きで動かしたい場面が出た時**: ADR 0007 の transform marker 機構を別の用途で復活させたいケース (= unlikely)

## 関連

- ADR 0007 — **本 ADR で superseded**
- ADR 0047 — store primitive、`.value` 蓋の signal triad 完成
- ADR 0049 起票候補 — `loaderData()` primitive、reactive な loader data 取得
- ADR 0050 起票候補 — callback props pattern (= 子 → 親 の規約)
- memory `feedback_props_unification_preference` — 本 ADR の素材
- memory `feedback_callback_props_pattern` — 子 → 親の規約
- memory `project_legibility_test` — 「読んで訳せる」基準
- memory `project_design_north_star` — RSC simpler 代替
- memory `feedback_dx_first_design` — user が書くコードの見た目から逆算
- 設計書 `~/brain/docs/エデン 設計書.md` (brain repo) の primitive section 整合
