# 0066 — Async server component native (`async function Component()` + h() 戻り型 `Node | Promise<Node>` 拡張)

## Status

**Accepted** — 2026-05-07 (54th session、user 合意取得済 6 論点 + 5 主要論点)

依存: ADR 0064 (Resource 1-pass 統一、Phase 1-4 全着地済 = 4992f48 / 8b8f2eb / 9d297e5 / 35ad004)、**ADR 0065 (scope context cross-async migration、unctx 経由)**
関連: ADR 0029 (Suspense)、ADR 0030 (renderToStringAsync 2-pass 元、ADR 0064 で superseded)、ADR 0058 (`.server.tsx` semantics)、ADR 0060 (partial hydration、islands)、ADR 0063 (SSR throw shape)

## Context

### 痛みの起点 — `await db.findAll()` 直書きを許容したい

dogfood `apps/blog/src/routes/posts/index.server.tsx` の target syntax:

```tsx
// .server.tsx
export default async function PostsIndex() {
  const posts = await db.posts.findAll();
  return (
    <section>
      {posts.map((p) => (
        <li>
          <Link href={`/posts/${p.slug}`}>{p.title}</Link>
        </li>
      ))}
    </section>
  );
}
```

= server component を `async function` で書いて `await` を直書きする (RSC simpler 代替の核体験、memory `project_design_north_star`)。現状は `Resource` primitive 経由 (`resource(() => db.findAll(), { bootstrapKey: ... })`) で迂回しているが、**「読んで日本語に訳せるか」 (memory `project_legibility_test`) では `async function + await` の方が legible** = ADR 0064 の北極星「正しい使い方」のさらに直球版。

### 現状の挙動 (= silent no-op)

`packages/core/src/jsx.ts:50-51` で `h(Component, ...)` の component branch:

```ts
const result = owner.runCatching(() => type(propsProxy));
return result ?? r.createComment("vidro-error");
```

`type(propsProxy)` が `Promise<Node>` を返しても `runCatching` がそのまま戻すため、`result` が `Promise` object になり、`r.isNode(result)` false で `appendChild` の dispatch 経路で **silent に捨てられる**。markup には何も出ない。

### ADR 0064 で整った素地

ADR 0064 Phase 1-4 で:

- **renderToStringAsync** (古典 SSR) は 1-pass async tree walk + `await Promise.allSettled(scope.pending)` パターン
- **renderToReadableStream** (streaming SSR) は per-boundary owner で 1-pass 並列 walk
- **effect** は server mode でも subscribe する (= signal 書き込みで再 run する)
- **Resource** は server mode で fetcher 即 fire + `r.settled: Promise<void>`、scope.pending に register

これらの async tree walk 機構の上に **「component function の Promise も同じ pending pool に乗せる」** 設計を被せれば、async function component が自然に動く構造が組める。本 ADR は ADR 0064 の上に load する独立 ADR。

### Vidro 哲学整合 (memory cross-check)

| memory                               | 関係                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `project_design_north_star`          | RSC simpler 代替の核 = `await db.findAll()` 直書きが最終ゴール。本 ADR で達成                                 |
| `project_vidro_rsc_like_core_model`  | invoke-once 貫徹 = 各 component は 1 回しか評価しない。h() 内で fire + placeholder で整合                     |
| `project_html_first_wire`            | wire format 不変、HTML-first 維持                                                                             |
| `project_legibility_test`            | `async function + await` は読んで「DB 取得して描画」と日本語に訳せる、resource 経由より直球                   |
| `project_layer_separation_principle` | `.server.tsx` 内 `await db.x()` 直叩きは Vidro anti-pattern (= softening 49th)、ただし機構は許容、lint で誘導 |
| `feedback_dx_first_design`           | target syntax 起点で API 逆引き、本 ADR は dogfood で踏んだ痛みから起票                                       |
| `project_pending_rewrites`           | ADR 0060 dogfood で見つかった「async function Component 未対応」項目を本 ADR で解消                           |

## Options (= 5 論点、user 合意取得済)

### 論点 1: TS 型表現

#### (1-A) `h()` 戻り型を `Node | Promise<Node>` に拡張、`ComponentFn` も拡張 (= **採用**)

- `ComponentFn = (props) => Node | Promise<Node>` に変更
- `h()` の戻り型は **runtime では `Node` のまま** (= placeholder VNode を返して Promise 自体は scope に流す、TS 型レベルでは expand しても実用上問題なし)
- 任意の component が async になれる、Solid 流の simple モデル
- `.server.tsx` / `.tsx` の区別は **runtime guard** (= `renderer.isServer` 判定で client は throw) で表現、TS では分離しない (YAGNI)

