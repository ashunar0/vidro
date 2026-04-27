# 0030 — SSR Phase B Step B-5c: Resource SSR resolve + bootstrap cache 命中 (blink 解消)

## Status

Accepted — 2026-04-27

## Context

ADR 0028 (B-5a) で `createResource` を client only で実装、ADR 0029 (B-5b) で
`Suspense` primitive を追加したが、**SSR 経路の resource は server で resolve
されない** ため次の問題が残っていた:

1. server で `<Suspense>` の children を render する時、resource は
   `loading=true` のまま markup に焼かれる (ADR 0029 論点 6 = 6-a スコープ外)
2. client が hydrate すると Suspense scope に register された resource の
   `pending=true` で **fallback に切替** → 直後 fetcher が走って resolve →
   children に戻る
3. 結果として user は **「server children → client fallback → 再 children」
   の 3 段 blink** を見る (toy runtime としては機能するが UX 劣化)

本 ADR (B-5c) で:

- server side で resource を `Promise.all` で resolve してから renderToString
- 結果を `__vidro_data` に embed
- client constructor が初期値を引き当てて `loading=false` スタート
- → Suspense は children 直出し → blink **完全消滅**

これで Phase B が完全に着地する (B-5c が最終段階)。

## Options

### 論点 1: bootstrap key の付け方

- **1-a (explicit `{ bootstrapKey: "user:123" }`)**: user が一意 string を渡す。
  衝突は user 責任、render 順依存しない、minify 耐性あり、grep 可能
- **1-b (positional)**: call-site 出現順を index。条件分岐 / Suspense 入れ子
  で順序ズレて全壊
- **1-c (implicit identity, line:col hash)**: コンパイラが採番。minify と
  source map 整備が必要、tree-shake で position ズレる
- **1-d (構築順 auto-id)**: render 順 = id。1-b と同根

### 論点 2: server resolve の戦略

- **2-a (2-pass `renderToStringAsync`)**: 1-pass で fetcher を集める →
  `Promise.allSettled` → 2-pass で resolved 値で再 render。Solid の
  `renderToStringAsync` 路線。CPU 2x だが正しさ保証あり
- **2-b (1-pass + VNode 穴埋め)**: resource を VNode tree に「穴」として
  保持し、最終 serialize で resolved 値を埋める。1-pass だが server-renderer
  全面改修、effect の再評価モデルを破壊
- **2-c (streaming SSR、Suspense 境界ごと chunk)**: Phase C 本命。Worker
  streaming + client progressive hydration が必要、現段階で過剰
- **2-d (SSR markup は loading=true のまま、bootstrap data だけ inject)**:
  resolve はする、markup には反映しない。実装超軽量だが blink 残る (B-5b と
  本質同じ) → ゴール未達

### 論点 3: bootstrap data の置き場

- **3-a (`__vidro_data.resources` に同居)**: 1 script tag、JSON 1 つに
  pathname/params/layers/resources を全部入れる
- **3-b (`<script id="__vidro_resources">` 別タグ)**: streaming で後追い挿入
  しやすい。Phase C 移行時に必要になる可能性

### 論点 3-b: 同居前提での DOM read 戦略

論点 3 で 3-a (同居) を選ぶと、Router の既存 `readBootstrapData()` (
`document.getElementById("__vidro_data") + el.remove()`) と Resource の
新規 reader が **同じ script tag を読む** 必要が出る。

- **3b-α (`packages/core` に shared `readVidroData()` cache util を新設)**:
  module 1 つで `__vidro_data` を 1 回だけ parse + remove + cache。
  Router と Resource は cache から自由に field を読む (順序非依存)
- **3b-β (Router の reader を残し、Resource は別 tag を読む)**: 結局 3-b に
  退化、論点 3 の決定とコンフリクト
- **3b-γ (Router が読んだ JSON を `window.__vidro` 等にも置く)**: global 経由
  の暗黙依存、test 困難

### 論点 4: bootstrap-hit Resource の Suspense register

- **4-a (register しない、loading=false スタート、fetcher 呼ばない)**:
  bootstrap-hit = 「初期値が確定済みの signal」semantics。Suspense は children
  直出し → blink 完全消滅
