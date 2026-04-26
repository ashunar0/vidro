# 0022 — SSR Phase B Step B-3c-2: Show を server anchor + client renderer 経由

## Status

Accepted — 2026-04-27

## Context

ADR 0021 (Step B-3c-1) で ErrorBoundary を server anchor + client renderer
経由化した。同 pattern を Show / Switch / For に順次適用する計画 (B-3c-2/3/4)。
本 ADR は Show が対象。

ただし Show は ErrorBoundary と異なる構造的制約がある:

- **ErrorBoundary**: `children: () => Node` (関数で受ける、遅延評価)
- **Show**: `children?: Node` / `fallback?: Node` (Node で受ける、eager 評価)

これは ADR 0004 で「ErrorBoundary は B-1 (関数で包む) MVP、Show は普通の JSX
で受ける」と方針が分かれた経緯による。Show では `<Show fallback={<X />}>{<Y />}</Show>`
のように **inactive branch も含めて両方 eager 評価される** 構造になっている。

→ server で Show を render すると active branch のみ fragment に入れて inactive
は捨てるが、client の hydrate 時に JSX 評価で両方が renderer.createElement
等を呼んで cursor を消費しようとする。SSR markup には active 1 つしか出ない
ので **fallback ありケースは hydrate cursor mismatch** する。

完全な Show の hydrate 対応には、children / fallback も `() => Node` で受ける
API に変える必要があり、これは ADR 0004 の **B-4 (children getter 化、Suspense
と一緒)** の範疇。本 ADR では構造変更 (renderer 経由化 + server mode anchor)
までで止める。

## Options

### 論点 1: B-3c-2 の射程

- **1-a (フル hydrate 対応、children/fallback を getter API に変更)**: breaking、
  ADR 0004 の B-4 と被る。Show 単体で B-4 の半分を実装する形になり過剰
- **1-b (構造変更のみ、hydrate は fallback 無しシンプルケースのみ)**: ADR 0021
  と同 pattern を当てて renderer 経由化 + server anchor。fallback あり / 動的
  when の hydrate は B-4 で完成
- **1-c (B-3c-2 を skip して B-4 で一括)**: Show の構造変更も後回し。Switch /
  For も同じ理由で skip する形になる。B-3c が空に近くなる

### 論点 2: server mode の anchor 値

- **2-a (`<!--show-->`)**: Router の `<!--router-->`、ErrorBoundary の
  `<!--error-boundary-->` と同 pattern。debug しやすい
- **2-b (短 marker)**: bundle / markup size 削減

### 論点 3: server mode で when を読む方法

- **3-a (`typeof props.when === "function" ? props.when() : props.when`)**:
  signal の場合は proxy 経由で `.value`、関数 thunk なら call。`<Show when={() => count.value > 0}>`
  パターンと `<Show when={cond}>` パターンの両方をサポート
- **3-b (signal だけサポート)**: 関数 thunk は別 API (e.g. `<Show when={computed(...)}>`)
  に誘導。シンプルだが既存テスト互換性壊れる

### 論点 4: client mode の initial active 評価タイミング

- **4-a (effect の前に sync 評価して fragment に入れる、effect 初回 skip)**:
  ADR 0021 と同 pattern。renderer cursor 順 (active → anchor) と JSX 評価順を
  一致させる
- **4-b (effect 立ち上げ時に initial active も決める、initial 中で fragment に append)**:
  effect 内で fragment 操作することになり、effect dispose 時に DOM 残留する等
  semantics が複雑化

## Decision

- 論点 1 → **1-b (構造変更のみ、シンプルケース hydrate)**
- 論点 2 → **2-a (`<!--show-->`)**
- 論点 3 → **3-a (signal + 関数 thunk 両対応)**
- 論点 4 → **4-a (effect 前 sync 評価 + initialEffect skip)**

## Rationale

**1-b**: B-3c-2 の本質は「Show を renderer 経由 + server で anchor を吐く」
構造の確立。fallback あり / 動的 when の完全 hydrate 対応は B-4 (children
getter 化) の範疇で、本来 ADR 0004 で「Suspense と一緒に runtime 全面改修」と
決まっている。Show 単体で B-4 の半分を実装すると、Switch / For でも同じ
問題が出るし API 変更が散発的になる。

