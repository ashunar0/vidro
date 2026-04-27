# ADR 0033 — SSR Phase C out-of-order full streaming

- Status: Accepted
- Date: 2026-04-27
- Phase: C-3 (resolve 順 boundary flush)

## 背景

ADR 0031 で shell + tail 形式の streaming SSR を導入した。shell 即時 flush で
TTFB / FCP は改善したが、boundary fill は **全 resource resolve 後に連続 enqueue**
する設計で、遅い resource 1 つで他の boundary も足止めされる。

本 ADR はこの「tail blocking」を外し、各 Suspense boundary が独立に resolve →
flush される out-of-order full streaming に拡張する。React 18 / Solid と同等の
streaming 体験。

## 採用方針 (要約)

- **per-boundary `ResourceScope`**: shell-pass で各 Suspense が children を評価
  する際、boundary 専用の `ResourceScope` を `runWithResourceScope` で立てる。
  内部 `resource` の fetcher は boundary scope に分離されて register される
- **boundary 並列 resolve**: 各 boundary について
  `Promise.allSettled(boundary.scope.fetchers)` を独立に起動。`then` の内部で
  boundary 単位の partial bootstrap patch + template + fill script を 1 chunk
  にまとめて `controller.enqueue` する
- **emit 順序保証**: `controller.enqueue` は sync。各 boundary の flush task は
  Promise の resolve 順に enqueue され、ReadableStream の単一 controller の上で
  自然に linear pipe になる
- **`__vidroSetResources` → `__vidroAddResources`**: 全部上書きから key 単位
  merge に変更。partial で複数回 patch されても累積。hydrate は全 chunk 受信後
  に 1 回 (現状維持) なので read-write race なし
- **内側 nested Suspense は boundary 化しない**: ADR 0031 論点 7 と整合。
  boundary-pass で streaming context は解除され、内側 Suspense は children 直吐き

## 論点と決定

### 論点 1: per-boundary scope vs flat collectScope

- 案 A: 現状維持 (1 個の collectScope) + 全 fetcher を 1 つの `Promise.allSettled`
  → 全完了後に boundary を順次 emit (= ADR 0031 動作)
- **案 B (採用): per-boundary scope** + 各 boundary を独立 `Promise.allSettled`
  → resolve 順に emit

採用理由: out-of-order の本質は「boundary を独立 unit として扱う」こと。
per-boundary scope を持たないと、どの fetcher がどの boundary に属するか
が辿れず resolve 順 dispatch ができない。

### 論点 2: 内側 nested Suspense を boundary 化するか

- 案 A: する (true full out-of-order、任意 nest level も独立 chunk)
- **案 B (採用): しない** (内側は外側 boundary の一部として束ね)

採用理由:

- ADR 0031 論点 7 で確立した「外側 boundary の中で内側 Suspense は children 直吐き」
  動作を維持。boundary-pass で streaming context が解除されるので、内側 Suspense
  の `getCurrentStream()` は null になる
- True full は実装が大きい (boundary-pass 自体を再 streaming で走らせる必要 +
  inner-boundary chunk の DOM 配置 mechanism + per-boundary scope の階層化)。toy
  として「peer-level boundary の並列化」だけ取れれば 80% の体感 win
- 将来 true full が要るなら、ADR 0033 の per-boundary scope 機構の上に nest
  hand-off を追加する形で増築可能

### 論点 3: emit 順序保証

各 flush task は `boundary.scope.fetchers` の `Promise.allSettled` を await して
chunk を組み立て、`controller.enqueue` を 1 回呼ぶ。enqueue は sync な操作なので、
**Promise の resolve 順 = enqueue 順 = stream chunk 順** となる。

ReadableStream の単一 controller が serialize 役。WhatWG spec の保証で十分
(複数 controller / tee 等は使わない)。

### 論点 4: bootstrap patch script の partial 化

- 案 A: 全 boundary 完了後に `__vidroSetResources(全部)` を 1 回 (現状)
- **案 B (採用): 各 boundary chunk と一緒に `__vidroAddResources(this keys)`**

採用理由:

- out-of-order では「flush 済み boundary の resource は client が引き当てたい
  かもしれない」が、現状 hydrate は全 chunk 受信後 1 回なので、実用差は今は薄い
- ただし将来の段階 hydration (= boundary fill ごとに該当部分 hydrate) の前提
  として、resources は per-boundary partial で出ている方が自然
- merge は `Object.assign` 1 行で済む。size 増加は無視できる範囲

`__vidroSetResources(全部上書き)` を残すと「上書き vs append」の二意味になり
混乱する。**`__vidroAddResources` に rename して 1 関数に統一**。toy 段階で
外部 user ゼロなので互換 alias は置かない。

### 論点 5: 空 fetcher の boundary

shell-pass で boundary 化されたが内部に `bootstrapKey` 付き resource が無い
ケース (= `boundary.scope.fetchers` が空)。`Promise.allSettled([])` は即 resolve
するので、即 emit される (shell とほぼ同時)。問題なし。

### 論点 6: error handling

- shell-pass throw → `controller.error(err)` (現状 / ADR 0031 同じ)
- boundary-pass throw → 該当 boundary の chunk を skip。`<!--vb-${id}-start-->` /
  `<!--vb-${id}-end-->` + fallback markup がそのまま残る。client が hydrate 後
  に refetch すれば回復可能 (現状 / ADR 0031 同じ)
