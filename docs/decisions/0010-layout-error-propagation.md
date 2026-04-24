# 0010 — layout error の階層伝播 + layout render error の ErrorBoundary wrap

## Status

Accepted — 2026-04-24

## Context

ADR 0009 (Phase 3 第 2 弾) では、layout loader の並列 fetch を優先し、error 処理は
**MVP 単純化** で済ませた:

- loader error は「pathname に match する最寄り error.tsx」で置換
- layout の render error は **catch してない** (effect の `.catch()` に fall through)

実運用や回帰テスト用 route (`/broken-loader`, `/broken-render`) を入れた時点で問題が
顕在化する:

1. **内側 error.tsx が誤って使われる**: `users/layout.server.ts` の loader が throw
   したとき、`users/error.tsx` は users layout の内側にあるので本来は使えない
   (その users layout 自身が mount できないのに、その中身である users/error.tsx を
   render することはできない)。外側の root error.tsx を使うのが正しい
2. **layout render error がそのまま Router effect の `.catch()` に突き抜ける**: default
   error 表示になってしまう (ErrorBoundary 側の catch 機構が効かない)

Phase 3 第 3 弾 (ADR 0010) として、これらを正式版に格上げする。

## Options

### 論点 1: error.tsx の選び方ルール

- **A.** leaf / layout とも **最寄り** (pathname に match する深い prefix 優先)
  - 現状 MVP (ADR 0009)、layout error では間違った error.tsx が使われる
- **B.** layer ごとに **外側** (error 発生 layer の pathPrefix より厳密に短い中で最深)
  - Remix / SvelteKit と同じ
  - leaf loader error はそのまま「最寄り」で OK (leaf 自身は layer 内側に error.tsx
    を持たないので、B と A が同じ結果になる)

### 論点 2: 「外側 error.tsx」の表現方法

- **A.** `MatchResult.error: ErrorEntry | null` のまま、Router 側で逐次 filter
  - 複数候補を動的に探すため、毎回 compile 済み errors から `filter`
- **B.** `MatchResult.errors: ErrorEntry[]` に変更 (深い → 浅い順)
  - pathname match を 1 回で確定させ、Router は index ベースで選択
  - preload が 1 発で済む (全候補を Promise.all でまとめて lazy load)

### 論点 3: layout render error の wrap 方法

- **A.** 各 layout の default() 呼び出しを `ErrorBoundary` で個別に wrap
  - layer 単位で fallback を選べる (外側 error.tsx を呼び出せる)
  - closure capture (`const inner = node`) に注意する必要がある
- **B.** Router effect 内で try/catch で layout.default() を囲む
  - async error と sync error を混ぜて扱うハメになり、fallback の owner 管理が不透明
- **C.** 最外側に 1 個だけ ErrorBoundary (現状 leaf のみの方針を引き継ぐ)
  - layer ごとの error.tsx 選び分けができない

## Decision

- 論点 1 → **B (layer ごとに外側)**
- 論点 2 → **B (errors: ErrorEntry[] 配列)**
- 論点 3 → **A (layout ごとに ErrorBoundary wrap)**

### error.tsx 選択ルール

```ts
selectErrorMod(layerPathPrefix: string | null): ErrorModule | null
```

- `layerPathPrefix === null` (leaf): `match.errors[0]` (最寄り = 最深)
- `layerPathPrefix !== null` (layout[i]): `match.errors` の中で `pathPrefix` が
  layerPathPrefix より**厳密に短い**ものから最深 (= 配列先頭に近い順に走査して最初に
  条件を満たすもの、`match.errors` は深い → 浅い順なので find 相当)

### wrapLayout helper

```ts
const wrapLayout = (
  layoutMod: RouteModule,
  layerPathPrefix: string,
  data: unknown,
  children: Node,
): Node =>
  ErrorBoundary({
    fallback: (err) => renderError(err, selectErrorMod(layerPathPrefix), match.params),
    onError: (err) => console.error("[router] layout render error:", err),
    children: () => layoutMod.default({ params: match.params, data, children }),
  });
```

fold ループで leaf + 各 layout を 1:1 で `ErrorBoundary` wrap する。`children` を
関数引数として明示的に closure に凍結し、ループ変数 `node` の再代入による captured
variable の意図しない共有を避ける。

### preload

全 `match.errors` を Promise.all で並列 preload。個別 load 失敗は `.catch(() => null)`
で吸収し、`errorMods[i]` が null だった場合は `selectErrorMod` が自然に次の候補を
skip できる設計 (ADR 0008 の `match.error.load().catch(() => null)` と同じ考え方)。

## Rationale

### 論点 1: B (layer ごとに外側)

- Remix / SvelteKit / Next.js App Router いずれも同じ挙動
- 「`users/error.tsx` は users layout の内側」という空間的事実に反するルールを
  framework が設計として矛盾させない方が、user のメンタルモデルが保たれる
