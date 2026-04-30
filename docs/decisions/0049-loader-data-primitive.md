# 0049 — `loaderData()` primitive: loader 戻りを reactive store として取得

## Status

**Accepted** — 2026-04-30 (38th session)

依存: ADR 0047 (store primitive) / ADR 0048 (props snapshot 規則)

## Context

### 痛み B (= 37th session 起源)

apps/router の `/notes` dogfood で:

1. action 後 `PageProps<typeof loader>` 経由で渡る `data` が plain object
2. loader 再実行 → page **まるごと remount** → page-local state (count signal /
   filter signal / accordion / focus / scroll) が **全部 reset**
3. user 視点: 「form submit したら filter input が空になる、count が 0 に戻る、
   開いてた accordion が閉じる」 = 痛み B

**根本原因**: `data` が plain なので update 経路が「page を remount して新 data
を渡す」しかない。reactive primitive が無いため fine-grained update できない。

### 38th session で完成した primitive

- ADR 0047: `store` primitive (path F = leaf signal + 中間 proxy hybrid)
- ADR 0048: props は snapshot、reactive は明示 primitive で declare

これにより loader 戻りを **専用 primitive で reactive 取得** する設計が成立する:

```tsx
// 提案する API
function NotesPage({ params }: PageProps<typeof loader>) {
  // params は snapshot props
  // loader 戻りは loaderData() で reactive 取得
  const data = loaderData<typeof loader>();
  // data: Store<{ notes: Note[] }>

  // page-local state は維持される (= page remount しない)
  const filter = signal("");
  const count = signal(0);

  return <For each={data.notes}>{(n) => <li>{`#${n.id.value}: ${n.title.value}`}</li>}</For>;
}
```

memory `project_loader_data_primitive` で議論した到達点。

## Options (主要 decision points)

### 論点 1: revalidate 戦略 (= action 後 loader 再実行時、新 data をどう store に反映するか)

- **(i) 全置換**: store instance を新 data で作り直して replace
  - Pros: 単純、merge 戦略不要
  - Cons: **store identity が壊れる** → 既存 effect が detach、destructure した signal が孤立
- **(ii) field diff merge**: store instance は永続、内部 field を loader 再実行値で診断更新
  - Pros: identity 保持、effect 再実行が自然、destructure した signal が生き続ける
  - Cons: diff 戦略が要る (= 配列で id 一致を見て update / push / remove)
- **(iii) lifecycle 連動**: submission と link して transaction 化、楽観更新 → server 戻りで commit / rollback
  - Pros: 強力、楽観更新自動化
  - Cons: 実装重い (= submission ↔ store の link primitive 要る)、Remix 級

### 論点 2: `PageProps<typeof loader>` の `data` field との関係

- **(a) 削除**: PageProps.data を消し、loaderData() のみが loader 戻り取得経路
  - Pros: clean、API 1 本化
  - Cons: 既存 sample apps 全部書き換え、breaking
- **(b) 共存**: PageProps.data を残置 (= snapshot 用)、loaderData() を新規追加 (= reactive 用)
  - Pros: 既存コード壊れない、user が用途で選べる
  - Cons: 経路 2 本で混乱、推奨が曖昧
- **(c) deprecate (warn)**: PageProps.data を残しつつ Vidro plugin で warn 出力
  - Pros: 移行 path 明示
  - Cons: warn ノイズ

### 論点 3: 楽観更新 API

- **β: 手書き** (= form submit ハンドラで `data.notes.push(x)` を直接書く)
  - Pros: 概念追加なし、memory `project_loader_data_primitive` sketch がそのまま
  - Cons: 楽観 → server 戻り反映の boilerplate を user が書く
- **γ: declarative** (= `submission()` に optimistic/apply 関数を渡す)
  - Pros: 宣言的、典型 pattern を Vidro が面倒見る
  - Cons: 実装重い、API 表面 +2

### 論点 4: shared instance (= 同 page 内で複数回呼んだ時)

- **(α) 同じ instance**: `loaderData()` を `<Foo>` と `<Bar>` で別々に呼んでも同じ store を返す
- **(β) component 毎に独立**: 呼び出し毎に新 store

### 論点 5: SSR 整合

- server で loader を実行 → 戻り値 raw を bootstrapData に inject
- client で `loaderData()` 初回呼び出し時、bootstrapData から raw を読んで store 化
- 以降 client navigate / action 後 revalidate は client 側で raw → store update

## Decision

| #   | 論点                    | 採用                      | 理由                                                                                                                               |
| --- | ----------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | revalidate 戦略         | **(ii) field diff merge** | store identity 保持が effect / destructure 安全性に必須。memory `project_loader_data_primitive` sketch も id 一致 merge を暗黙想定 |
| 2   | PageProps.data との関係 | **(a) 削除**              | loader 戻りの取得経路を loaderData() に一本化、API の二重化を避ける。既存 sample apps は loaderData() に migration                 |
| 3   | 楽観更新 API            | **β: 手書き**             | memory sketch がそのまま動く。γ は別 ADR で needs assessment                                                                       |
| 4   | shared instance         | **(α) 同じ instance**     | 複数 component で読む時に identity 一致 (= 比較 / props 渡しが直感的)                                                              |
| 5   | SSR 整合                | **bootstrapData 経由**    | ADR 0015 (Phase A) と同じ pipeline、追加 wire format なし                                                                          |

### API shape (実装時に詰める)

```ts
// @vidro/router
export function loaderData<L extends AnyLoader>(): Store<Awaited<ReturnType<L>>>;

