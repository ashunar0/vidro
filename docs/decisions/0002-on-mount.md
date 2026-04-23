# 0002 — `onMount(fn)` の実装方針

## Status

Accepted (暫定) — 2026-04-23

**複数の論点が「将来書き換える前提」で暫定採用** されている。Revisit when を参照。

## Context

Effect だけでは「DOM が document に attach された直後に一度だけ走らせたい」
ユースケースを綺麗に書けない。Effect の body は依存追跡が走ってしまうし、
DOM 計測 (`getBoundingClientRect()`) や `focus()` は要素が document にいないと
正しく動かない。

Vidro に `onMount(fn)` を追加する。論点は 3 つ:

1. **発火タイミング** — 同期 / microtask / requestAnimationFrame のどれ
2. **scope 外での呼び出し** — silent / warn / throw のどれ
3. **fn が throw した時** — 伝播 / 握って log / ErrorBoundary に渡す のどれ

## Options

### 論点 1: 発火タイミング

- **A. 同期** — `mount()` が `appendChild` した直後、同一 tick で fn を実行
- **B. microtask** — `queueMicrotask` で次の tick に
- **C. requestAnimationFrame** — layout / paint 後

### 論点 2: scope 外での呼び出し

- **A. silent** (no-op)
- **B. warn** (console.warn で警告して no-op)
- **C. throw**

### 論点 3: fn が throw した時

- **A. 伝播** (uncaught、mount の呼び出し元まで届く)
- **B. 握って console.error** (他の onMount は走り続ける)
- **C. ErrorBoundary に伝播** (ErrorBoundary primitive が必要)

## Decision

- 論点 1 → **A (同期 / appendChild 直後)**
- 論点 2 → **B (warn)**
- 論点 3 → **A (伝播)**

## Rationale

### 論点 1: 同期

- 各 FW の実装を調査:
  - Solid / Vue / Svelte — 同期 (DOM attach 直後)
  - React — `useLayoutEffect` (同期 / paint 前) と `useEffect` (非同期 / paint 後) に 2 分割
- 代表的ユースケース (DOM 計測 / `focus()` / 外部ライブラリ初期化) は同期で済む
  (ブラウザは `getBoundingClientRect` 読みで force layout するため)
- async 版が必要なら後から別 API (`onAfterPaint` 等) で追加できる。先に同期を
  出す方が「ユーザーが上書きできる側を細かく提供」の原則に沿う
- **判断軸**: 80% ユースケースの最小実装、将来の拡張余地

### 論点 2: warn

- silent (Solid / Svelte) はバグが潜伏する
- throw (React の Rules of Hooks) は production で画面が真っ白になる強さ
- warn は「正しく使ってる限り副作用ゼロ + 気づける」の中庸
- **判断軸**: toy 段階では「静かに動く」より「声を上げて壊れる」を優先

### 論点 3: 伝播

- 本来は **ErrorBoundary で catch** が技術的に最良 (他の onMount を邪魔しない +
  UI でエラー表示)。React / Solid / Vue はこれ
- しかし Vidro に ErrorBoundary primitive がまだ無い。握るとログに出るだけで
  誰も気づかない状態になる
- 現段階では伝播 (uncaught) が「気づきやすさ」の点で最良
- **判断軸**: ErrorBoundary 未導入という制約下での最良手

## Consequences

- `insideMount: boolean` flag と `pendingMounts: Array<() => void>` が global に増える
  (batch と同様に per-instance 化は未対応)
- 現状「async 版 onMount」は存在しない。paint 後に走らせたい処理は
  `onMount(() => requestAnimationFrame(() => ...))` でユーザーが書く
- onMount 内で throw すると、**後続の onMount が走らない**。ユーザー側で
  try/catch を書く必要あり

## Known gotchas

### Show の fallback 側では onMount の DOM 操作が効かない

`<Show when={...} fallback={<Todo />}>` のような構造で、**fallback 側のコンポーネント内**
で `onMount(() => input.focus())` のような DOM 操作を書いた場合、**それは no-op になる**。

理由:

1. App の mount() 実行中、JSX 評価で children と fallback は**両方とも**呼ばれる
   (Show は invoke-once モデルで Node を事前に全部作る)
2. Todo() の中で onMount(fn) が queue に積まれる
3. mount() が target.appendChild した後、flushMountQueue で fn が走る
4. **この時点で Todo の DOM は Show の detach 側**。document tree に繋がっていない
5. 繋がっていない要素への `focus()` / `getBoundingClientRect()` は効かない
6. その後 Show の切替で Todo が attach されても、**onMount は再発火しない** (1 回きり)

回避策:

- 「タブ切替時」等の動的 attach に反応したいなら onMount ではなく Effect で切替用
  Signal を watch する方が適切 (ただし依存追跡に乗るので注意)
- 単純な「ページロード時の初期 focus」なら HTML 標準の `autofocus` 属性が最短
- **デモ/開発で気づきづらい**ので、ref 経由の DOM 操作を書く時は「この要素は
  root mount 時に DOM tree にいるか」を確認する

これは「Vidro のコンポーネントはリマウントしない」という invoke-once 設計の直接的な
帰結であり、仕様。将来 `onAttach` / `onDetach` のような attach/detach hook を導入する
場合はここで吸収される。

## Revisit when

以下が起きたら再設計:

- **ErrorBoundary primitive を追加した時**: 論点 3 を「ErrorBoundary に伝播」に
  変更。握って ErrorBoundary に渡す実装に書き換え
- **paint 後の hook が必要なユースケースが複数出た時**: `onAfterPaint` (仮) を
  別 API として追加、または React 流に 2 API (`onMount` 同期 + `onAfterPaint` async) に
- **production build を作る時**: 論点 2 の warn を production では剥がす build
  flag 分岐を追加
- **SSR / Worker で複数インスタンスが必要になった時**: global state を
  per-instance 化
- **attach / detach 系 hook (`onAttach` / `onDetach`) が必要になった時**: Show / For
  の切替で動的に DOM tree 出入りするコンポーネントに対して hook を発火させる仕組みを
  別途導入 (上記 gotcha の根本解決)