#### (1-B) `ServerComponent<P>` 型を別途導入

- `.server.tsx` 限定の型を分離して async を許容、client component は sync only を型で強制
- `type-vertical-propagation` 整合だが、TS 型が増える + import 経路が複雑化、本 ADR では不採用

### 論点 2: server で async component が reject (= await throw) した時の経路

#### (2-A) ErrorBoundary chain で catch (= **採用**)

- `h()` の component branch で `runCatching` を使い、`type(propsProxy)` が Promise を返した場合は `.catch(err => owner.handleError(err))` で nearest ErrorBoundary に流す
- sync throw と同じ chain で扱う、ADR 0063 (SSR throw shape) と整合
- ErrorBoundary が server で fallback markup を出す経路に乗る (= 既存機構の再利用)

#### (2-B) Suspense が error 表示を持つ (Solid 流)

- Suspense が pending / resolved / rejected の 3 状態を持つ、ErrorBoundary とは別 layer
- 設計が複雑、Vidro は ADR 0029 で「Suspense は pending UI のみ、error は ErrorBoundary 担当」と分離済 → 本 ADR では不採用

### 論点 3: Suspense なしの async component の動作

#### (3-A) shell-pass 全部が await、古典 SSR 動作 (= **採用**)

- user が `<Suspense>` で囲まなければ古典 SSR 動作 (= 全 Promise を `await Promise.allSettled` してから flush)
- `<Suspense>` で囲めば streaming SSR 動作 (= per-boundary 並列 walk + out-of-order)
- ADR 0064 の意味論 (Decision section の表) と完全整合、下位互換性 + legibility 高い

#### (3-B) async component は default で boundary 化 (= 暗黙 Suspense)

- user が意識しなくても streaming、ただし fallback がないと markup スキームが崩れる、user が暗黙挙動を理解する必要 → 不採用

### 論点 4: async component の Promise を載せる scope

#### (4-A) 別 `AsyncScope` (or `ComponentScope`) を新規作成 (= **採用**)

- `ResourceScope` (bootstrapKey ベース named registry) と分離、`AsyncScope` は anonymous pending を扱う
- 責務が綺麗、`renderToStringAsync` / `flushBoundary` は両方を `Promise.allSettled` で待つ (= 1 行 merge)
- 将来 streaming SSR で boundary 単位で AsyncScope を持つ拡張も自然

#### (4-B) ResourceScope を拡張して anonymous pending も受ける

- Map 1 つで済む、実装量小だが scope 名と意味がズレる (= ResourceScope は bootstrapKey 主体) → 不採用

### 論点 5: VNode に async placeholder を表現する shape

#### (5-A) `VAsyncSlot` 新 kind を追加 (= **採用**)

- `type VAsyncSlot = { kind: "async-slot"; resolved: VNode | null }` (or `placeholder` slot)
- serialize 時に `resolved === null` を見れば未 resolve race を detect 可能 (= dev で throw、production で安全側 fallback)
- type system 上も明確、debug しやすい

#### (5-B) VFragment placeholder + in-place mutation

- ADR 0064 Phase 3 の `_emptyDynamicSlot` と同 idiom (= `slot.kind = "text"` で書き換え)
- 変更量小だが race detect が弱く、未 resolve のまま serialize されると silent に空文字を吐く

## Decision

5 論点すべて確定 (= 54th session、user 合意取得済):

- 論点 1: **(1-A) `h()` 戻り型 + ComponentFn を `Node | Promise<Node>` 拡張**、runtime guard で client 弾く
- 論点 2: **(2-A) ErrorBoundary chain で catch**、`owner.handleError` 経由 (ADR 0063 整合)
- 論点 3: **(3-A) Suspense なしは shell-pass 全 await (古典 SSR)、Suspense 有りは streaming**、ADR 0064 意味論と完全整合
- 論点 4: **(4-A) 別 `AsyncScope` 新規作成**、`ResourceScope` と責務分離
- 論点 5: **(5-A) `VAsyncSlot` 新 kind 追加**、未 resolve race detect 可能

### Open Questions の確定 (54th session、Q1-Q6 user 合意取得済)

draft 段階の Open Questions も全件 decide 済み:

- **Q1 (AsyncScope.pending shape)**: **`Promise<void>[]` 単純配列** ─ anonymous pending に key 不要、YAGNI 整合。dedup・cancel が必要になったら拡張する split-when-confused 方針
- **Q2 (client guard error message)**: **component name を含める形式** ─ `[vidro] async function component "Counter" is server-only (.server.tsx). Use resource() for client async data.` のように `type.name || "anonymous"` を埋め込んで debug coster 削減
- **Q3 (VAsyncSlot race fallback)**: **always throw** ─ dev/prod 区別なし。`slot.resolved === null` を serialize で踏むのは構造的に bug (= allSettled 後 serialize の流れで起きないはず)、fail fast で隠さない
- **Q4 (AsyncScope lifetime と Owner の関係)**: **flat module-level、Owner と紐付かない** ─ ResourceScope と同形、`runWithAsyncScope` push/pop で管理。shell-pass throw 時の disposed owner への handleError は silent (= render abort 中なので実害なし)
- **Q5 (partial hydration / scope across await)**: **scope context migration を ADR 0065 (= 別 ADR) に分離して前提条件として load** ─ unctx 経由で islandScope / resourceScope / suspenseScope / streamingScope を AsyncLocalStorage 化。本 ADR の前に ADR 0065 着地が必須
- **Q6 (ErrorBoundary + async reject)**: **`owner.handleError` chain 経由 + ErrorBoundary が VAsyncSlot を fallback markup に mutation** (Option β) ─ invoke-once 維持 (tree 1 回 build、slot mutation 1 回)、sync throw との対称性。具体 mutation API は実装で詰める

### Async tree walk の流れ (= 確定形)

#### 1-A: 古典 SSR (= renderToStringAsync、Suspense なし)

```
1. setup: 空 ResourceScope + 空 AsyncScope を立てる
2. 1-pass build:
   - h(Component, props) で component が Promise を返したら:
     a. server mode 確認 (client なら throw)
     b. VAsyncSlot { kind: "async-slot", resolved: null } を生成して return
     c. component の Promise を then(resolved =>  slot.resolved = resolved, err => owner.handleError(err))
        で wrap し、AsyncScope.pending に register
   - resolved value (= VNode tree) は slot.resolved に入る、serialize 時に展開
3. await Promise.allSettled([...resourceScope.pending.values(), ...asyncScope.pending.values()])
   - resource の signal も async component の slot.resolved も settle 完了
4. serialize: VNode 木を 1 回 serialize
   - VAsyncSlot に当たったら resolved を再帰 serialize
   - resolved === null なら dev で throw / production で空文字
```

#### 1-B: streaming SSR (= renderToReadableStream、Suspense あり)

```
1. shell-pass: 各 Suspense boundary で per-boundary AsyncScope を立てる
2. boundary 内 children を 1 回 evaluate
   - 内側 async component は h() 内で per-boundary AsyncScope.pending に register
   - VAsyncSlot を持った childrenNode を boundary registry に保存
3. flushBoundary: scope.pending (resource + async) 全部 allSettled
4. serialize(childrenNode) → 1 chunk emit (ADR 0064 Phase 4 と同形)
```

### nested async component

```tsx
async function Outer() {
  const data = await fetch1();
  return <Inner data={data} />;
}
async function Inner({ data }) {
  const more = await fetch2(data);
  return <p>{more}</p>;
}
```

= **直列 await**。Outer の Promise が settle するまで Inner は h() に届かない (= 自然な await chain)。並列性は user が `Promise.all` で書く必要 (= JS 標準の memory model に乗る、特殊 magic は導入しない)。

### Scope (= 本 ADR で扱う / 扱わない)

| 項目                                                           | 本 ADR で扱う?                                           |
| -------------------------------------------------------------- | -------------------------------------------------------- |
| `h()` 戻り型 + `ComponentFn` を `Node \| Promise<Node>` 拡張   | ✅                                                       |
| `AsyncScope` 新規作成 (anonymous pending registry)             | ✅                                                       |
| `VAsyncSlot` 新 kind 追加                                      | ✅                                                       |
| `renderToStringAsync` / `flushBoundary` の allSettled 統合     | ✅                                                       |
| client mode で async component → runtime throw                 | ✅                                                       |
| `owner.handleError` 経由 ErrorBoundary 連携 (reject 経路)      | ✅                                                       |
| dogfood: `apps/blog` で `await db.findAll()` 直書き            | ✅ (実装後の最終確認)                                    |
| `.server.tsx` / `.tsx` の **transform-time** 制限 (lint level) | ❌ (runtime guard で十分、別 ADR で扱う)                 |
| client async component native サポート                         | ❌ (ADR 0064 Q1 で決定済 = client async は不要)          |
| Suspense pending UI を server で出す                           | ❌ (ADR 0064 Decision 論点 5 で確定済 = client only)     |
| async component 内 effect / signal の wiring                   | ❌ (`.server.tsx` 内 reactive primitive 禁止 = ADR 0058) |