// PageProps は params 型のみ提供 (= data field は削除済)
export type PageProps<L extends AnyLoader> = { params: ParamsOf<L> };

// 使い方
import { loaderData, type PageProps } from "@vidro/router";
import type { loader } from "./server";

export default function NotesPage({ params }: PageProps<typeof loader>) {
  // 同 page で複数呼んでも同じ instance
  const data = loaderData<typeof loader>();
  const filter = signal("");

  // page-local state (= 維持)
  const count = signal(0);

  // 楽観更新 (= β、手書き)
  function addOptimistic(title: string) {
    // 一時 id は crypto-grade randomness で衝突回避 (Date.now() は連打で衝突)。
    // 文字列 id なら crypto.randomUUID()、数値 id 系なら crypto.getRandomValues()
    // 経由で生成するのが筋
    data.notes.push({ id: crypto.randomUUID(), title });
  }

  return <For each={data.notes}>{(n) => <li>{`#${n.id.value}: ${n.title.value}`}</li>}</For>;
}
```

### diff merge アルゴリズム (= 論点 1 (ii) の implementation note)

action 後の loader 再実行で新 raw (= server から戻ってきた loader 結果) を current store に当てる時:

1. **primitive field**: `Signal.value =` で更新 (= 既存 leaf signal を再利用)
2. **object field**: 再帰的に diff merge
3. **array field**:
   - **id-keyed reconcile**: 各 element に `id` field があれば、id 一致で要素 update / 新 id は append / 消えた id は remove
   - **id 無し**: index ベースで上書き (= length 変化で append / truncate、各 index は object field と同じ再帰 merge)
4. **新規 field 追加**: store proxy の `set` 経由で wrap して追加
5. **field 削除**: store proxy の `delete` 経由

`id` field の名前は **convention** で固定 (= まずは `id` 決め打ち、必要に応じて custom key を別 ADR で)。

## Rationale

### 1. 痛み B の構造的解消

`data` が reactive store なら page-local state を component 関数内で
declare しても **page は remount しない** (= router が同 page 上で diff merge
するだけ)。filter / count / accordion / focus が action 後も維持される。

### 2. memory `project_loader_data_primitive` を ADR 化

37th session の Path B 議論到達点を Decision として明文化。Vidro identity
(memory `feedback_props_unification_preference`) と整合:

- props は snapshot → `params` だけが props 経由
- loader 戻りは reactive → `loaderData<typeof loader>()` で取る
- page-local state は signal で declare

### 3. signal triad 一貫性 (memory `project_legibility_test`)

`loaderData()` の戻りが `Store<T>` で、ADR 0047 と同じ `.value` 蓋規約。
`data.notes[0].title.value` と `count.value` が同じ mental model で読める。

### 4. memory `project_design_north_star` (= simpler than RSC) との整合

RSC は server component / client component 境界で「どこで data fetch するか」
を user が判断する必要があり、また data の reactive 化を user が手で組む
(= useSWR / useQuery 等の third-party hook)。

Vidro は `loaderData()` 1 個で:

- server で loader 実行 (型貫通)
- client で reactive store 化
- action 後 revalidate (= store mutate、page remount せず)
- 楽観更新は store の直 mutate

を 1 経路で提供できる。RSC + useQuery + useOptimistic の三位一体に対して
**single primitive**。

### 5. PageProps.data 削除 (= 一本化)

ADR 0048 は Soft supersede で広範囲の Proxy / transform 機構を残置したが、
`PageProps.data` は **single field の削除** で surface area が限定的。

- 経路 2 本 (= `props.data` と `loaderData()`) を残すと user が「どっち使えば？」で
  迷う、memory `project_legibility_test` から見ると曖昧
- 一本化することで `params` (snapshot props) と `loaderData()` (reactive store)
  の役割分担が明確 (= memory `feedback_props_unification_preference` の規約と整合)
- 既存 sample apps の migration は loaderData() 実装と同 commit / 続 commit で
  完了する規模 (= 数 file の置き換え)

ADR 0048 (Soft) と 0049 (Hard for this aspect) の差は **影響範囲のサイズ** に
よる pragmatic な選択であり、Vidro identity の reframe を一貫して進める方針には
変わりない。

### 6. id-keyed reconcile は最小スコープから

論点 1 (ii) の diff merge で「`id` 決め打ち」は YAGNI ベース。custom key /
nested id / non-array structure は dogfood で必要性が出た時に別 ADR amendment。

### 7. shared instance (α) は identity 一致が直感

同 page 内で `<Foo>` と `<Bar>` が別々に `loaderData()` を呼んでも同じ instance
が返る = `<Foo>` で push した結果が `<Bar>` で見える。複数 instance 派は
「component ごとに独立した snapshot が欲しい」case だが、それは props 経由で
渡すべきで loaderData() の責務じゃない。

## Consequences

### 公開 API (= @vidro/router から export)

```ts
export function loaderData<L extends AnyLoader>(): Store<Awaited<ReturnType<L>>>;
```

`Store<T>` 型は `@vidro/core` から再 export か、`Store` を直接 import するか
は実装時 (= 既存 export pattern と整合させる)。

### 既存 API への影響 (= breaking)

- `PageProps<typeof loader>` の `data` field は **削除**
- `@vidro/router` の type `PageProps` は `{ params: ParamsOf<L> }` のみ
- 既存 sample apps (apps/router の users / users/[id] / notes) は **書き換え必要**
  (= `data` を `loaderData<typeof loader>()` で取得 + leaf access に `.value` 追加)
- migration は loaderData() 実装と同 commit か 続 commit で完了させる
- `apps/temp-router` (canonical template) も新 rule で update する

### 内部実装 (= 39th session 以降の commit で進める)

1. `@vidro/router` に `loaderData` factory を追加
2. server (= `routes` / `gatherRouteData`) で loader を実行 → 戻り raw を
   bootstrapData に inject (= 既存 pipeline 流用、ADR 0015 / 0017 に準拠)
3. client で `loaderData()` 初回呼び出し時、bootstrapData の raw を `store()`
   で wrap、shared instance として保持
4. action 後 loader 再実行 (= 既存 revalidate pipeline、ADR 0037) で新 raw を
   取得 → diff merge を current store に適用
5. navigate (= 別 page へ) で前 page の loaderData() instance は dispose
   (= 該当 page の Owner cleanup chain で)
6. `PageProps<L>` の type を `{ params: ParamsOf<L> }` に narrow、`data` field
   を削除
7. apps/router の users / users/[id] / notes / apps/temp-router を書き換え
   (= migration commit)

### diff merge の罠 (= dogfood で見えてきたら ADR amendment)

- **配列の `id` 衝突**: 楽観更新で `id: -Date.now()` を push、server が `id: 42`
  を返す → diff merge で別エントリ扱い、楽観 row が残る + real row が追加 (= 重複表示)
  - 暫定対処: user が submit 完了後に手で楽観 row を remove するか、submission.value
    を見て swap
  - 本格対処: γ (declarative 楽観更新 API) で submission lifecycle と連動 (= 別 ADR)
- **id 無しの object 配列**: index ベース merge は元 array の identity を変える
  ので、user が想定外の swap を見ることがある。dogfood で痛みが出たら custom
  key API を導入

### Effect / Owner の lifecycle

- `loaderData()` instance は **page Owner に紐付け** (= ErrorBoundary 等と
  同じ pattern)、page 離脱で dispose
- shared instance を保持する registry は page スコープ (= module scope global は
  避ける)

## Revisit when

- **diff merge の id 衝突 / 楽観更新の boilerplate** が定常化 → γ (declarative
  楽観更新 API) を別 ADR で
- **id 無しの object 配列の reconcile**が破綻 → custom key API
- **PageProps.data 経由が完全に不要**になった → Hard deprecate ADR
- **複数 instance ニーズ**が出た → shared instance (α) を default に維持しつつ
  opt-out オプション (例: `loaderData({ scope: "fresh" })`)
- **多 page 跨ぎでの同 loader 共有**が欲しくなった → cross-page cache が必要、
  memory `project_cache_as_fw_concern` の @vidro/query 案件として再評価

## 関連

- ADR 0015 — SSR Phase A bootstrap data (= server raw を client に流す pipeline)
- ADR 0037 — action primitive R-min (= action 後 loader revalidate pipeline)
- ADR 0040 — `submission.input` (= 楽観 preview の現状 primitive、β 楽観更新と組み合わせる)
- ADR 0047 — store primitive (= 戻り型 `Store<T>`)
- ADR 0048 — props snapshot 規則 (= PageProps.data 共存路線の整合)
- ADR 0050 起票候補 — callback props pattern
- ADR 0051 起票候補 — `searchParam()` primitive (= 痛み A 解決)
- memory `project_loader_data_primitive` — 本 ADR の素材
- memory `project_action_phase3` — submission registry / per-key 設計
- memory `project_legibility_test`
- memory `project_design_north_star`
- memory `project_html_first_wire` — wire format との関係
