# 0028 — SSR Phase B Step B-5a: createResource (signal-like async primitive)

## Status

Accepted — 2026-04-27

## Context

ADR 0027 で SSR Phase B (B-3d) が着地し、SSR + hydrate が router-demo で
end-to-end 動作するようになった。次は ADR 0025 で B-4 から切り出した
**Suspense + createResource** (Phase B Step B-5)。`<Suspense>` 単体は async
を catch する境界 primitive で、catch 対象としての **「pending を発火する側」
= createResource** が必要。本 ADR は B-5 を **2 段階分割** した B-5a として、
client only の `createResource` をまず固める。

Vidro の primitive 規約 (ADR 0006):

- 生成は factory (`signal()` / `computed()` / `effect()` / `ref()`)
- class は internal、`export type` のみ公開
- 読み書きは `.value` で統一

createResource もこの規約に揃えると、user code の書き味が:

```ts
const userData = createResource(() => fetch("/api/user").then((r) => r.json()));

effect(() => {
  if (userData.loading) console.log("…");
  else if (userData.error) console.log("err:", userData.error);
  else console.log("data:", userData.value);
});

userData.refetch();
```

となる。Solid の `[data, { mutate, refetch }] = createResource(fetcher)` と
比較して accessor 関数ではなく `.value` getter、operator は instance method、
というのが Vidro 流。

## Options

### 論点 1: API 形式

- **1-a (signal-like, `.value` / `.loading` / `.error` / `.refetch()`)**:
  Vidro の他 primitive と統一。class instance + factory
- **1-b (Solid 互換 tuple `[data, { mutate, refetch }]`)**: SolidStart からの
  移植コストが小さいが、`.value` 統一感を崩す
- **1-c (`use(promise)` React 19 風)**: throw promise が前提で、Suspense の
  実装方式 (論点 3) と密結合。toy 段階では重い

### 論点 2: constructor で即時 fetch するか

- **2-a (即時 fetch、loading=true から始まる)**: Solid 互換、JSX 内で
  `createResource(...)` と書いた瞬間に発火。lazy 化したい人は wrapper を書く
- **2-b (lazy、`.refetch()` を呼ぶまで起動しない)**: 明示的だが書きにくい

### 論点 3: state 更新の atomicity

- **3-a (data + loading の同時更新を `batch()` で 1 effect)**: effect の再走を
  最小化、UI チラつき (loading=false → data を 2 step で見る) 防止
- **3-b (個別更新)**: シンプルだが effect が 2 回走る

### 論点 4: race condition (refetch 中の旧 fetch resolve)

- **4-a (token 方式: increment + then 内で一致確認、不一致なら無視)**:
  router の `loadToken` と同パターン、軽量。in-flight Promise は cancel しない
  (resolve は捨てるだけ、HTTP request は走り続ける)
- **4-b (AbortController で実 fetch を cancel)**: 帯域節約だが fetcher が
  AbortController を受け取る規約が必要。Solid は Source signal 経由
- **4-c (ignore、ユーザー責任)**: 古い resolve が新しいデータを上書きする
  glitch が出る。toy 段階でも避けたい

### 論点 5: reject 時の data の扱い

- **5-a (reject 時も data は前回値を保持)**: Solid 互換。「直近成功時の値で
  UI を出しつつ error 表示」が書ける (e.g. SWR スタイル)
- **5-b (reject 時に data=undefined にリセット)**: 単純だが SWR パターンが
  書きづらい

### 論点 6: SSR 経路の扱い

- **6-a (B-5a スコープ外、client only)**: SSR で createResource を呼んでも
  fetcher は走るが、renderToString は同期完了するので resolve を待たない →
  loading=true のまま markup に入る。**B-5c で別途設計**して bootstrap data
  経由の cache 命中を作る
- **6-b (B-5a 内で SSR resolve も実装)**: scope が膨らむ。test もマトリクス
  状になる

### 論点 7: reactive source (Solid の `createResource(source, fetcher)`)

- **7-a (B-5a スコープ外)**: 1 引数の `createResource(fetcher)` のみ。source
  signal 変化での自動 refetch は B-5 後段の宿題
- **7-b (B-5a で実装)**: 仕様が膨らむ、また Suspense との関係 (B-5b) を
  決める前に source 経路を入れると後で書き直しになりやすい

## Decision

- 論点 1 → **1-a (signal-like)**
- 論点 2 → **2-a (即時 fetch)**
- 論点 3 → **3-a (`batch()` で 1 effect 化)**
- 論点 4 → **4-a (token 方式)**
- 論点 5 → **5-a (reject 時も data 保持)**
- 論点 6 → **6-a (B-5a は client only、SSR は B-5c)**
- 論点 7 → **7-a (1 引数のみ、source 引数は宿題)**

## Rationale

### 1-a: signal-like

- Vidro の他 primitive (signal / computed / effect / ref) と書き味が揃う。
  user は「createResource は async 版の computed」というメンタルモデルで書ける
- class instance は internal、`export type { Resource }` で型のみ公開する
  ADR 0006 の規約に合致

### 2-a: 即時 fetch

- JSX 内 `const data = createResource(fetch);` だけで読み込み開始 → user 視点で
  「読み込みは書いた瞬間スタート」が直感的
- 即時起動で発火が漏れる心配が無い (lazy だと `.refetch()` 呼び忘れバグが出る)
- lazy にしたいケースは少数 + wrapper で吸収可能

