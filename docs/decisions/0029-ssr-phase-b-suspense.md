# 0029 — SSR Phase B Step B-5b: Suspense primitive (signal-base pending 集約)

## Status

Accepted — 2026-04-27

## Context

ADR 0028 (B-5a) で `createResource` を client only で実装した。その時点では
resource を **誰が** pending として観測するかが未定義のままで、user は
`<Show when={!data.loading} fallback={<Spinner />}>` のような明示分岐で
loading 状態を捌く必要があった。本 ADR は B-5b として **Suspense primitive**
を追加し、children 内で構築された resource の pending を境界で **自動集約 →
fallback 表示** できるようにする。

ADR 0028 で論点 3 を「signal-base (B)」として方針合意済み:

- React の throw promise 方式ではなく
- Vidro の signal/effect 機構で pending を伝播

具体実装は本 ADR で確定する。

## Options

### 論点 1: pending 検知方式の具体実装

- **1-a (SuspenseScope に resource が register、count signal で集約)**:
  Suspense は children() を `runWithSuspenseScope(scope, fn)` で wrap し、
  内部 createResource が constructor で `getCurrentSuspense()` を捕捉、scope
  に register。scope は in-flight 数を `Signal<number>` で持ち、`pending`
  (count > 0) を effect で読むと自動 reactive 化される
- **1-b (effect が読む signal を Suspense が track して、loading=true の signal
  を検知)**: Solid 内部に近い高度な実装。effect の internal state を Suspense
  が peek する形になり、抽象が漏れる
- **1-c (resource が throw promise を投げて Suspense が catch)**: React 流。
  `.value` getter を「pending 中は throw」に拡張する必要があり、user code が
  普通に書きにくい (try/catch を意識しないといけない場面が出る)

### 論点 2: scope 捕捉のタイミング

- **2-a (constructor 時点の getCurrentSuspense() を保持、resource の lifetime
  で固定)**: Solid 互換。resource が後で別の Suspense 配下に移動しても、
  最初の scope に remain
- **2-b (refetch のたびに再捕捉)**: 動的だが、user code 内で resource を
  「外で作って Suspense 内で使う」ようなケースで挙動が読みにくくなる

### 論点 3: register の単位

- **3-a (refetch 開始で register、resolve / reject で 1 回 unregister)**:
  in-flight 数 = pending 数を素直に表現。連続 refetch (resolve 前に refetch
  し直す) では二重 register せず count を維持し、最終 resolve で 1 回 unregister
- **3-b (毎回の refetch ごとに 1 unregister)**: 連続 refetch の解釈が難しい

### 論点 4: children Owner の lifecycle

- **4-a (Suspense 開始時に作って disposeせず保持、pending 中も裏で生かす)**:
  Solid 互換。resolve 時に同じ Node を再表示できる、effect / state の連続性
- **4-b (pending 切替時に dispose、resolve 時に再 mount)**:
  シンプルだが state リセットされ、resolve 時に flicker

### 論点 5: 切替の DOM 構造

- **5-a (ErrorBoundary と同じ fragment + currentBranch + anchor、effect で
  insertBefore / removeChild)**:
  既存 anchor 系 primitive と統一。hydrate cursor 規約 (ADR 0021) も再利用可
- **5-b (Show と同じ when 条件分岐スタイル)**: when は static 評価が前提
  なので effect 経路と相性悪い

### 論点 6: server mode の挙動 (B-5b スコープ)

- **6-a (server で children を sync 評価してそのまま吐く、resource は
  loading=true のまま markup に入る)**: B-5b スコープ。SSR + hydrate で blink
  が出る可能性あり (server children → client fallback → 再 children)。許容
- **6-b (server で fallback を吐く、resource は無視)**: SSR markup と client
  hydrate の差分が大きすぎて hydrate cursor が不整合
- **6-c (server で resource を Promise.all で resolve してから render、
  bootstrap data に embed)**: B-5c の本命設計。本 ADR では先送り

### 論点 7: hydrate 経路

- **7-a (mount と同じ flow、HydrationRenderer 経由で server markup を消費)**:
  既存 anchor 系 primitive と同じ。`<!--suspense-->` anchor が cursor 整合の
  鍵
- **7-b (Suspense は hydrate でも fallback だけ吐く、後で children に置換)**:
  blink 確実。server children を有効活用しない

