# ADR 0032 — `createResource` → `resource` rename + reactive source overload

- Status: Accepted
- Date: 2026-04-27
- Phase: Phase B-5 系の宿題回収 (resource API 完成形へ寄せる)

## 背景

ADR 0028 (B-5a) で導入した async primitive の名前は `createResource`。Solid の
`createResource` をそのまま踏襲したが、これは ADR 0006 (factory-only API) で
決めた **1 単語 factory 規約** から outlier になっていた:

| 既存 primitive                                                       | 命名                                            |
| -------------------------------------------------------------------- | ----------------------------------------------- |
| signal / computed / effect / ref / batch / untrack / hydrate / mount | 1 単語小文字 factory                            |
| onCleanup / onMount                                                  | `on` prefix の lifecycle                        |
| Suspense / ErrorBoundary                                             | JSX component (PascalCase)                      |
| **createResource**                                                   | **Solid 風 `create` prefix が残ってる outlier** |

加えて、ADR 0028 論点 7-a で「reactive source (source signal 変化で auto
refetch) は B-5 後段の宿題」と明記したまま放置されていた。Phase C 着地で
streaming SSR まで形になり、resource を実用化フェーズに進めるには:

1. 命名規約に揃える
2. Solid と同等の reactive source overload を入れる

の 2 点を 1 つの ADR で同時に着地させる。Phase C 完成直後で外部 user が居ない
今が rename のコスト最小タイミング。

## 採用方針 (要約)

- **factory 名**: `createResource` → `resource` (1 単語小文字)
  - 型は引き続き `export type { Resource }` で `Resource<T>` 公開。`signal` / `Signal<T>` と同じパターン
- **後方互換 alias は置かない**: `createResource` は即削除。理由は外部 user
  ゼロ + alias を残すと「規約違反命名がドキュメント化される」逆効果
- **reactive source overload 追加**:
  ```ts
  // overload 1 (sourceless、既存)
  resource<T>(fetcher: () => Promise<T>, options?: ResourceOptions): Resource<T>;
  // overload 2 (sourceful、新規)
  resource<S, T>(
    source: () => S | false | null | undefined,
    fetcher: (value: S) => Promise<T>,
    options?: ResourceOptions
  ): Resource<T>;
  ```
- **source 動作**:
  - constructor で source-tracking effect を 1 個張る。effect 内で `source()` を
    呼ぶと自動 dep 登録 → signal 変化で再実行 → `#startFetch(value)`
  - gating: source が `false` / `null` / `undefined` を返したら fetcher 呼ばない、
    loading=false、`r.value` は previous 保持 (Solid 互換)
  - pending 中の source 変化は既存 token race 機構 (`#token++`) で握り潰し
- **previous value**: source 変化 / refetch 中も `r.value` は前回 data を保持
  (Solid の stale-while-revalidate 互換)。reset したいケースは将来の
  `keepPreviousData: false` option 案件
- **bootstrap-hit と source の協調**: hit 引き当てたら applyBootstrapHit して
  state 確定、その後の source-tracking effect の **初回 invocation は skip**
  (二重 fetch 回避)。以降の source 変化は普通に re-fetch

## 論点と決定

### 論点 1: rename は alias 残すか即削除か

- 案 A: `resource` 新設 + `createResource` を deprecation alias として暫く残す
- 案 B (採用): `createResource` を即削除して `resource` 一本化

採用理由:

- 外部 user ゼロ (toy 段階、@vidro/\* npm publish 前)
- 内部 callsite も demo + tests のみで grep 一発
- alias を残すと両方が docs / 補完 / search で出てきて「どっちが正なのか」迷う
- ADR 0006 の factory 規約 + 本 ADR で「resource が canonical」と宣言する方が clean

### 論点 2: API shape (source の渡し方)

- 案 A: signal を直接受ける (`resource(userId, (id) => ...)`)
- 案 B (採用): function を受ける (`resource(() => userId.value, (id) => ...)`)
- 案 C: options.source field (`resource(fetcher, { source: () => userId.value })`)

採用理由:

- 案 B は **複数 signal の合成** が自然: `() => userId.value + tab.value`
- 案 B は computed を渡しても OK: `() => userIdComputed.value`
- 案 A は signal のみで computed / 多値合成が書けない
- 案 C は fetcher が source を二重に読む形になりがち + 引数構造が複雑

### 論点 3: gating sentinel

- 案 A (採用): `false` / `null` / `undefined` 全部受け入れ (Solid 互換)
- 案 B: `false` のみ
- 案 C: 専用の `RESOURCE_SKIP` sentinel

採用理由:

- Solid 互換で移植性◎、ユーザーが `userId.value > 0 && userId.value` のような
  short-circuit を書けば自然に `false` で gate
