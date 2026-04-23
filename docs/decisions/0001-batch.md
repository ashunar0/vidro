# 0001 — `batch(fn)` の実装方針

## Status

Accepted — 2026-04-23

## Context

Signal の書き込み 1 回ごとに Effect が同期で走る実装だったため、
複数 Signal を連続で更新すると Effect が複数回走る。UI 更新の非効率と、
中間状態が observer に見えてしまう問題がある。

```ts
a.value = 1; // effect 実行
b.value = 2; // effect 再実行
```

これを 1 回の Effect 実行にまとめる `batch(fn)` を導入したい。
論点が 3 つある:

1. 通知の遅延方式 (global queue か、Signal ごとか)
2. `batch` 内で fn が throw した場合、queue を flush するか
3. Computed は batch の影響を受けるか

## Options

### 論点 1: 通知の遅延方式

- **A. global queue** (`pendingEffects: Set<Observer>`) + `batchDepth` カウンタで
  ネスト対応。Effect.notify が batch 中なら enqueue、最外で抜けた瞬間に flush
- **B. Signal ごとに pending フラグ** を持たせ、batch 抜けで Signal を順に通知
- **C. microtask ベース** で常に非同期 flush (batch 呼び出しが不要)

### 論点 2: fn が throw した時

- **A. flush しない** — queue 破棄、例外伝播
- **B. finally で flush してから re-throw**
- **C. queue も破棄し、Signal の書き込みもロールバック**

### 論点 3: Computed の扱い

- **A. batch 対象にする** — Computed.notify も遅延
- **B. 対象外** — Computed.notify は従来どおり同期で dirty 伝播

## Decision

- 論点 1 → **A (global queue + batchDepth)**
- 論点 2 → **B (finally で flush + re-throw)**
- 論点 3 → **B (Computed は batch 対象外)**

## Rationale

### 論点 1: global queue

- B (Signal ごと) は Signal が notify 時にどの observer が batch 中か判断する情報を
  持たないと重複排除ができず、observer 側に状態を持たせる必要が出て複雑化
- C (microtask) は「batch の明示」を奪うメリットがある一方、同期的な UI 更新を
  期待するコードが壊れる。Solid / Preact signals も「明示 batch + 同期 flush」
- **判断軸**: シンプルさと既存パターンへの準拠

### 論点 2: finally で flush + re-throw

- A (flush しない) は書き込み済みの state と observer の観測が食い違う
  不整合を生む。画面と現実が乖離するバグを誘発
- C (ロールバック) は Signal が前値を覚える仕組みが必要で、primitive の
  単純さを壊す。そこまでのトランザクション性は需要と乖離
- **判断軸**: state と observer の一貫性 > fn の atomicity

### 論点 3: Computed は batch 対象外

- Computed は pull-based (lazy) なので `.notify()` は dirty 化するだけで副作用ゼロ
- batch 中でも Computed.value を読めば最新が取れる必要がある (開発体験)
- 下流の Effect は Computed 経由で notify されるが、そこは batch 対象として
  queue に入るので結果は同じ
- **判断軸**: 「変更の必要がないなら触らない」 (引き算のデザイン)

## Consequences

- `batchDepth` / `pendingEffects` が global state に増えた。SSR や
  worker で複数インスタンスを動かしたい場合は per-instance 化が必要
- flush 中に Signal 書き込みが起きると depth=0 に戻っているため即実行される。
  Effect の `#running` ガードで自己再入は吸収される
- fn throw 時、先に書き込んだ Signal の状態は残る (ロールバックしない)

## Revisit when

- SSR / Worker 対応で global state を切り離す必要が出た時
- 「batch 内で throw されたら書き込みを戻したい」という強いユースケースが出た時