### 3-a: batch で 1 effect 化

- resolve 経路で `data = ...` → `loading = false` の 2 step だと、その間で
  effect が一度 (data あり / loading=true) という transient 状態を観測する。
  UI 表示で「loading 中なのに data がチラっと見える」glitch
- batch でまとめれば effect は 1 回、`(data, loading=false)` の clean state
  だけ観測

### 4-a: token 方式

- AbortController 経路は fetcher が `(signal) => Promise<T>` の 2-arg 版に
  なるなど API が肥大する。`fetch(url, { signal })` のような optional 渡しを
  user に強要する形になる
- toy 段階の race 解消は「古い resolve を無視」で十分。HTTP は走り続けるが
  帯域は問題にならない (将来 4-b に拡張する余地は残す)

### 5-a: reject 時も data 保持

- ユーザーが SWR / TanStack Query のようなパターンで「キャッシュを見せつつ
  refetch して失敗したら error も表示」と書けるのが嬉しい
- value/loading/error の 3 axis は **互いに独立** な signal として扱うのが
  自然。一方を更新したら他方が暗黙に変わる、は驚き最小原則に反する

### 6-a: client only

- SSR 経路は **bootstrap data 経由で cache 命中** させたい。これは Phase A
  の仕組みを引き継ぐ別軸の設計が要る (どの resource をどの key で server →
  client に渡すか、key 衝突の扱い、再実行のセマンティクス)
- B-5b (Suspense primitive) を先に固めると、SSR で何を resolve したかの
  「期待値」が明確になる。順序は B-5a → B-5b → B-5c

### 7-a: 1 引数のみ

- reactive source (`createResource(sourceSignal, fetcher)` で source 変化で
  自動 refetch) は便利だが、Suspense との結合度が高い設計判断 (source 変化
  で fallback に戻すのか、stale を見せるのか等)
- B-5b 完了後に「Suspense と source 連携をどう協調させるか」を別 ADR で
  立てる方が筋がいい

## Consequences

### 完了 (本 ADR 内容)

- **`packages/core/src/resource.ts` 新規**:
  - internal `class Resource<T>` (private fields `#data` / `#loading` /
    `#error` / `#fetcher` / `#token`)
  - `value` / `loading` / `error` getter (Signal 経由 → effect 自動依存)
  - `refetch()` で token increment + batch でstate 切替 + Promise then/catch
    で token 一致時のみ反映
- **`packages/core/src/index.ts`**: `createResource` factory + `Resource` 型
  を export
- **`packages/core/tests/resource.test.ts` 新規** (Node env): 6 ケース
  - 構築直後の初期値
  - resolve / reject 経路の値反映 + 前回値保持
  - refetch の loading 切替 + 新値反映
  - race condition (token 不一致で旧 resolve 無視)
  - effect 経由の reactive 追従 (batch で 1 effect)
- **既存テスト全 pass**: core 内 resource.test.ts のみ追加、他は影響なし
  (12 個の pre-existing 失敗は前々セッションから継続、本 ADR とは無関係)

### B-5b で続く設計

- **Suspense primitive (`<Suspense fallback={...}>{children}</Suspense>`)** が
  「子孫の resource pending を検知してfallback 表示」する仕組み。Vidro は
  fine-grained reactive なので、`resource.loading === true` の effect を
  Owner tree で集約する形が筋良さそう。詳細は ADR 0029 (B-5b) で
- **論点 3 (signal-base vs throw promise) の実装方針を B-5b で確定**:
  本 ADR の段階では「resource は signal-like」で純化、throw promise は
  Suspense 実装方式の選択肢の一つに過ぎない

### scope 外の宿題

- **SSR + bootstrap cache (B-5c)**: server で resource を Promise.all で resolve
  → `__vidro_data` に embed → client は cache 命中で sync resolve → hydrate
  cursor 整合
- **reactive source (`createResource(source, fetcher)`)**: source 変化で
  自動 refetch、stale 表示か fallback 切替か等の設計
- **AbortController** (fetch 中止)
- **mutate API** (Solid の楽観的更新)

### bundle size

- Resource class: ~50 行、minify 後 ~200 byte 増程度
- 既存 primitive (Signal / batch) を再利用しているので新規依存なし

## Revisit when

- **B-5b 着手時**: Suspense が resource pending を検知する具体的方式を確定。
  もし「throw promise」方式を採るなら、Resource の `value` getter を
  「pending 中は promise を throw」に拡張する選択肢が出てくる (現状は
  `undefined` を返す)
- **SSR 接続 (B-5c)**: server resolve 経路を入れる時、Resource の constructor
  に「初期値を bootstrap から渡す」hatch が必要になる。コンストラクタの API
  拡張を検討
- **reactive source 追加時**: `createResource(source, fetcher)` の 2-arg 版を
  追加。source signal を effect で wrap して変化時に refetch、現在の
  fetcher 経路を活用
- **production 化**: pending 中の Promise が dispose 時に GC されるように
  AbortController + Owner.onCleanup 連携を入れる

## 関連 ADR

- 0001: batch (本 ADR で多用)
- 0006: factory 一本化規約 (本 ADR で踏襲)
- 0019 ~ 0027: SSR Phase B (本 ADR が Phase B Step B-5a として位置づく)
- 次: **B-5b** (Suspense primitive)、その後 **B-5c** (SSR resolve + bootstrap
  cache 命中)