### 論点 8: error 経路

- **8-a (error は Suspense に影響しない、resource.error が立つだけで loading=
  false → unregister → children に切替)**: error 表示は user か ErrorBoundary
  が担当。職能分離
- **8-b (error も Suspense fallback 扱い)**: 「データ未到達」と「エラー」が
  混ざってしまい user 視点で何が起きたか分からない

## Decision

- 論点 1 → **1-a (SuspenseScope + count signal)**
- 論点 2 → **2-a (constructor で固定)**
- 論点 3 → **3-a (refetch 開始 register、resolve/reject で 1 回 unregister)**
- 論点 4 → **4-a (children Owner 保持)**
- 論点 5 → **5-a (ErrorBoundary 同型)**
- 論点 6 → **6-a (server children 直吐き、B-5c で改善)**
- 論点 7 → **7-a (HydrationRenderer 経路に合流)**
- 論点 8 → **8-a (error は影響しない、職能分離)**

## Rationale

### 1-a: SuspenseScope + count signal

- Vidro の reactive 機構 (Signal + Effect) をそのまま使うので新しい抽象を
  足さない。`scope.pending` の getter が effect 内で count.value を読むと
  自動的に依存登録される
- throw promise 方式 (1-c) と違い、user の `.value` 読みは普通の getter で
  済む。書き味が変わらない
- 内部 state も `Signal<number>` 1 つだけ。シンプル

### 2-a: constructor で固定

- resource の identity と Suspense scope の binding を **構築時** に確定する
  ことで、後の挙動が予測可能になる
- user が「resource を Suspense の外で作って Suspense 内で使う」ケースは
  scope null = どの Suspense にも干渉しない、という意味論で安全側
- Solid と同じ規約

### 3-a: refetch 開始 register、resolve/reject で 1 回 unregister

- count が **in-flight 数** をそのまま表す。連続 refetch (前回 resolve 前に
  refetch し直す) では `if (this.#suspense && !this.#unregister)` で二重
  register をガードし、count は 1 のまま維持。最終 resolve で 1 回 unregister
- token 方式 (resource 内部の race 制御) とは独立に動く: 古い fetch が
  resolve しても token 不一致で値は反映されないが、unregister は走らない →
  正しい

### 4-a: children Owner 保持

- pending 中も children Owner は生きていて、内部の effect / signal は
  そのまま継続。resolve 時に同じ Node を anchor 前に insertBefore するだけで
  state 連続性が保たれる
- Solid 互換、user の期待値に合致

### 5-a: ErrorBoundary 同型

- fragment + currentBranch + anchor 構造、effect で signal 変化に応じて
  removeChild / insertBefore する flow は既に ErrorBoundary で実績あり (ADR 0021)。同 pattern で書けば hydrate cursor 規約も自動的に満たす
- `<!--suspense-->` anchor を server mode でも吐く (cursor 整合のため)

### 6-a: server children 直吐き

- B-5b は **client only の Suspense semantics** を確定するのが本論。SSR で
  resolve まで待つかは別判断 (B-5c)
- 現状 server で children を render すると、resource の `.value` は undefined
  (loading=true のまま)。user 側の JSX `data.value ?? "..."` のような fallback
  値で markup が組まれる。client が hydrate で fallback (← Suspense の) に
  切替えると、SSR markup 上のテキストが書き換わる → blink
- B-5c で bootstrap cache 命中させると `.value` が server resolve 済みの値で
  始まり、blink 解消。本 ADR ではその受け渡しを実装しないので blink は許容

### 7-a: HydrationRenderer 経路に合流

- ADR 0021 で確立した「server で anchor を吐く + client hydrate で createComment
  経由で消費」規約に乗る。`<!--suspense-->` anchor を server / client / hydrate
  全 mode で同 shape にする
- 初回 fallback / children 判定は scope.pending を sync で読む。client
  hydrate 時、scope.pending が true なら HydrationRenderer の cursor が
  fallback の markup を消費する想定 (B-5c 完成時) — B-5b 単体だと server
  markup と client 初回判定がズレる可能性あるが、blink で吸収

### 8-a: error は Suspense に影響しない