**2-a**: ADR 0020 (Router) / ADR 0021 (ErrorBoundary) と同 pattern。
human-readable の方が router-demo の view-source 等で debug しやすい。

**3-a**: 既存テスト (`Show({ when: cond, ... })` 直接呼びと `() => count.value > 0`
パターン両方) を壊さないよう、signal proxy / 関数 thunk 両対応の判定を入れる。
proxy 経由で `props.when` を読むと marker 付き reactive thunk なら自動展開、
それ以外 (signal インスタンス、boolean、関数) は raw が返る (ADR 0007)。
関数の場合は call、それ以外はそのまま truthy 判定。

**4-a**: ADR 0021 と同様、cursor 順整合のため initial active を effect 前に
sync 評価。effect 初回は `initialEffect` フラグで skip。effect は dependency
登録のため body 内で `props.when` を読む必要があるので skip 後の return で
代替する。

## Consequences

### 完了したこと (B-3c-2 縮小スコープ)

- **`packages/core/src/show.ts` 改修**:
  - server mode 分岐を追加: `when` を sync 評価 → active branch + `<!--show-->`
    anchor を fragment で返す。inactive branch は捨てる
  - client mode (mount / hydrate 共通): initial active を effect 前に sync
    評価して fragment に append。anchor / fragment / appendChild を
    `getRenderer()` 経由に
  - effect の初回 invocation は `initialEffect` フラグで skip (initial state
    既に setup 済み)
- **テスト**:
  - `core/tests/hydrate.test.ts` に Show hydrate test を 2 件追加:
    - `Show: when 静的 true で children を hydrate` (B-3c-2 で動く)
    - `Show: when 静的 false + fallback 無し` (server markup の確認のみ、
      hydrate 自体は children Node が h() で評価されて cursor 消費するので
      mismatch する → SSR markup 確認だけ)
  - `core/tests/show.test.ts` 7 件は **改修前と挙動互換** (5 pass / 2 fail
    pre-existing。B-3c-2 で +1 pass、新規 fail 無し)
- **router-demo**: Show を使ってないので影響無し

### B-3c-2 で動かない hydrate ケース (B-4 まで持ち越し)

- `<Show fallback={<X />}>{<Y />}</Show>`: fallback と children が両方 eager
  評価される。SSR markup には active 1 つしか出ないので cursor mismatch
- `<Show when={cond}>{<X />}</Show>` (signal-driven、fallback 無し): server
  と client で同じ初期値なら動くが、children が常に評価されるので server で
  active 無しケースだと cursor 消費過剰
- 解決策: B-4 で children / fallback を getter `() => Node` で受ける API に
  変更し、Show 内部で active branch のみ評価する形に。Suspense と一緒に runtime
  全面改修

### server / client bundle への影響

- server mode 分岐 + initialEffect フラグで微増 (~30 行)
- bundle: core 11 files / 61.86 kB → 同等 (0.5kB 微増)
- server markup: Show 出現箇所ごとに `<!--show-->` 1 個追加 (router-demo は
  Show を使ってないので影響無し)

## ADR 0019 Revisit when の訂正

「Show / Switch の anchor 対応で」項を **本 ADR で Show のみ部分対応** に
更新:

- ~~server renderer に anchor comment 出力モードを追加~~ → Show については完了
- ~~client の primitive (show.ts) を hydrate モードで cursor から anchor を
  消費する形に対応~~ → Show については完了
- ただし fallback あり / 動的 when の完全 hydrate は B-4 まで持ち越し

## 関連 ADR

- 0004: ErrorBoundary primitive 設計 (children getter 化は B-4)
- 0007: Component props proxy
- 0016: Universal renderer 抽象
- 0019: hydrate primitive (本 ADR で Show 部分を更新)
- 0021: ErrorBoundary を server anchor + client renderer 経由 (B-3c-1、本 ADR
  と同 pattern)
- 次: Step B-3c-3 — Switch を同 pattern で対応