- 「個別 boundary の error 通知」は将来案件 (ADR 0031 と同じ)

### 論点 7: per-request `currentParams` / `currentPathname` scope

`composeResponseStream` が stream 全期間で握る現状を維持。boundary 並列 flush は
全部 stream の `start(controller)` 内で起動するので、scope の有効範囲も同じ。
Workers race の AsyncLocalStorage 化は別案件 (project_pending_rewrites)。

### 論点 8: `Boundary` 型の API 形

```ts
export type Boundary = {
  id: string;
  scope: ResourceScope; // ← 追加
  childrenFactory: () => unknown;
};
```

`registerBoundary(id, scope, childrenFactory)` の 3 引数化。`StreamingContext`
側は `boundaries: Boundary[]` のまま (順序保持目的だが、out-of-order では順序は
emit 順と無関係になる、shell 内の出現順を残す目的だけ)。

### 論点 9: Suspense **外** で `bootstrapKey` 付き resource を使うケース

ADR 0030 の B-5c では shell-pass を 1 個の flat collectScope で wrap してた
ため、Suspense の内外を問わず全 fetcher が拾われた。ADR 0033 で per-boundary
scope に分離すると、**Suspense 外**で declare された resource はどの scope にも
入らず無視される。これは互換性 break。

選択肢:

- 案 A: dev warn 出して無視 ("Suspense 内で使え")
- **案 B (採用): root pseudo-boundary**

  shell-pass を `runWithResourceScope(rootScope, ...)` で全体 wrap し、Suspense
  外の resource は rootScope に register。Suspense 内では `runWithResourceScope`
  push/pop で boundaryScope に切り替わる (stack 構造)。boundary flush と並列に
  rootScope.fetchers も `Promise.allSettled` で resolve、`__vidroAddResources(...)`
  だけを 1 chunk emit (template / fill は無し、root は DOM 配置を持たないので)。

採用理由:

- ADR 0030 / 0031 との挙動互換 (Suspense 外 bootstrapKey resource もちゃんと
  resolve + bootstrap data injection)
- 実装コスト小: rootScope を 1 個立てるだけ、`flushRoot` という別 path を 1 つ追加
- Suspense 外で resource を使うのは、**hydrate 時に client が引き当てる用**として
  意味があるパターン (shell の loading 表示 → hydrate で resolved 値表示で blink
  消滅)

root scope は **空でも emit しない** (`__vidroAddResources({})` は意味がないので
省略)。boundaries 配列の各要素は `Promise.allSettled([])` でも emit する
(template / fill は DOM 操作として常に必要だから)。

## 実装ステップ

| Step      | 内容                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1         | `streaming-scope.ts`: `Boundary` に `scope: ResourceScope` 追加、`registerBoundary` を 3 引数に                                                                           |
| 2         | `suspense.ts` streaming branch: `runWithResourceScope(boundaryScope, ...)` で children を wrap、registerBoundary に scope を渡す                                          |
| 3         | `render-to-string.ts` `renderToReadableStream`: collectScope 廃止、boundary 並列 flush に書き換え、partial `__vidroAddResources` 化                                       |
| 4         | `VIDRO_STREAMING_RUNTIME`: `__vidroSetResources` → `__vidroAddResources` rename + Object.assign merge 化                                                                  |
| test      | `packages/core/tests/render-to-readable-stream-out-of-order.test.ts` 新規 — 遅い fetcher と速い fetcher の Suspense を 2 つ並べて、emit 順が「速い順」になることを assert |
| 既存 test | `render-to-readable-stream.test.ts` を新形式に追従 (関数名 + chunk 形)                                                                                                    |
| 実機      | router-demo に追加 boundary 2 つ (artificial delay 差) → wrangler + Playwright で「速い側が先に descend」目視確認                                                         |

## 影響範囲

- `@vidro/core`: `streaming-scope.ts` 型変更、`suspense.ts` streaming branch、
  `render-to-string.ts` の `renderToReadableStream` ほぼ書き換え、
  `VIDRO_STREAMING_RUNTIME` rename + impl
- `@vidro/router`: 変更なし (`composeResponseStream` 維持)
- `apps/router-demo`: 検証用に追加 Suspense を仕込む (実機検証のみ、本実装には不要)

## トレードオフ

- 採用案 (per-boundary scope + 並列 flush):
  - ✅ 速い boundary が先に descend → 体感の本領発揮
  - ✅ ADR 0031 で残した最適化候補 1 (out-of-order full) を回収
  - ❌ inner-nested Suspense は依然 sync (true full ではない)
  - ❌ 段階 hydration はまだ無し (chunk 全受信後 1 回 hydrate のまま)

- 不採用案 (true full + 段階 hydration まで一気に): 実装が 2-3x、toy fit せず

## 残課題 (project_pending_rewrites に追加)

- **段階 hydration**: boundary fill のたびに hydrate。HydrationRenderer の partial
  cursor 化 + Resource constructor の late-arriving bootstrap 対応
- **true full out-of-order**: 内側 nested Suspense も独立 chunk 化
- **shell-pass error degrade**: shell render を sync 段階で先行実行する 2 段階 API