- leaf loader error は A / B 同じ結果になるため、leaf を特例扱いする必要がない
  (`layerPathPrefix === null` → errors[0] = 最寄り は B ルールの自然な退化)

### 論点 2: B (errors 配列)

- 選び分けロジックが Router 側に来るので、match 結果は候補を「順序付きリスト」として
  渡す方が素直 (決定は動的、候補は静的)
- preload を `Promise.all` で 1 回に畳めるため、layer 切替時の race / stale 対策が
  単純化できる (errors ごとに別 promise を持ち回す必要がない)
- MatchResult が中立化 (= 「最寄り 1 個」という意味論的な選り好みを持たない) し、
  将来 custom 選び方を入れる余地が残る

### 論点 3: A (layer 単位の ErrorBoundary)

- layer ごとに fallback が異なる (外側 error.tsx が違う) ため、1 個の ErrorBoundary
  では役割を果たせない。layer 単位が必要
- ADR 0004 で「ErrorBoundary の children は関数で boundary の Owner scope を set
  してから評価」という設計を踏襲できるので、同 pattern の多重ネストは構成可能
- closure capture (`const inner = node`) は古典的 JavaScript gotcha だが、ループ内で
  毎回新変数を切る pattern で明示的に回避できる
- B (try/catch) は sync error にしか効かないうえ、Owner chain を自分で管理する必要
  があり保守性が低い
- C (最外側 1 個) は論点 1 の decision (layer ごとに外側 error.tsx) と噛み合わない

## Consequences

### 実装

- `route-tree.ts`:
  - `MatchResult.error: ErrorEntry | null` → `errors: ErrorEntry[]` (深い → 浅い順)
  - `matchRoute` で全 match 候補を sort して返す
- `router.tsx`:
  - swap 関数を `currentNode: Node` から `currentNodes: Node[]` に変更。
    **DocumentFragment を swap に渡すと展開時に空になるので、insertBefore 前に
    `Array.from(fragment.childNodes)` で子要素を退避**。最外側が ErrorBoundary の
    fragment になるケースで currentNode.removeChild が効かずに前回 DOM が残る
    バグを修正 (Phase 3 第 3 弾で顕在化)
  - 全 `match.errors` を `Promise.all` で並列 preload (個別 `.catch(() => null)`)
  - `selectErrorMod(layerPathPrefix)` helper 追加
  - `wrapLayout(layoutMod, layerPathPrefix, data, children)` helper 追加
  - loader error 経路・通常経路ともに fold ループで `wrapLayout` を使い統一
  - loader error 時の error.tsx 選択も `selectErrorMod(errorLayerPrefix)` に差し替え

### 挙動の変化 (破壊的でないが観察可能)

- **layout loader error** で、以前は内側 error.tsx が使われていたケースが **外側**
  error.tsx に切り替わる (ADR 0009 の MVP を upgrade)
- **layout render error** が**初めて catch されるようになる** (以前は default error)
- **leaf loader / render error** は従来と同じ (最寄り error.tsx)
- 既存 demo (`/users/1`, `/users/999`, `/does-not-exist`) の挙動は regression なし

### 内側 error.tsx の意味

`users/error.tsx` などの内側 error.tsx は:

- leaf route (`users/[id]/index.tsx` の render error / loader error) で使われる
- users layout **自身** の error では使われない (外側が勝つ)
- `users` 配下の **より深い layout** の error でも、その layout より外側なら
  使われる余地がある (例: `users/posts/layout.tsx` の error は users/error.tsx で
  catch される)

この選び分けは `pathPrefix` 長さ比較だけで決まるので、user は「layout の内側には
error.tsx を置かない」という暗黙ルールを覚える必要がない (自然に正しい結果になる)。

### 設計書への影響

- 5 節「error handling」に「層別に外側 error.tsx を採用」と明示
- 3.5 の routing 節は既に layout.server.ts を 5 種類に含めてあり、追加変更は軽微

## Revisit when

- **streaming / Suspense 導入時**: 並列 fetch の結果が揃う前に外側 layer から先に
  render する場合、wrapLayout の fallback が stream 中の error に対しても一貫して
  動くかの検証が要る (placeholder 表示中に error が来たときの UX)
- **親 data → 子 loader のアクセス API を追加する時** (ADR 0009 Revisit 参照):
  loader 間の依存がある場合の error 伝播ルールを再設計する必要がある (parent error
  で child loader を呼ばない等)
- **layout の onMount / onCleanup が加わった時**: mount 失敗 (effect が throw) を
  layer ErrorBoundary が catch するかの挙動検証、および fallback 表示後の cleanup
  一貫性
- **error.tsx の selection に custom 判定を入れたい時**: status code / error 種別
  (NotFoundError, AuthError 等) で使う error.tsx を分岐させたくなった場合、
  `MatchResult.errors` の配列モデルに「判別関数」を挟める設計余地はあるが、現状の
  pathPrefix 単純比較が破綻する可能性あり
