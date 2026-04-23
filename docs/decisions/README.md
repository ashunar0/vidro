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