## Open Questions (= 実装着地時に詰める detail)

> 注: draft 段階の論点 Q1-Q6 は全件 Decision section に統合済 (= 確定形)。本 section は実装着地時に手を動かしながら詰める **コード詳細レベル** の論点のみ。

1. **ErrorBoundary が VAsyncSlot を fallback に差し替える具体機構** (Q6 の実装 detail)
   - 候補 a: ErrorBoundary が children build 時に subtree を walk して VAsyncSlot list を集める、reject 時に slot.resolved を fallback markup に書き換える
   - 候補 b: VAsyncSlot に「nearest ErrorBoundary」参照を closure で持たせ、reject 時に slot 自身が boundary に通知 → boundary が手元の slot を mutation
   - 候補 c: ADR 0063 の discriminator marker idiom を再利用、boundary の fallback subtree 構築 + bootstrap data Error serialize
   - 実装着地時に code-explorer agent で既存 ErrorBoundary 内部構造を再確認、最 simple な path を選ぶ

2. **`type.name` が anonymous の場合の error message**
   - 方針: `type.name || "anonymous"` で fallback、`anonymous` 表示は debug 困難 → user に named function 推奨を README で促す
   - 実装で `type.displayName` (React 由来 convention) も見るかは判断保留、初期は `type.name` のみ

3. **既存 test の書き換え範囲確認**
   - sync component の `h()` 経路は変更なし → 既存 test 全 pass 想定
   - 影響テスト: `tests/jsx.test.ts` の `h()` テスト群、`tests/render-to-string-async.test.ts` の async 経路、`tests/render-to-readable-stream.test.ts` の boundary
   - 念のため初回 run で網羅、grep で fail 件数チェック

4. **VAsyncSlot serialize の dev throw が test を壊さないか**
   - dev 環境 = test 環境 = throw する
   - もし test 内で意図的に未 resolve のまま serialize する path があったら、test 側を直す
   - 通常 test 内では `await renderToStringAsync(...)` で正常 path しか踏まないはず

5. **`.server.tsx` でも `.tsx` でもない `.ts` ファイル内の async function component**
   - 例: `packages/router/src/...` 内 helper component が async になるケース
   - 方針: 拡張子による区別なし、runtime guard (`renderer.isServer`) のみで判定
   - 仕組み的には `.server.tsx` 限定の概念ではないが、user 向けには「async server component は `.server.tsx` 内」のメンタルモデルを推奨

6. **partial hydration (ADR 0060) との接続確認**
   - ADR 0065 で islandScope が async-safe になっているので、async component が return した subtree に islands が含まれても正常動作するはず
   - dogfood Phase 6 で apps/blog に islands を含む async component を試して確認 (= Q5 で deferred の検証)

## Consequences

### Pros

- **target syntax (`async function + await`) が直書き可能** → memory `project_design_north_star` の最終目標達成、RSC simpler 代替の核体験完成
- **ADR 0064 の async tree walk 機構を流用** → 新規追加は AsyncScope + VAsyncSlot + h() 分岐のみ、最小コード追加で着地
- **invoke-once 貫徹** → component 1 回評価、Promise も 1 回 fire、副作用 1 回 (memory `project_vidro_rsc_like_core_model` 整合)
- **Suspense との関係も自然** → ADR 0064 の意味論 (古典 SSR vs streaming SSR) がそのまま async component にも適用、user 学習コストゼロ
- **ErrorBoundary 連携も自然** → ADR 0063 sync throw 経路と同じ chain、別 layer 設計不要
- **memo `project_pending_rewrites` の D 案件解消** → ADR 0060 dogfood で出た「async function Component 未対応」を埋める

### Cons / 残るリスク