- **4-b (register → 即 unregister、1 tick だけ pending)**: 1 tick とはいえ
  flicker = blink 残り → ゴール未達

### 論点 5: Promise reject 時の伝搬

- **5-a (bootstrap に `{ error: serializedError }` を入れて client に伝搬)**:
  server で markup は user の error 表示 (e.g. `data.error?.message`) で焼かれる、
  client constructor は `error.value = hydratedError, loading=false` でスタート →
  hydrate cursor 整合
- **5-b (bootstrap miss 扱い、client で再 fetch)**: server で再現性ある失敗
  (DB down 等) を client で再 fetch しても無駄、markup は loading 表示 → 再
  fetch で error 表示 = blink
- **5-c (5xx 返して navigation 自体を失敗扱い)**: 単一 resource の失敗で全
  navigation 落とすのは過剰

### 論点 6: 既存 `renderToString` の扱い

- **6-a (sync 版残し、`renderToStringAsync` を追加)**: Suspense なしの軽量
  test では sync が便利、後方互換あり
- **6-b (破壊的に async 化)**: test 全書き換え + createServerHandler も
  await 必要

### 論点 7: server 側の重複 bootstrapKey 衝突

- **7-a (1-pass で fetchers Map に register、同一 key なら最初の fetcher を
  保持して以降を無視 + dev で warn)**: 同じ key で複数 resource が作られても
  fetch は 1 回、bootstrap-hit branch では同じ値が両 resource に渡る
- **7-b (throw)**: dev では分かりやすいが prod で navigation 落ちるのは過剰
- **7-c (last-write-wins)**: race 的で予測不能

## Decision

- 論点 1 → **1-a (explicit `bootstrapKey`)**
- 論点 2 → **2-a (2-pass `renderToStringAsync`)** ※ toy 段階の妥協、将来 1-pass
  化を検討する余地あり (project_pending_rewrites に記録)
- 論点 3 → **3-a (`__vidro_data.resources` に同居)**
- 論点 3-b → **3b-α (`packages/core` に `readVidroData()` cache util を新設)**
- 論点 4 → **4-a (register しない、loading=false スタート、fetcher 呼ばない)**
- 論点 5 → **5-a (error を serialize して bootstrap に入れる)**
- 論点 6 → **6-a (`renderToString` 残し、`renderToStringAsync` を追加)**
- 論点 7 → **7-a (最初の fetcher 保持、dev で warn)**

## Rationale

### 1-a: explicit bootstrapKey

- render 順依存で壊れる経路 (1-b/1-d) は条件分岐 / Suspense 入れ子で確実に
  破綻する。toy runtime であってもこの脆さは許容できない
- implicit hash (1-c) は minify / source map 整備が必要で、現段階で投資する
  価値が薄い (Solid も明示的 storage option ベース)
- 1-a は user が string 1 個書くだけ。grep / debug 容易、衝突は dev warn で
  検知できる (論点 7-a)
- 「同じ resource を別 component で 2 回作る」ケース (e.g. `user:${id}`) で
  自然に dedupe できる副次効果あり

### 2-a: 2-pass renderToStringAsync

- 1-pass + VNode 穴埋め (2-b) は server-renderer.ts の素直な build 構造を
  壊す。VNode tree が mutable な resource ref を含むことになり、effect の
  再評価モデルとも整合しない
- streaming (2-c) は Phase C 案件。Worker streaming + client progressive
  hydration をペアで設計する必要があり、Phase B のスコープ外
- B-5d (load resource only) (2-d) は blink 解消というゴールを満たさない
- 2-a は CPU 2x のコストはあるが、既存 `renderToString` を内部で 2 回呼ぶ
  だけで実装でき、Solid `renderToStringAsync` の参考実装も多い。toy 段階
  では正しさ優先

### 3-a + 3b-α: 同居 + shared reader

- 3-a 自体は payload size 同じ、Phase B で分ける動機なし
- ただし Router (`@vidro/router`) と Resource (`@vidro/core`) の両方が同じ
  script tag を読む必要が出る。各々独立に `getElementById` + `remove` すると
  ライフサイクル衝突 (どちらが先に remove するかで他方が読めなくなる)