- `null` / `undefined` も gate にする方が「**値が無い時は fetch しない**」と
  いう意図表現が自然
- 専用 sentinel は学習コストの新項目を増やす

### 論点 4: previous value 保持か fallback

- 案 A (採用): refetch / source 変化中も `r.value` は前回 data 保持 (Solid 互換)
- 案 B: source 変化のたびに `r.value = undefined` にリセット
- 案 C: option で切り替え

採用理由:

- 案 A は「stale-while-revalidate」UX で快適 (古い data を見続けながら新 data を
  待つ)
- 案 B は flicker が出やすい
- 案 C は YAGNI、必要になったら option 追加

### 論点 5: bootstrap-hit と source effect の協調

server で `source()` を 1 回評価して fetcher(value) を register、client で hit
引き当て成功時:

- 既存 sourceless: hit → applyBootstrapHit、effect なし、refetch まで何もしない
- 新規 sourceful: hit → applyBootstrapHit、その後 source-tracking effect が走る
  → そのまま放置すると effect 初回 invocation で再 fetch してしまう (二重 fetch)

採用方針: **constructor で hit 引き当てた事実を記憶して、effect の初回
invocation を skip する**。以降の source 変化では普通に re-fetch。

```ts
let skipNext = startedWithHit; // bootstrap-hit が当たったかどうか
effect(() => {
  const value = source();
  if (skipNext) {
    skipNext = false;
    return;
  }
  this.#startFetch(value);
});
```

### 論点 6: gating 中に既存 fetch が pending だった場合

source = T (pending) → source = false (gate) に変わる場合:

- 採用: `#token++` で古い fetch を握り潰す + `loading=false` に戻す + `unregister`
  (Suspense scope から抜ける)
- これは pending 中に gate に切り替わったときの fallback ↔ children の戻りを
  正しく駆動する

### 論点 7: refetch() の動作

- sourceless: 既存通り、保存した fetcher を再実行
- sourceful: **直近 source value で再 fetch** (Solid 互換)。source value が
  gate なら refetch() は no-op
- これは「ユーザーが手動で再取得トリガを引きたい」ときの挙動として直感的

### 論点 8: render 時 vs 永続的な source 評価

source は constructor 内の effect で評価される。effect は **owner に紐付く**:

- JSX 内 (Show / Switch / For 等の中) で resource を作ると、その owner が
  dispose されたとき effect も dispose → source-tracking が止まる
- これは既存の effect / Resource の lifetime 規約と整合
- Suspense の children で resource を作る既存パターンも、Suspense の children
  Owner に紐付いて自動 cleanup

## 影響範囲

### コア

- `packages/core/src/resource.ts`: constructor を overload 解析 + source effect
- `packages/core/src/index.ts`: `createResource` → `resource` export 切替
- comment / doc 内の `createResource` 言及を `resource` に更新

### Tests

- `packages/core/tests/resource.test.ts`: 既存テストの `createResource` 呼び出しを `resource` に
- `packages/core/tests/resource-bootstrap.test.ts`: 同上
- `packages/core/tests/render-to-string-async.test.ts`: 同上
- `packages/core/tests/render-to-readable-stream.test.ts`: 同上
- `packages/core/tests/suspense.test.ts`: 同上
- 新規 `packages/core/tests/reactive-resource.test.ts`: reactive source 8 件
  - source 変化で auto refetch
  - gating (false / null / undefined) で fetcher skip
  - gating → 値で fetch 開始
  - pending 中に source 変化 → token race で旧 fetch 握り潰し
  - previous value 保持 (refetch 中の `r.value` は前回値)
  - `r.refetch()` で同 source value 再実行
  - Suspense + reactive source: source 変化で register / unregister
  - bootstrap-hit + reactive source: 二重 fetch 回避

### Demo

- `apps/router-demo/src/routes/users/[id]/index.tsx`: `createResource` →
  `resource` rename + 副菜 demo として `userId` signal 化 + reactive source 化
  (本 ADR の動作確認台)
- 実機 (wrangler + Playwright) で `/users/1` → `/users/5` navigation で
  posts が auto-refetch されることを確認

### ADR (歴史記録)

- 旧 ADR (0006 / 0025 / 0026 / 0027 / 0028 / 0029 / 0030 / 0031) は **書き換え
  ない**。当時の意思決定を改ざんしない。本 ADR で「以降は `resource` 名前」と
  宣言する形

## トレードオフ

- 即削除案を採用したので Solid からの mechanical 移植は sed 1 発が必要 (toy
  段階では問題なし)
- API surface が増える (overload 1 個追加) — 既存 callsite は影響なし、新規
  ユーザーは type-driven に発見可能
