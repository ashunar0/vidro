# 0026 — SSR Phase B Step B-4-b: foldRouteTree の children getter 化 + `_$dynamicChild` auto-invoke

## Status

Accepted — 2026-04-27

## Context

ADR 0025 (B-4-a) で JSX runtime の children getter 化を完了し、Show / Switch /
For / Match / ErrorBoundary の `() => Node` 受け取りが揃った。残るのは
**router の foldRouteTree** の構造的問題 (ADR 0020 で B-3b 中に表面化、
Playwright で `expected <h2>, got <h1>` の cursor mismatch を観測):

- `foldRouteTree` は **inside-out fold** で leaf を先に評価し、layout の
  `children` 引数に渡す
- これにより JSX 評価順は「leaf 中身 → 内側 layout → 外側 layout」だが、SSR
  markup の post-order traversal は「外側 → depth-first」
- hydrate 時に cursor が SSR markup を消費する順と JSX が DOM を組み立てる順
  が食い違い、tag mismatch が出る

ADR 0025 で children getter 化が完了したので、**foldRouteTree でも children を
`() => Node` で渡せばこの問題が構造的に解消する**。inner builder 関数を
closure で持ち回し、最外側 ErrorBoundary の `mountChildren` が children() を
呼んだ時に初めて inner が build される = JSX 評価順が SSR depth-first 順と
一致する。

ただし user 側の layout component は `<main>{children}</main>` という書き方で
children を埋め込むのが一般的。children を `() => Node` にすると user 側で
`{children()}` と explicit 呼び出しが必要 (Solid 互換) になる。これは
breaking change で、書き味が変わる。回避策として \_$dynamicChild に **0-arg
function auto-invoke** を入れれば、user は `{children}` のままで済む。

## Options

### 論点 1: layout の children API

- **1-a (`{children}` のまま、\_$dynamicChild に function auto-invoke)**:
  user は書き方を変えなくて済む。runtime 側で吸収。intrinsic child position の
  「関数が来たら呼ぶ」semantics が `appendChild` (handwritten) と \_$dynamicChild
  (transform 経由) で一貫する
- **1-b (explicit `{children()}` に書き換え、Solid 互換)**: user 側で contract
  を明示。breaking change だが意味論が透明。layout user code 4 ファイルの
  書き換えが必要

### 論点 2: foldRouteTree の構造

- **2-a (内側から thunk 組み立て、最外側で 1 回 nodeFn() を呼ぶ)**: 各 layer
  を `() => Node` の closure で持ち回し、最外側を呼ぶと連鎖的に inner を build。
  ErrorBoundary の mountChildren が children() を呼ぶタイミングで inner が
  評価され、JSX 評価順 = SSR depth-first 順
- **2-b (eager fold、現状維持)**: leaf を先に評価して layout に Node を渡す。
  hydrate cursor mismatch が残る。B-3d (main.tsx hydrate 化) が達成できない

### 論点 3: LayoutProps の `children` 公開型

- **3-a (`children: Node` のまま、内部 cast / 型の嘘)**: user 視点で「children
  は Node」のメンタルモデルが保たれる。user JSX `<main>{children}</main>` で
  普通に書ける。runtime で実際に来るのは `() => Node` だが \_$dynamicChild が
  auto-invoke で吸収するので user は気づかない
- **3-b (`children: Node | (() => Node)` の union)**: 型と runtime の差が無く
  なるが user 視点で「Node か関数か」を意識させてしまう。typeof narrow を
  user 側で書く可能性が出る

### 論点 4: function auto-invoke の判別条件

- **4-a (length === 0 のみ)**: 0-arg function だけを children getter とみなして
  invoke。For の `(item, i) => Node` 等の render callback (length > 0) は
  invoke しない。**現状の transform は For の callback を素通しで child position
  には来ないが、防御的に length チェックは残す**
- **4-b (typeof === function なら全部 invoke)**: シンプルだが render callback
  も誤って invoke してしまう。For の child position に直接 callback が来る
  ケースで壊れる