- 3b-α: `packages/core/src/bootstrap.ts` に `readVidroData()` を新設。
  - module-level cache (`let cache: Record<string, unknown> | null | undefined`)
  - 初回呼び出しで `getElementById + JSON.parse + remove + cache`、以降は
    cache から返す
  - Router の `readBootstrapData()` も `readVidroData()` 経由に書き換え
  - Resource の bootstrap-hit lookup も同 module 経由
  - 順序非依存、test もしやすい (cache reset 関数を test util 用に export)
- 将来 streaming で resources を分ける必要が出たら 3-b に拡張する

### 4-a: bootstrap-hit は loading=false スタート

- bootstrap-hit = 「server で resolve 済みの初期値が確定している signal」
  という semantics。pending 扱いするのは概念的に不整合
- register しないので Suspense scope の count に影響せず、Suspense は children
  直出し → blink 消滅
- fetcher を呼ばないので帯域節約、server で resolve 済みの値を client が
  再 fetch する無駄を避ける

### 5-a: error も bootstrap に入れる

- server 側で fetch 失敗 (DB down 等) した resource は、client で再 fetch
  しても多くの場合同じく失敗する。再 fetch (5-b) は帯域の無駄 + blink
- markup と client state を一致させるのが SSR の本懐: server で焼いた error
  表示 (e.g. `data.error?.message`) を client が hydrate してそのまま見せる
- error の serialize 形式は ADR 0017 系列の `serializeError` (
  `{ name, message, stack? }`) と統一。client constructor で `hydrateError`
  で `Error` instance に復元
- 5-c (5xx で navigation 落とす) は単一 resource 失敗で全画面落とすので過剰

### 6-a: sync 版を残す

- Suspense / Resource を使わない単純な markup test では sync の方がシンプル
- 既存 `renderToString` を内部で 2 回呼ぶ実装にすれば、async 版は薄い
  wrapper で済む
- Phase C で `renderToStream` を入れる時は 3 兄弟 (sync / async-blocking /
  streaming) になるが、それぞれ役割明確

### 7-a: 重複 key は first-write-wins + dev warn

- 7-b (throw) は prod で navigation 落ちるリスク。warn に留める
- 7-c (last-write-wins) は同じ key の 2 resource が異なる fetcher を持って
  いる場合に予測不能
- 7-a は「同じ key なら同じ resource (semantics 同じ)」を user が保証する
  前提に立つ。dev warn で検知

## Consequences

### 実装範囲

- **`packages/core/src/bootstrap.ts` 新規** (3b-α):
  - `readVidroData(): Record<string, unknown> | null` (module cache + 1 回 read)
  - `__resetVidroDataCache(): void` (test 用、`__` prefix で internal 表明)
- **`packages/core/src/resource.ts` 修正**:
  - `createResource(fetcher, options?: { bootstrapKey?: string })` overload
  - constructor で renderer.isServer 分岐:
    - server + bootstrapKey + scope hit → 値を引き当てて loading=false
    - server + bootstrapKey + hit なし → scope に fetcher を register、
      loading=true (1-pass の標準動作)
    - server + bootstrapKey なし → 従来通り loading=true (B-5b 動作)
  - constructor で client 分岐:
    - bootstrapKey + bootstrap data に hit → loading=false スタート、
      Suspense register しない、fetcher 呼ばない
    - bootstrapKey + hit なし or bootstrapKey なし → 従来通り `refetch()`
- **`packages/core/src/resource-scope.ts` 新規** (server only state):
  - `class ResourceScope`: `fetchers: Map<string, () => Promise<unknown>>` +
    `hits: Map<string, BootstrapValue>` を保持
  - `runWithResourceScope(scope, fn)` (suspense-scope と同パターン)
  - `getCurrentResourceScope(): ResourceScope | null`
  - `BootstrapValue = { data?: unknown } | { error: SerializedError }`
