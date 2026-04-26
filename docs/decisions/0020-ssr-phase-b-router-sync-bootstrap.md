# 0020 — SSR Phase B Step B-3b: Router の sync 初期化 + server anchor + B-3b 縮小スコープ

## Status

Accepted — 2026-04-27

## Context

ADR 0019 (Step B-3a) で hydrate primitive が入り、Revisit when に「Step B-3b
で Router の hydrate 対応 (sync 初期化 + anchor primitive 対応 + main.tsx を
hydrate に切替) を行う」と書いた。実際に着手すると、ADR 0019 自身の
Consequences 「ErrorBoundary / Show / Switch / For / Router を含む component
は hydrate できない」と Revisit when が部分的に矛盾していて、main.tsx の
hydrate 切替には更に深い前提条件が必要だと分かった。

具体的には 2 つの構造的問題が表面化した:

1. **ErrorBoundary が renderer を経由しない直接 DOM API**: `error-boundary.ts`
   client 経路が `document.createComment` / `document.createDocumentFragment`
   を直接呼んでおり、HydrationRenderer の cursor を消費しない。SSR で
   `<!--error-boundary-->` を吐いていないので markup mismatch も起きないが、
   anchor を server で吐く設計にしようとすると ADR 0017 の `isServer` 分岐
   (server で anchor 出さない) を逆転する必要がある
2. **foldRouteTree の評価順 vs SSR markup の depth-first 順のズレ**: layout の
   children として leaf を渡す inside-out fold だと、JSX の評価順は
   「leaf を先に展開 → 外側 layout を評価」になる。一方 SSR markup の
   post-order traversal は「外側から depth-first」。`<RootLayout>` の中で
   `{children}` を埋め込む時点で内側 ErrorBoundary が render される現在の
   構造では、cursor 順序が一致しない (Playwright で `expected <h2>, got <h1>`
   tag mismatch を確認)

問題 2 は ADR 0004 (ErrorBoundary) 論点 5 の「JSX runtime children getter 化
(B-4)」そのもので、ADR 0004 では「`<Suspense>` 等、他の遅延評価 primitive を
入れる時に一緒にやる方が効率的」と判断されている。`project_pending_rewrites`
にも「ブロッカー: `<Suspense>` など children 遅延評価を要する別 primitive が
出るまで待つ (ErrorBoundary 単体で runtime 全面改修はオーバースペック)」と
記録されている。

→ B-3b で main.tsx を hydrate に切替えると、ADR 0004 の「B-4 は Suspense と
束ねる」哲学と矛盾する。**B-3b の射程を ADR 0019 Consequences に合わせて
縮小**するのが過去判断と整合する。

## Options

### 論点 1: B-3b の射程

- **1-a (ADR 0019 Revisit when 通り、フルセット)**: Router sync 初期化 +
  anchor 対応 + ErrorBoundary 修正 + foldRouteTree 評価順解決 + main.tsx 切替。
  ErrorBoundary 単体改修が必要になり ADR 0004 の「B-4 は Suspense と束ねる」
  哲学を破る
- **1-b (Consequences 通りに縮小)**: Router を hydrate-ready な構造にする
  だけ (sync 初期化 + server で anchor 出力)。main.tsx は mount のまま。
  hydrate 切替は ErrorBoundary 対応 (B-3c) + B-4 (children getter 化) の後の
  B-3d 以降
- **1-c (B-3b 自体を skip して B-4 まで進める)**: Router の sync 初期化も
  保留し、Suspense + B-4 + 一連の anchor 対応をまとめて B-4 として実装。
  toy runtime の段階では一気に大きいワークになる

### 論点 2: Router 内 sync 初期化機能を保持するか

- **2-a (保持)**: `eagerModules` prop + `resolveModulesSync` を残す。
  hydrate 経路で使われない unused code が積まれるが、B-3d で main.tsx を
  hydrate 化する時にすぐ使える
- **2-b (削除)**: B-3b を完全に skip 扱いにし、Router 構造変更も rollback。
  YAGNI 寄り

### 論点 3: server で `<!--router-->` anchor を吐く判断

- **3-a (吐く、今回の実装通り)**: hydrate 経路で必要になるのが確定なので、
  先行して入れる。markup に comment 1 個増える小コスト
- **3-b (吐かない、rollback)**: 2-b と同じく完全 rollback

### 論点 4: ADR 0019 Revisit when の扱い

- **4-a (この ADR で上書き判断を残す)**: ADR 0019 自体は触らず、ADR 0020 が
  Revisit when を修正する形で記録
- **4-b (ADR 0019 を直接編集して訂正)**: 過去 ADR の immutable 性に反する

## Decision

- 論点 1 → **1-b (B-3b を縮小)**
- 論点 2 → **2-a (保持)**
- 論点 3 → **3-a (吐く)**
- 論点 4 → **4-a (この ADR で上書き)**

## Rationale

