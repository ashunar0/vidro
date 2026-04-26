# 0023 — SSR Phase B Step B-3c-3: Switch を server anchor + client renderer 経由

## Status

Accepted — 2026-04-27

## Context

ADR 0022 (Step B-3c-2) で Show を server anchor + client renderer 経由化した。
同 pattern を Switch (および Match) に適用する。Switch は内部で Match
descriptor を集めて、最初に true な when の child を mount する多分岐
primitive。

Show と同じ構造的制約を持つ:

- **Match の child / Switch の fallback は eager 評価された Node** で受ける
- `<Switch><Match when={a}>{<X />}</Match><Match when={b}>{<Y />}</Match></Switch>`
  だと **すべての Match の child が** h() 引数評価で作られる
- SSR markup には active 1 つしか出ないので hydrate cursor mismatch する
  ケースが多い

完全な hydrate 対応には B-4 (children getter 化) が必要。本 ADR では構造変更
(renderer 経由化 + server mode anchor) のみで止める。

## Options

論点と decision は ADR 0022 (Show) とほぼ同じ。Switch 固有の論点だけ追記:

### 論点 A: Match descriptor 自体は変更するか

- **A-1 (現状維持)**: Match は MATCH_SYMBOL 付き descriptor を返すだけで、
  DOM は作らない。renderer 経由化や server mode 分岐は **Switch 側で行う**
  ため Match に追加 logic は不要
- **A-2 (Match も server で何か吐く)**: 例えば Match anchor を吐いて、
  Switch がそれを使う形。hydrate での cursor 整合に使える可能性があるが、
  inactive Match に対する anchor は意味が曖昧

→ **A-1 採用**。Match は lightweight な descriptor 専念で、Switch 側に集約
する設計を維持。

### 論点 B: server / client mode で Match.readWhen() の評価方法

- **B-1 (Show と同じく `typeof w === "function" ? w() : w`)**: signal proxy /
  関数 thunk 両対応。既存テスト互換性維持
- **B-2 (関数 thunk 専用化)**: breaking、簡素

→ **B-1 採用**。ADR 0022 と整合。

## Decision

- ADR 0022 (Show) の論点 1 / 2 / 3 / 4 と同じ判断 (1-b 縮小スコープ /
  `<!--switch-->` anchor / signal + thunk 両対応 / effect 前 sync 評価 +
  initialEffect skip)
- 論点 A → A-1 (Match descriptor は変更しない)
- 論点 B → B-1 (signal + thunk 両対応)

## Rationale

Show (ADR 0022) と同じ。Switch 単体で B-4 の半分を実装すると Match descriptor
の API も変更することになり過剰。本 ADR では「Switch を mount / hydrate /
server-render 全 mode で renderer 経由」という構造変更のみに射程を絞る。

## Consequences

### 完了したこと (B-3c-3 縮小スコープ)

- **`packages/core/src/switch.ts` 改修**:
  - server mode 分岐追加: 各 Match の readWhen を sync 評価 → active child or
    fallback + `<!--switch-->` anchor を fragment で返す
  - client mode (mount / hydrate 共通): initial active を effect 前に sync
    評価して fragment に append、anchor / fragment / appendChild を
    `getRenderer()` 経由に
  - effect の初回 invocation は `initialEffect` フラグで skip
  - Match descriptor 自体は変更なし
- **テスト**:
  - `core/tests/hydrate.test.ts` に Switch hydrate test を 2 件追加 (Match
    1 個 + when 静的 true / 全 Match false + fallback 無し SSR markup 確認) →
    hydrate 13/13 全 pass
  - `core/tests/switch.test.ts` 8 件は **改修前と挙動互換** (6 pass / 2 fail
    pre-existing。新規 fail 無し)
- **router-demo / router**: Switch を使ってないので影響無し

### B-3c-3 で動かない hydrate ケース (B-4 まで持ち越し)

- 複数 Match を持つ `<Switch>`: inactive Match の child も h() で評価される
  ので cursor 過剰消費 → mismatch
- fallback ありで全 Match false が動的に変わるケース: Show と同じ問題
- 解決策: B-4 で Match の child / Switch の fallback を `() => Node` getter
  API に変更。Suspense と一緒に runtime 全面改修

### server / client bundle への影響

- server mode 分岐 + initialEffect フラグで微増 (~30 行)
- bundle: 微増 (Switch は website でのみ使われていて router-demo にはない)
- server markup: Switch 出現箇所ごとに `<!--switch-->` 1 個追加

## ADR 0019 Revisit when の訂正

「Show / Switch の anchor 対応で」項を **本 ADR で Switch 部分も対応** に
更新。完全 hydrate (複数 Match / fallback あり) は B-4 まで持ち越し。

## 関連 ADR

- 0004: ErrorBoundary primitive 設計 (children getter 化は B-4)
- 0007: Component props proxy
- 0016: Universal renderer 抽象
- 0019: hydrate primitive (本 ADR で Switch 部分を更新)
- 0021: ErrorBoundary を server anchor (B-3c-1)
- 0022: Show を server anchor (B-3c-2、本 ADR と同 pattern)
- 次: Step B-3c-4 — For を同 pattern + dynamic array の anchor 表現を考慮