### 論点 5: effect path での auto-invoke

- **5-a (effect 内でも auto-invoke を入れる)**: 対称性のため。reactive update
  で children が差し替わる稀ケースに備える
- **5-b (effect では skip)**: peek で auto-invoke 済 → Node が返ってる → effect
  path には来ない。実害は無いが対称性を欠く

## Decision

- 論点 1 → **1-a (`{children}` のまま、\_$dynamicChild に auto-invoke)**
- 論点 2 → **2-a (内側から thunk 組み立て、最外側で 1 回呼ぶ)**
- 論点 3 → **3-a (`children: Node` のまま、内部 cast)**
- 論点 4 → **4-a (length === 0 のみ)**
- 論点 5 → **5-a (effect 内でも auto-invoke)**

## Rationale

### 1-a: `{children}` のまま、auto-invoke で吸収

- ユーザーが書く layout component は React / Vue / Astro / SvelteKit など
  どの flavor でも `{children}` で埋め込む書き味。Solid だけ `{children()}` の
  独自規約を持つ
- Vidro の他の primitive (`<Show>`、`<Switch>`、`<ErrorBoundary>`) は
  「children を 1 つ受けて表示する」semantics で、user 視点では `<X>{...}</X>`
  と書けば中身が表示される。layout だけ `{children()}` にすると一貫性を欠く
- intrinsic child position の handwritten path (`appendChild`) は **既に**
  「関数が来たら呼ぶ」semantics を持っている (`jsx.ts` line 215〜)。\_$dynamicChild
  に同じ挙動を入れるのは整合性向上であって新規導入ではない
- 「関数を child に意図的に渡したい」ユースケースは toy runtime 段階では
  想定外。Suspense (B-5) で必要になったら別 axis (例: marker) で区別する余地

### 2-a: thunk chain で連鎖的に build

- 最外側 ErrorBoundary({...}) が構築される時、mountChildren() が children()
  を呼ぶ → layoutMod[0].default が JSX 評価 → `{children}` 位置で
  \_$dynamicChild が auto-invoke → 内側 thunk を呼ぶ → layer[1] の ErrorBoundary
  構築 → mountChildren → ... と連鎖
- JSX 評価順:
  - layout[0]: `<div><h1>Layout</h1><main>{children}</main></div>`
  - 1. `<h1>` の children (`_$text("Layout")`) → text Node 作成
  - 2. `<h1>` 自身 → h1 element 作成
  - 3. `<main>` の children (`_$dynamicChild(() => children)`) → auto-invoke →
       inner build → [recursive depth-first build of layer[1] / leaf]
  - 4. `<main>` 自身 → main element 作成
  - 5. `<div>` 自身 → div element 作成
  - 6. ErrorBoundary anchor 作成
- DOM post-order と完全一致 → cursor mismatch 解消

### 3-a: `children: Node` のまま、内部 cast

- user の layout component の書き味と、type が見せるメンタルモデルが一致
  すること優先
- `Record<string, unknown>` の境界 (router → layoutMod.default) で TS は
  strict check しないので、wrapLayout 内の `children: () => Node` 渡しは
  型エラーにならない
- ユーザー側で `props.children` は Node 型として narrow されるが、実際は
  function。`{children}` で展開する分には \_$dynamicChild が吸収するので
  ユーザーは違いを感じない。`props.children.cloneNode()` のような Node 操作
  をユーザーが書くのは layout の典型的書き味から外れる稀ケース、規約として
  許容

### 4-a: length === 0

- For の `(item, i) => Node` callback は length > 0 で auto-invoke されない。
  もし将来 callback を child position に直接書くケースが出ても誤動作しない
- defensive check。現状 transform は ArrowFunction を素通しで \_$dynamicChild
  には来ないが、handwritten 経由 (e.g. test) で来る可能性に備える

### 5-a: effect path も対称に

- 「children を signal で差し替える」ようなケースは現状無いが、対称性を欠く
  と将来の variant で混乱の元になる
- 1 行追加だけでコスト極小

