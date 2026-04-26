# 0024 — SSR Phase B Step B-3c-4: For を server anchor + client renderer 経由 (B-3c 一巡完了)

## Status

Accepted — 2026-04-27

## Context

ADR 0021 (ErrorBoundary) / 0022 (Show) / 0023 (Switch) で anchor primitive
群を server anchor + client renderer 経由化してきた。本 ADR は For が対象で、
B-3c の最終 step。

For は他 primitive と異なり、**children が `(item: T, index: number) => Node`
の関数で受ける** 構造。これは Show / Switch の eager 評価された Node とは
違う性質で、**inactive children の eager 評価問題が無い** ことを意味する。
各 item ごとに children 関数を呼んで Node を作るので、server / client / hydrate
で同じ評価結果になる。

ただし `fallback` だけは Show / Switch と同じく eager 評価された Node で
受ける。`<For each={list} fallback={<X />}>` で list が非空のとき、fallback
Node も h() で作られて cursor 過剰消費 → mismatch する。完全 hydrate 対応は
Show / Switch と同じく B-4 (children getter 化) で fallback も `() => Node`
化する必要がある。

## Options

論点と decision は ADR 0022 (Show) / ADR 0023 (Switch) と概ね同じ。For 固有
の論点だけ追記:

### 論点 A: anchor 表現

- **A-1 (For 全体に anchor 1 個 `<!--for-->`)**: items を anchor の前に並べる
  シンプル構造。Show / Switch と統一感
- **A-2 (各 item に anchor `<!--for-N-->`)**: keyed reconciliation で各 item
  の境界を明示。並び替えが楽だが、SSR markup に anchor が大量に出る
  (`<li>...</li><!--for-0--><li>...</li><!--for-1-->...`)。bundle / markup
  size 不利

→ **A-1 採用**。並び替えは元々 `parent.insertBefore(node, anchor)` で行って
おり、anchor 1 個でも問題ない。SSR markup を最小化。

### 論点 B: 各 item の child Owner

- **B-1 (`new Owner(null)`、parent と切り離し、現状維持)**: keyed reconciliation
  で個別 dispose するため、parent owner には登録しない設計。エラー伝播は
  ErrorBoundary に任せる
- **B-2 (parent owner にぶら下げる)**: Owner tree が綺麗だが個別 dispose と
  competing。reconciliation logic を書き直す必要

→ **B-1 採用**。元の設計を維持。anchor 系 hydrate の話と独立。

### 論点 C: server mode で `each` を読む方法

- **C-1 (`props.each` をそのまま array として使う)**: Show / Switch の when
  と違って、each は配列。proxy / signal 展開 / 関数 thunk のいずれであっても
  最終的に array が手に入れば良い。h() proxy で marker 付き thunk なら自動
  展開される (ADR 0007)
- **C-2 (signal や thunk を明示的に判定)**: For の signature を厳密に。
  既存テストの直接呼び (`For({ each: signal(...) })`) は pre-existing fail
  なので無視

→ **C-1 採用**。proxy 経由で h() から渡される each は配列に展開される想定。
直接呼び (pre-existing fail) は将来 API として規約化する別 issue。

## Decision

- ADR 0022 / 0023 の論点 1 / 2 / 3 / 4 と同じ判断 (1-b 縮小スコープ /
  `<!--for-->` anchor / proxy 経由 each / effect 前 sync 評価 + initialEffect
  skip)
- 論点 A → A-1 (anchor 1 個)
- 論点 B → B-1 (各 item は parent と切り離し owner)
- 論点 C → C-1 (each は array として扱う)

## Rationale

For は children が関数で受けるため、本来 hydrate と相性が良い。fallback
だけが eager 評価される問題は Show / Switch 共通で B-4 まで持ち越す。それ
以外 (list 非空 + fallback 無し / 空リスト + fallback あり) のケースは
B-3c-4 の範囲で hydrate 動作する。

anchor 1 個 (`<!--for-->`) は「For block の終端マーカー」として最小コスト。
keyed reconciliation の境界は内部 entries Map で管理しているので、個別 anchor
は冗長。

## Consequences

### 完了したこと (B-3c-4 縮小スコープ)

- **`packages/core/src/for.ts` 改修**:
  - server mode 分岐追加: each を sync 評価 → 各 item に children() 呼んで
    Node 化 + `<!--for-->` anchor を fragment で返す。空リストなら fallback
    のみ + anchor
  - client mode (mount / hydrate 共通): initial entries を effect 前に sync
    構築、anchor / fragment / appendChild を `getRenderer()` 経由
  - effect の初回 invocation は `initialEffect` フラグで skip
  - keyed reconciliation logic / Owner 管理は変更なし
- **テスト**:
  - `core/tests/hydrate.test.ts` に For hydrate test を 3 件追加:
    - `For: list 非空 + fallback 無し で hydrate` (動く ✓)
    - `For: 空リスト + fallback あり で hydrate` (動く ✓)
    - `For: 空リスト + fallback 無し は anchor のみ SSR` (markup 確認のみ)
  - hydrate test 全 16/16 pass
  - `for.test.ts` 8 件は **改修前と挙動互換** (全 pre-existing fail。新規 fail 無し)
- **router-demo / router**: For を使ってないので影響無し

### B-3c-4 で動かない hydrate ケース (B-4 まで持ち越し)

- `<For each={list} fallback={<X />}>` で list 非空: fallback が h() で eager
  評価されて cursor 過剰消費 → mismatch
- 解決策: B-4 で fallback を `() => Node` getter API に。Show / Switch と同
  pattern

### server / client bundle への影響

- server mode 分岐 + initialEffect フラグで微増 (~30 行)
- bundle: core ~67 kB (For は website でのみ使われていて router-demo にはない)
- server markup: For 出現箇所ごとに `<!--for-->` 1 個追加

## ADR 0019 Revisit when の訂正

「For の dynamic array → B-3c 候補」項を **本 ADR で部分対応** に更新。
fallback ありで list 非空のケース完全 hydrate は B-4 まで持ち越し。

## B-3c (一巡) のまとめ

ADR 0021 ~ 0024 で 4 つの anchor primitive (ErrorBoundary / Show / Switch /
For) を全て server anchor + client renderer 経由化した:

| primitive     | anchor                  | 完全 hydrate | B-4 持ち越し条件                                 |
| ------------- | ----------------------- | ------------ | ------------------------------------------------ |
| ErrorBoundary | `<!--error-boundary-->` | ✓            | (children は元々関数)                            |
| Show          | `<!--show-->`           | △            | fallback あり / inactive eager 評価              |
| Switch        | `<!--switch-->`         | △            | 複数 Match / fallback あり / inactive eager 評価 |
| For           | `<!--for-->`            | △            | fallback あり (children は関数で OK)             |

→ B-3c の構造変更は完了。次は **B-4 (Suspense + JSX runtime children getter
化)** で Show / Switch / For の fallback / inactive children を `() => Node`
getter 化 → 完全 hydrate 達成 → **B-3d (main.tsx を hydrate に切替)** で
blink 解消。

## 関連 ADR

- 0004: ErrorBoundary primitive 設計 (children getter 化は B-4)
- 0007: Component props proxy
- 0016: Universal renderer 抽象
- 0019: hydrate primitive (本 ADR で For 部分を更新、B-3c 一巡完了)
- 0021/0022/0023: ErrorBoundary / Show / Switch (B-3c-1/2/3、本 ADR と同 pattern)
- 次: Step B-4 — Suspense primitive 導入 + JSX runtime children getter 化
  (ADR 0004 論点 5 の本命課題)