- **`packages/core/src/render-to-string.ts` 修正**:
  - `renderToStringAsync(fn): Promise<{ html: string, resources: Record<string, BootstrapValue> }>` 追加
  - 1-pass: 空 scope で renderToString → fetchers 集める
  - `Promise.allSettled` で全部待つ → BootstrapValue map 構築
  - 2-pass: hits 入り scope で renderToString → resolved 値で markup 完成
  - return `{ html, resources }`
- **`packages/core/src/index.ts`**: `createResource` の型 (overload) /
  Suspense / 既存 export は変更なし、server entry に
  `renderToStringAsync` 追加
- **`packages/core/src/server.ts`**: `renderToStringAsync` を export
- **`packages/router/src/router.tsx`**: `readBootstrapData()` を
  `readVidroData()` 経由に書き換え (3b-α)。schema 拡張 (`resources` field)
  は Router 側では透過 (Resource 側だけが読む)
- **`packages/router/src/server.ts`**: `handleNavigation` で
  `renderToString` → `renderToStringAsync` 切替、返ってきた `resources` を
  `__vidro_data` に同居 (`{ pathname, params, layers, resources }`)
- **新規 test**:
  - `packages/core/tests/bootstrap.test.ts`: cache hit / miss / parse failure
  - `packages/core/tests/resource.test.ts` 追記: bootstrap-hit ブランチ
    (data / error)、Suspense register されない
  - `packages/core/tests/render-to-string-async.test.ts` 新規: 2-pass で
    resolved 値が markup、reject も serialize される、bootstrapKey なし
    resource は無視
- **router-demo に B-5c 確認用 route 追加**:
  - 例: `apps/router-demo/src/routes/users/[id]/profile/index.tsx` に
    createResource + Suspense (or 既存の users/[id] を改造)
  - wrangler dev + Playwright で blink 無し動作確認

### scope 外 (将来書き換え候補)

- **2-pass の CPU 2x コスト**: production 化時 or large-app 化時に 1-pass +
  VNode 穴埋め (2-b) や streaming (2-c = Phase C) への書き換え検討
  (`project_pending_rewrites.md` に記録)
- **AbortController で server の in-flight fetch を cancel**: timeout や
  request cancellation を入れる時の宿題
- **server-side resource の cache layer**: 同 key を複数 navigation で
  共有する用途。HTTP cache とは別軸の設計が必要
- **reactive source `createResource(source, fetcher)`**: SSR 経路では source
  signal を server で評価する形になる。B-5c 後の宿題
- **streaming で `__vidro_resources` 別 tag に分割** (3-b): Phase C で必要
  になったら検討

### bundle / payload size

- bootstrap.ts: ~20 行、minify ~150 byte
- resource-scope.ts: ~30 行、minify ~200 byte
- renderToStringAsync: ~40 行追加 (renderToString を内部で 2 回呼ぶだけ)
- bootstrap data の `resources` field: 1 resource あたり JSON 1 オブジェクト分

## Revisit when

- **Phase C (streaming SSR)**: 2-pass を 1-pass に戻したくなる動機が出る。
  Suspense 境界ごとの chunk 単位で fetcher を集める設計に変更
- **production 化**: AbortController / cache layer / dev warn の本番剥がし
  / bootstrap data の最小化 (空 resources 省略) 等
- **bootstrap data の payload が肥大化**: `__vidro_data` を分割する判断
  (3-b 移行)、JSON でなく binary serializer (msgpack 等) を検討
- **error の serialize 拡充**: 現状 `{ name, message, stack? }` のみ。
  custom Error subclass を保持したい場合は devalue / superjson 等への
  移行 (project_next_steps の宿題と同じ枠)

## 関連 ADR

- 0001: batch (resource resolve / bootstrap-hit でも使用)
- 0006: factory 一本化規約
- 0017: ADR 0017 系列の `serializeError` を bootstrap value にも使用
- 0021: anchor + fragment 規約 (Suspense markup を server で吐く根拠)
- 0028: createResource (B-5a、本 ADR で bootstrap option を追加)
- 0029: Suspense (B-5b、本 ADR の bootstrap-hit branch で register skip)
- 次: **Phase C** (streaming SSR、未着手)
