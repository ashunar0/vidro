# Design Decisions

Vidro の実装で発生した設計判断を記録する場所。1 論点 = 1 ファイルで番号順に積む
(Architecture Decision Record / ADR スタイル)。

## 目的

- 「なぜそうしたか」を後から参照できるようにする
- 実装を読むだけではわからない **却下した案とその理由** を残す
- 暫定実装の場合、**将来書き換える条件** を明記しておく

**設計書 (`~/brain/docs/エデン 設計書.md`)** は「こう作りたい」の single source of truth。
このディレクトリはその下の粒度で「実装時に現れた細かい判断」を残す補助ドキュメント。
設計書レベルの決定はこちらではなく設計書側に書く。

## 書き方

各ファイルは `NNNN-<kebab-title>.md` で、以下のセクションを含める:

- **Status** — Accepted / Superseded / Deprecated のいずれか + 日付
- **Context** — 何を決める必要があり、なぜ判断が必要だったか
- **Options** — 検討した候補と、それぞれのトレードオフ
- **Decision** — 採用した案
- **Rationale** — なぜそれを採用したか (判断軸を明示)
- **Consequences** — 採用したことで発生する制約・将来の課題
- **Revisit when** — いつ見直すか (トリガーとなる条件)

Consequences と Revisit when は**暫定実装の場合は必ず書く**。

## インデックス

- [0001-batch](./0001-batch.md) — `batch(fn)` の実装方針 (queue + finally flush + re-throw)
- [0002-on-mount](./0002-on-mount.md) — `onMount(fn)` の実装方針 (同期 / warn / 伝播)
- [0003-ref](./0003-ref.md) — `Ref<T>` primitive の実装方針 (new Ref / `.current` / class + factory)
- [0004-error-boundary](./0004-error-boundary.md) — `<ErrorBoundary>` primitive の実装方針 (onError required / 関数 fallback / children 関数包み)
- [0005-switch-match](./0005-switch-match.md) — `<Switch>` / `<Match>` primitive の実装方針 (Match は descriptor / 早い者勝ち / fallback / invoke-once)
- [0006-factory-only-api](./0006-factory-only-api.md) — primitive 生成 API を factory 一本化、class を internal に (`new Signal(0)` 廃止 / 型は `export type` で残す)
- [0007-component-props-proxy](./0007-component-props-proxy.md) — A 方式 transform を component 境界まで貫通 (Proxy props + `_reactive` marker)
- [0008-error-tsx-convention](./0008-error-tsx-convention.md) — `error.tsx` 規約 + Router での error 統合 (階層的 lookup / `ErrorPageProps` / reset で loader 再実行)
- [0009-layout-loader-parallel-fetch](./0009-layout-loader-parallel-fetch.md) — `layout.server.ts` 規約 + 並列 fetch + `LayoutProps<L>` conditional (waterfall 解消、親 data → 子は提供しない、error 階層は MVP 単純化)
- [0010-layout-error-propagation](./0010-layout-error-propagation.md) — layout error を **層別外側** 伝播、layout render error を `ErrorBoundary` wrap、swap の DocumentFragment 対応 (0009 の MVP を格上げ)
- [0011-route-tree-type-generation](./0011-route-tree-type-generation.md) — Route tree 型生成 plugin (`@vidro/plugin` の `routeTypes()`) + props 完結方針 (useParams 不採用) + `LoaderArgs<R extends keyof Routes>` 拡張
- [0012-server-boundary-dev](./0012-server-boundary-dev.md) — `serverBoundary()` plugin (dev 版): `/__loader` HTTP RPC + client bundle stub + error hydrate (案 B Step 1-4)
- [0013-vidro-output-directory](./0013-vidro-output-directory.md) — 生成物置き場を `.vidro/` に集約、tsconfig base を `@vidro/plugin/tsconfig.base.json` で module extends 配布 (src/ 純化 + chicken-egg 回避)
- [0014-server-boundary-prod](./0014-server-boundary-prod.md) — prod 側 server boundary: route manifest 生成 + `@vidro/router/server` 切り出し + 2nd pass ssr build + `env.ASSETS.fetch` で SPA fallback (案 B-2 Step 1 全体まとめ)
- [0015-ssr-phase-a-bootstrap-data](./0015-ssr-phase-a-bootstrap-data.md) — SSR Phase A: navigation response の index.html に `__vidro_data` script を inject して初回 `/__loader` fetch をスキップ (HTML render は Phase B で追加予定)
- [0016-ssr-phase-b-universal-renderer](./0016-ssr-phase-b-universal-renderer.md) — SSR Phase B Step B-1: Universal renderer 抽象化 + fine-grained hydration 戦略 + object tree→string buffer 段階実装方針 (effect は server で 1 回走らせて捨てる)