- **client mode runtime guard だけで `.server.tsx` 限定を保つ** → user が `.tsx` で async component を書いて build 時に検出されない懸念。lint rule (= 別 ADR) で機構誘導すべき
- **VAsyncSlot 未 resolve race は always throw** (Q3 確定) → prod でも throw、page 落ちる代わりに bug を隠さない fail-fast。ただし race が起きるのは構造的 bug のみのはずで、実害シナリオは想定なし
- **nested async component の直列 await コスト** → user が `Promise.all` で並列化する責務、性能調整は user の手動 work
- **renderToStringAsync の allSettled に AsyncScope.pending を merge する追加コスト** → ResourceScope only の既存 SSR 経路にも 1 行 merge が走る (overhead は無視できるレベル、空配列 merge)
- **ADR 0065 (unctx scope migration) が前提条件** → 本 ADR 単独では着手不可、必ず 0065 → 0066 の順

### 既存 ADR との関係

- **ADR 0029 (Suspense)**: 影響なし、Suspense 内側で async component が使えるだけ (boundary 単位 await に乗る)
- **ADR 0030 (renderToStringAsync 2-pass)**: ADR 0064 で superseded 済、本 ADR は ADR 0064 の上に load
- **ADR 0058 (`.server.tsx` semantics)**: 影響なし、`.server.tsx` 内 reactive primitive 禁止は維持。async function は新たに許容追加
- **ADR 0060 (partial hydration)**: 影響軽微、async component が return した subtree に island がある場合の cursor 整合確認 (Q5)
- **ADR 0063 (SSR throw shape)**: async reject 経路が ADR 0063 の sync throw 機構と同じ chain で動くか実装で確認 (Q6)
- **ADR 0064 (Resource 1-pass 統一)**: 直接の前提、本 ADR は ADR 0064 の async tree walk 機構の上に load

## Affected files (実装着地時)

- `packages/core/src/jsx.ts`: `h()` の component branch で Promise 判定 + runtime guard + VAsyncSlot 生成、`ComponentFn` 型拡張
- `packages/core/src/async-scope.ts`: **新規作成**、`AsyncScope` class + `runWithAsyncScope` / `getCurrentAsyncScope`
- `packages/core/src/server-renderer.ts`: VNode union に `VAsyncSlot` 追加、serialize 分岐追加
- `packages/core/src/render-to-string.ts`: `renderToStringAsync` で AsyncScope 立ち上げ + allSettled に merge、`flushBoundary` も同様
- `packages/core/src/suspense.ts`: server streaming branch で per-boundary AsyncScope を立てる + registerBoundary に渡す
- `packages/core/src/streaming-scope.ts`: `Boundary` 型に `asyncScope: AsyncScope` 追加 (or ResourceScope と同形 field)
- `packages/core/src/index.ts`: AsyncScope の type 公開可否 (= internal で十分 = export しない見込み)
- `packages/core/tests/render-to-string-async.test.ts`: async component の sync/error/nested ケース追加
- `packages/core/tests/render-to-readable-stream.test.ts`: Suspense 内 async component の boundary chunk 動作確認
- `apps/blog/src/data/posts.ts`: dogfood、Promise 化
- `apps/blog/src/routes/posts/index.server.tsx`: `await db.posts.findAll()` 直書き

## Validation (= Accepted 化までに実施)

- 既存 ADR (0001-0064) との矛盾なし check (上記表で実施済)
- 既存 memory との整合 check (上記 cross-check 表で実施済)
- `feature-dev:code-explorer` agent 報告で touchpoints 確認済 (= silent no-op の現状 + 流用可能 idiom + 新規必要部分)
- user 合意取得 (5 論点 = 型 / reject / Suspense / scope / VNode shape)、最終 review 待ち
- `feature-dev:code-reviewer` agent review (memory `feedback_review_in_workflow` per、Accepted 化前 or 実装 commit 直前)

## Next steps (= Accepted 化後)

### 段階的 commit 推奨順序

1. **Phase 1**: AsyncScope 新規 + 既存 SSR 経路に空 scope を merge (= no-op 等価、infra のみ)
2. **Phase 2**: `h()` の component branch で Promise 判定 + AsyncScope.registerPending + VAsyncSlot 生成 + client guard
3. **Phase 3**: server-renderer の VAsyncSlot serialize 分岐 + race fallback (dev throw / production warn)
4. **Phase 4**: streaming SSR boundary に AsyncScope 統合 (per-boundary)
5. **Phase 5**: dogfood = `apps/blog` の posts.ts Promise 化 + `.server.tsx` で `await db.findAll()` 直書き、動作確認

各 Phase で既存 test pass 確認 + 新規 test 追加 (async component の sync/error/nested、Suspense との組合せ)。