**1-b**: ADR 0004 の「B-4 = Suspense + 一括」哲学が確定済み。foldRouteTree
評価順問題は完全に B-4 範疇で、B-3b で先行修正すると ADR 0004 と矛盾。
ADR 0019 Consequences (「Router を含む component は hydrate できない」) と
Revisit when (「main.tsx を hydrate に切替」) の食い違いは、Consequences が
正しい (= B-3b では切替えない) と解釈する方が他の ADR と整合する。

**2-a**: Router の sync 初期化機能は B-3d で main.tsx を hydrate 化する時の
基盤になる。今 rollback すると同じコードを書き直しになる。`eagerModules` が
渡されない場合は従来 mount 経路で動くので、unused でも害はない (test もしない、
ドキュメントだけ残す)。ただし B-3d 完成までは試験運用の状態として `pending_rewrites`
に touchpoint を残す。

**3-a**: server markup に `<!--router-->` 1 個増えるだけ (HTML 13 文字)。
hydrate 経路実装時に再度 server / client を同期する手間を先払いする。
mount 経路ではただの comment node として無視される (effect / styling 影響なし)。
test の expectation (`router-ssr.test.ts`, `server-navigation.test.ts`) は
anchor 込みに更新済み。

**4-a**: ADR は時系列の判断ログという性質。0019 を後から編集すると履歴が
歪む。0020 で「0019 Revisit when を `B-3b で main.tsx 切替` から `B-3d 以降
(ErrorBoundary 対応 + B-4 完了後)` に修正」と明記する。

## Consequences

### 完了したこと (B-3b 縮小スコープ)

- **Router の client mode を sync 初期化 ready に拡張**:
  - `eagerModules?: Record<string, unknown>` prop 追加 (B-3d で hydrate 経路
    用に使う、現状 router-demo では未使用)
  - bootstrap data + eagerModules が両方ある場合は initial render を sync
    foldRouteTree、effect 初回 invocation を skip する構造を追加
  - 渡されない場合は従来 mount 経路 (effect 内 async load + swap) で動く
- **`renderServerSide` で `<!--router-->` anchor を吐く**: client mode と同
  shape (`fragment.children = [route_node, anchor]`)
- **`route-tree.ts` の RouteEntry / LayoutEntry / ErrorEntry / NotFoundEntry
  に `filePath` 追加**: import.meta.glob の key を保持して eager lookup
  可能に。`compiled.notFound` の型が `RouteLoader | undefined` から
  `NotFoundEntry | undefined` に変わった (breaking、内部的)
- **router-ssr.test.ts / server-navigation.test.ts を anchor 込みに更新**:
  全 8 件 pass、新規 fail なし
- **`apps/router-demo/src/main.tsx` は mount のまま**: blink は当面残る
  (B-3d 以降で hydrate 化、解消)

### 保留事項 (B-3c 以降)

- **B-3c**: ErrorBoundary を server で anchor (`<!--error-boundary-->`) 出す
  ように改修 + Show / Switch / For 同様 (それぞれ個別 ADR 候補)
- **B-4**: Suspense primitive 導入と同時に JSX runtime の children getter 化。
  これで foldRouteTree の inside-out fold が SSR markup の depth-first 順と
  一致するようになる
- **B-3d**: main.tsx を `mount` → `hydrate` に切替えて blink 解消。前提は
  B-3c (ErrorBoundary anchor) + B-4 (children getter) の完了

### server bundle / client bundle への影響

- server bundle: 57.53 kB (変化なし、Router server mode の anchor 出力は
  数十 byte 増)
- client bundle: 11.06 kB (mount 経路維持で eager glob を入れず code splitting
  保たれた状態)
- server markup: 全 navigation response の `<div id="app">` 末尾に `<!--router-->`
  1 個追加

## ADR 0019 Revisit when の訂正

ADR 0019 Revisit when の 1 番目「Step B-3b (Router の hydrate 対応) で〜
apps/router-demo の main.tsx を hydrate に切替えて blink 解消」は、本 ADR
で射程を縮小:

- **Step B-3b**: Router を hydrate-ready な構造にする (sync 初期化 + server
  anchor)。main.tsx 切替は **行わない**
- **Step B-3c**: ErrorBoundary / Show / Switch / For を server で anchor 吐く
  - client が cursor 消費する形に変更
- **Step B-4**: Suspense + JSX runtime children getter 化 (ADR 0004 論点 5
  の B-4)
- **Step B-3d**: B-3c + B-4 完了後に main.tsx を hydrate に切替、blink 解消

## 関連 ADR

- 0004: ErrorBoundary 論点 5 (children getter 化は B-4 + Suspense と束ねる)
- 0017: Router server mode + ErrorBoundary `isServer` 分岐 (server で anchor
  出さない方針 — B-3c で revisit)
- 0019: hydrate primitive (Revisit when を本 ADR で縮小訂正)
- 次: Step B-3c — ErrorBoundary / Show / Switch / For の server anchor 出力