- resource の loading=false に切替わった時点で unregister → count 減 →
  Suspense は children に戻す。children 内で `data.error` を読んで error UI
  を出すか、ErrorBoundary で catch するかは user の選択
- 「pending → ローディング表示」「error → error UI」「success → データ表示」
  の 3 状態を明確に分離。Suspense は pending だけを担当する単機能 primitive

## Consequences

### 完了 (本 ADR 内容)

- **`packages/core/src/suspense-scope.ts` 新規**:
  - `class SuspenseScope` (count signal、register/unregister)
  - module-level `currentSuspense` + `runWithSuspenseScope` / `getCurrentSuspense`
    (mount-queue と同パターン)
- **`packages/core/src/suspense.ts` 新規**:
  - `Suspense({fallback, children})` primitive。fallback / children は両方
    `() => Node` で受ける (B-4 children getter 化と整合)
  - server / client 分岐、ErrorBoundary 同型の DOM 構造
  - children Owner は dispose せず保持
- **`packages/core/src/resource.ts` 修正**:
  - constructor で `getCurrentSuspense()` を捕捉して `#suspense` に保持
  - `refetch()` 開始で register (二重 register 防止)、resolve/reject で
    unregister
- **`packages/core/src/index.ts`**: `Suspense` を export
- **`packages/core/tests/suspense.test.ts` 新規** (jsdom env): 5 ケース
  - 基本 (resource pending → fallback、resolve → children)
  - 複数 resource を 1 Suspense でまとめて待つ (count 集約)
  - error は Suspense に影響しない
  - Suspense より外で作られた resource は無視
  - nested Suspense (内側 scope のみ集約)
- **既存 resource.test.ts 全 pass + suspense.test.ts 5/5 pass**: 11/11

### B-5c で続く設計

- **SSR resolve + bootstrap cache 命中**: server で resource を Promise.all で
  resolve → `__vidro_data` に embed → client constructor で初期値を引き継ぐ
- **hydrate cursor 整合**: server で吐く markup は children resolve 済 (or
  fallback) のいずれか、client 初回 scope.pending と一致するよう調整

### scope 外の宿題 (本 ADR 段階)

- **server で blocking resolve**: B-5c でないと SSR markup と client 初回判定
  のズレ (blink) が出る。許容
- **reactive source `createResource(source, fetcher)`**: B-5c 後の宿題
- **Suspense list / SuspenseList** (Solid / React 19 の同期表示制御): 当面不要
- **AbortController** (fetch 中止): production 化時の宿題

### bundle size

- SuspenseScope: ~30 行、minify ~150 byte
- Suspense primitive: ~100 行、minify ~600 byte (ErrorBoundary 同型なので
  既存パターンの再利用)
- Resource 拡張: ~20 行追加 (suspense register 部)

## Revisit when

- **B-5c (SSR + bootstrap cache) 着手時**: server resolve した結果を
  bootstrap data に embed する経路を新設。Resource の constructor に
  「初期値を bootstrap から渡す」hatch が必要になる可能性 (例:
  `createResource(fetcher, { bootstrapKey: "..." })`)。本 ADR の Suspense は
  そのまま使えるが、初回 pending=false で children を出すパスが正しく動く
  か再確認
- **reactive source 追加時 (`createResource(source, fetcher)`)**: source 変化
  で refetch される際に、Suspense が fallback に戻るか stale を見せるか別途
  判断
- **Concurrent rendering 系の機能を入れる場合** (transition、startTransition
  等): Suspense は同期切替で書いてある。pending state と transition の協調
  を別 ADR で
- **production 化**: pending 中に dispose されたら fetch を AbortController
  で cancel + onCleanup で unregister。現状 dispose 時の cleanup は
  `childrenOwner.dispose()` で children 配下の effect は止まるが、resource の
  Promise 自体は走り続ける

## 関連 ADR

- 0001: batch (resource resolve 経路で多用)
- 0006: factory 一本化規約 (Suspense は class ではなく function 公開)
- 0021: anchor + fragment 規約 (本 ADR で `<!--suspense-->` を server で吐く)
- 0025: children getter 化 (Suspense の fallback / children を `() => Node`
  で受ける根拠)
- 0028: createResource (B-5a、本 ADR で Suspense 連携を追加)
- 次: **B-5c** (SSR resolve + bootstrap cache 命中で blink 解消)