## Consequences

### 完了 (本 ADR 内容)

- **`packages/core/src/jsx.ts` の `_$dynamicChild` 改修**:
  - peeked が `typeof function` かつ `length === 0` なら auto-invoke
  - effect path も同じく auto-invoke (対称性)
  - `appendChild` (handwritten path) と挙動一致 → intrinsic child position の
    semantics 統一
- **`packages/router/src/router.tsx` の `foldRouteTree` 改修**:
  - `wrapLayout(..., children: () => Node)` に変更
  - 内側 layer から thunk を組み立て、最外側で 1 回呼ぶ形に
  - 内部 cast (`as unknown as Node`) は不要 (RouteModule.default が
    `Record<string, unknown>` を受けるため TS は緩い)
- **`apps/router-demo/src/routes/*/layout.tsx` 等の user code は変更不要**
  (`{children}` のままで \_$dynamicChild が auto-invoke)
- **テスト**:
  - `core/tests/hydrate.test.ts` に「layout + leaf 構造で children getter
    auto-invoke で hydrate できる」test を追加 → hydrate 23/23 全 pass

### 派生変更なし

- LayoutProps の公開型 `children: Node` は変更なし (3-a)
- handwritten test の `h(Component, props, node)` パターンは継続可能 (3-a)

### B-3d 着地条件達成

ADR 0020 / 0024 / 0025 で「B-3d (main.tsx hydrate 切替) は B-4 完了後」と
言ってきた前提条件が揃う:

1. anchor primitive 群の hydrate 対応 (B-3c-1 ~ B-3c-4) ✓
2. children getter 化 (B-4-a / ADR 0025) ✓
3. foldRouteTree の depth-first 順 (B-4-b / 本 ADR) ✓
4. → B-3d で `apps/router-demo/src/main.tsx` の `mount` を `hydrate` に切替
   可能に。eager glob + Router の eagerModules prop が活性化する

### server / client bundle への影響

- core: `_$dynamicChild` に 4 行追加、bundle ~+50 byte
- router: foldRouteTree の logic は thunk closure で書き直しただけで論理は同等

### `appendChild` との挙動差解消

- `appendChild` (jsx.ts handwritten path、line 215〜): function を peek + invoke
  - Node なら append、primitive なら text + effect。**B-3a 以前から auto-invoke
    していた**
- `_$dynamicChild` (transform 経由): function を auto-invoke せず primitive
  text に落としていた → 本 ADR で同じ auto-invoke を導入 → 一貫
- 副作用として「intrinsic 内に 0-arg 関数を child として書く」と invoke される
  ようになるが、これは React / Solid 含めて一般的な expectation

## Revisit when

- **B-5 (Suspense + createResource) で children に関数を意図的に渡したい場合**:
  marker (例: `__suspendable: true`) を thunk に付けて区別する。auto-invoke
  対象を絞る判別 logic を追加
- **layout の children 内部実装を Node 操作する稀ケースが必要になった場合**:
  user 側で `() => Node` として明示的に呼ぶ規約を documentation に追加。
  公開型を `Node | (() => Node)` の union に変更する選択肢もあり (本 ADR の
  論点 3-b 案)
- **For の render callback が \_$dynamicChild に来るような transform 拡張が
  入った場合**: length チェックだけでは判別不能になるので marker 方式に切替

## 関連 ADR

- 0019: hydrate primitive (intrinsic 用 `_$text` / `_$dynamicChild` の規約。
  本 ADR で `_$dynamicChild` の semantics を「0-arg function は auto-invoke」
  に拡張)
- 0020: B-3b Router sync 初期化 (foldRouteTree 順序問題を最初に明記)
- 0021 / 0022 / 0023 / 0024: anchor primitive 群の hydrate 対応 (本 ADR の
  前提条件)
- 0025: B-4-a children getter 化 (本 ADR の前提条件)
- 次: **Step B-3d** (main.tsx を hydrate に切替、blink 解消)、その後
  **Step B-5** (Suspense + createResource)
