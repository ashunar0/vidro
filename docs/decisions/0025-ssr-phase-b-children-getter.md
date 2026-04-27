# 0025 — SSR Phase B Step B-4: JSX runtime children getter 化 (Suspense は B-5 に切り出し)

## Status

Accepted — 2026-04-27

## Context

ADR 0021 〜 0024 で B-3c (anchor primitive 群の server anchor + client renderer
経由) が一巡し、Show / Switch / For / ErrorBoundary 全てが server で anchor
を吐く構造になった。残るのは:

- **Show / Switch の fallback あり / inactive children eager 評価問題** (cursor
  mismatch、B-3c-2 / 0023 で B-4 持ち越しと明記)
- **For の fallback ありで list 非空問題** (B-3c-4 / 0024 で B-4 持ち越しと明記)
- **foldRouteTree の inside-out fold と SSR depth-first 順のズレ** (B-3b / 0020
  で表面化、Playwright で `expected <h2>, got <h1>` を観測)
- **ErrorBoundary の `{() => <Child />}` 関数包み規約** (ADR 0004 論点 5 で
  「B-4 で消える」と明記)

これらは ADR 0004 論点 5 の **JSX runtime children getter 化 (B-4)** で
一括解決する想定で、複数 ADR (0004 / 0005 / 0007 / 0019 / 0020 / 0024) に
「B-4 で revisit」と書かれてきた。

ところが過去 ADR では **「B-4 = Suspense + children getter 化を一緒に」**
という表現が一貫していた:

- ADR 0004: 「`<Suspense>` 等、他の遅延評価 primitive を入れる時に一緒にやる方が効率的」
- ADR 0019 関連 memory: 「ブロッカー: `<Suspense>` など children 遅延評価を
  要する別 primitive が出るまで待つ」
- ADR 0024: 「次: Step B-4 — Suspense primitive 導入 + JSX runtime children
  getter 化」

実際に着手準備したところ、**Suspense は async resource primitive
(`createResource` 相当)** の設計が絡み、それ自体が ADR 1 本分の論点を持つ
(設計書 §4 streaming / Phase C 関連)。toy runtime の現段階で Suspense と
children getter 化を一気にやると変更範囲が広すぎる。

一方 children getter 化 **だけ** で以下が解決する:

- Show / Switch / For の fallback / inactive children 完全 hydrate
- foldRouteTree 順序問題
- ErrorBoundary の `{() => <Child />}` 関数包み規約消滅 (forward-compat)
- B-3d (main.tsx を hydrate に切替) の前提条件達成

→ B-4 を **children getter 化のみ** に縮小し、Suspense は **B-5** に切り出す
方が段階的着地ができて、過去 ADR の精神 (= 「B-4 で revisit」) は守られる。

## Options

### 論点 1: B-4 の射程

- **1-a (Suspense と一括、過去 ADR の表現通り)**: Suspense + children getter
  化を 1 step。論点 / 実装ともに大きい。toy runtime 段階で 1 commit に詰める
  には変更範囲が広い
- **1-b (children getter 化のみ、Suspense は B-5 に切り出し)**: B-4 を
  children getter 化に縮小。Suspense の async resource 設計は B-5 として
  独立 ADR で扱う

### 論点 2: transform の component / intrinsic 判別方法

- **2-a (PascalCase / JSXMemberExpression で component 判定)**: React 慣習。
  `<Foo>` / `<foo.Bar>` / `<Foo.Bar>` を component、`<div>` / `<custom-elem>`
  を intrinsic とする
- **2-b (importmap / scope 解析で判定)**: identifier resolution で確実に
  判別。実装コスト高、static 解析依存
- **2-c (全部同じ transform、runtime で h() の type を見て分岐)**: transform
  簡素、runtime で thunk 化判定。component の child を eager 評価してから
  thunk に再 wrap という二度手間で post-order が崩れる

### 論点 3: component child position の text / Element の thunk 化

- **3-a (常に Node を返す getter に統一)**: `<Foo>hello</Foo>` →
  `() => _$text("hello")`、`<Foo><Bar /></Foo>` → `() => h(Bar)`、
  `<Foo>{x}</Foo>` → `() => x`。children() 呼び出し結果は常に Node
- **3-b (型を許容、user 側で判定)**: `<Foo>hello</Foo>` → `() => "hello"`。
  user component で「children が string なら ...」と分岐する余地を残すが、
  ErrorBoundary 既存規約 (`children: () => Node`) と矛盾

### 論点 4: ErrorBoundary 既存 API の扱い

- **4-a (既存 `children: () => Node` 規約は維持、forward-compat)**: ADR 0004
  Rationale 通り。普通の JSX 経由でも transform が `() => h(Child)` に包んで
  動くようにする。ユーザーが `<ErrorBoundary><Child /></ErrorBoundary>` も
  `<ErrorBoundary>{() => <Child />}</ErrorBoundary>` も書ける形
- **4-b (普通の JSX のみに統一、`{() => ...}` を deprecated)**: 書き味は綺麗
  だが ADR 0004 で「B-1 は B-4 後も forward-compat」と決めた約束を破る

### 論点 5: fallback の callback 形扱い

- **5-a (`(err, reset) => Node` callback 形は維持)**: ADR 0004 論点 3 で確定済み
  の API。引数あり = children getter とは別もの
- **5-b (fallback も children と同じ `() => Node` に統一)**: ErrorBoundary の
  err / reset を別経路 (context 等) で渡す必要があり、API 破壊

### 論点 6: Match descriptor の child 表現

- **6-a (`child: () => Node | null` に変更)**: Switch が active を選んだ後で
  child() を呼ぶ → inactive Match の child は評価されない。完全 hydrate 達成
- **6-b (descriptor 自体を transform レベルで thunk 化、Match 内で受ける形は
  `child: Node` のまま)**: Match を thunk 内で評価 → descriptor 構築タイミング
  も遅延化。Match の `when` を Switch がどう読むかが複雑化

### 論点 7: For / Show / Switch の fallback 型

- **7-a (`fallback: () => Node` に変更、breaking)**: API 統一。primitive 間の
  対称性が高まる
- **7-b (両対応、関数なら呼ぶ / Node ならそのまま使う)**: 互換性高いが API が
  曖昧。手書き JSX 経由の Node 直書きが将来も書け続ける誤解を招く

### 論点 8: 過去 ADR の "B-4 = Suspense と一緒" 表現の扱い

- **8-a (本 ADR で訂正する形で記録、ADR 0019 → 0020 と同じ pattern)**:
  ADR 自体は immutable、本 ADR の冒頭で射程変更を明示
- **8-b (関連 ADR を直接編集して "B-4 → B-5" に書き換え)**: 過去 ADR の
  immutable 性に反する

## Decision

- 論点 1 → **1-b (children getter 化のみ、Suspense は B-5)**
- 論点 2 → **2-a (PascalCase / JSXMemberExpression で判定)**
- 論点 3 → **3-a (常に Node を返す getter)**
- 論点 4 → **4-a (ErrorBoundary 既存 API 維持、forward-compat)**
- 論点 5 → **5-a (callback 形維持)**
- 論点 6 → **6-a (`child: () => Node`)**
- 論点 7 → **7-a (`fallback: () => Node`)**
- 論点 8 → **8-a (本 ADR で訂正記録)**

## Rationale

### 1-b: B-4 縮小と B-5 (Suspense) 切り出し

ADR 0004 論点 5 で「`<Suspense>` 等、他の遅延評価 primitive を入れる時に
一緒にやる方が効率的」と書いたのは、当時 (2026-04-23) は children getter 化
**だけ** を入れる動機が無かったから。B-3c が一巡し、Show / Switch / For の
fallback / inactive children 問題と foldRouteTree 順序問題が両方とも
children getter 化単独で解決すると判明 → **動機が変わった**。

Suspense は async resource (`createResource` 相当) と一緒に設計しないと
実用にならず (`<Suspense fallback={<Spinner />}>{<UserData />}</Suspense>` の
`UserData` 内で resource を読んだ時に suspend する仕組みが要る)、それ自体が
ADR 1 本分の論点。toy runtime 段階で B-4 と一緒にやると変更範囲が広すぎる
(transform 修正 + primitive 改修 + Owner / Effect の suspend hook + resource
primitive の 4 axis を 1 commit に詰めるのは無理)。

段階的着地として:

- **B-4 (本 ADR)**: children getter 化のみ。Show / Switch / For / Match /
  ErrorBoundary の API 改修と transform 拡張で完結
- **B-3d (B-4 完了後)**: main.tsx を hydrate に切替、blink 解消
- **B-5 (B-3d 後の独立タスク)**: Suspense + createResource の設計と実装

ADR 0020 が ADR 0019 Revisit when を縮小訂正したのと同じ精神。「B-4 で
revisit」と書いた過去 ADR の射程を本 ADR で再定義する。

### 2-a: PascalCase / JSXMemberExpression 判定

React / Solid / Preact 全部この慣習で運用実績がある。lower case identifier
は intrinsic (HTML / SVG 要素 + custom element) と決まる。Vidro でも
component 名は PascalCase 規約 (実例: `Show` / `Switch` / `For` /
`ErrorBoundary` / `Router` 全て一致)。importmap / scope 解析は overengineered。

判別不能なケース (例: `<foo />` を component として使いたい) は **規約上 NG**
として弾く。AI-native 規約 (設計書 §1 哲学 4) と整合する判断点削減。

### 3-a: Node を返す getter 統一

ErrorBoundary 既存規約 `children: () => Node` と一致。primitive 内部で
`children()` を呼んだら必ず Node が来る = 分岐不要 = コード簡素。

`<Foo>hello</Foo>` を `() => "hello"` (string) にすると Foo 側で
`typeof === "string"` ハンドリングが要り、Foo を書く user の規約が増える。

### 4-a: ErrorBoundary 既存 API 維持 (forward-compat)

ADR 0004 で **明示的に** 「B-1 (関数包み) は B-4 移行後も forward-compat で
動く」と約束済み。これを破ると router/router.tsx の `children: () =>
leafMod.default(...)` 等の既存 callsite が大量 breaking する。

実装的には:

- `<ErrorBoundary>{() => <Child />}</ErrorBoundary>` (既存): transform で
  `h(ErrorBoundary, null, () => () => h(Child))` 風になり children() が
  関数を返す。runtime で children() の結果が関数なら更に呼ぶ層が要る
- 解決策: transform 側で **child position の ArrowFunction / FunctionExpression
  は素通し** (For の `(item, i) => ...` も同じ理由で素通し)。`{() => x}` は
  関数を child position に書いた形で、transform は更に thunk で包まない →
  `h(ErrorBoundary, null, () => x)` 相当で既存 API と一致

つまり transform の child wrapping は:

- ArrowFunctionExpression / FunctionExpression child → 素通し
- それ以外 (JSXText / JSXElement / JSXFragment / JSXExpressionContainer) →
  `() => Node` に thunk 化

これで ErrorBoundary は普通の JSX (`<ErrorBoundary><Child /></ErrorBoundary>`)
も既存記法 (`<ErrorBoundary>{() => <Child />}</ErrorBoundary>`) も両方
動く。

### 5-a: callback 形維持

ADR 0004 論点 3 で確定済み。`(err, reset) => Node` は引数を持つ callback で、
plain getter (`() => Node`) とは別 axis の API。fallback 型を統一すると
err / reset を渡す導線が消える。

### 6-a: Match `child: () => Node`

Switch が active を選んだ後で `match.child()` を呼ぶ形に変える。inactive
Match の child は評価されない = SSR markup の active 1 個と client cursor の
評価が一致 = 完全 hydrate。

`when` の readWhen は今のままでよい (Match は descriptor で child だけ getter 化)。

### 7-a: `fallback: () => Node`

Show / Switch / For の fallback を `() => Node` に統一。primitive 内部で
「active branch が無い時のみ fallback() を呼ぶ」形にすれば、fallback の
eager 評価問題が消える。

両対応 (7-b) は API 曖昧化。手書き JSX 経由で `fallback={<X />}` と書いても
transform が `fallback={() => h(X)}` に包んでくれるので、user 側の書き味は
変わらない。手書きで `h(Show, { fallback: node })` するパターンは tests 内に
ある可能性があるので、grep で洗い出す。

### 8-a: 本 ADR で訂正記録

ADR 0020 が ADR 0019 Revisit when を訂正した同じ pattern。本 ADR で:

- ADR 0004 論点 5 の「B-4 = Suspense と一緒」 → 「B-4 = children getter のみ、
  Suspense は B-5」に訂正
- ADR 0005 / 0007 / 0019 / 0020 / 0022 / 0023 / 0024 の Revisit when の
  「B-4」言及は本 ADR (children getter のみ) を指すように再定義
- Suspense 関連の言及は B-5 に持ち越し

## Consequences

### 完了 (本 ADR 内容)

- **`packages/plugin/src/jsx-transform.ts` 拡張**:
  - JSXElement の openingElement 名を見て component / intrinsic 判定
    (PascalCase or JSXMemberExpression → component)
  - component の child position:
    - JSXText `hello` → `() => _$text("hello")`
    - JSXExpressionContainer `{x}` → `() => x`
    - JSXElement / JSXFragment → `() => h(...)`
    - ArrowFunctionExpression / FunctionExpression → 素通し
  - component の attribute (`fallback={<X />}` 等) で JSXElement /
    JSXFragment が来た場合も `() => h(X)` に thunk 化
  - intrinsic 用 `_$text` / `_$dynamicChild` は **温存** (ADR 0019 の規約維持)
- **`packages/core/src/jsx.ts` の h()**:
  - `type === "function"` (component) の場合、children を関数のまま素通し
    (eager 評価しない)。1 件なら `props.children = childrenArr[0]`、複数なら
    配列のまま
  - intrinsic / Fragment 側は変更なし
- **各 primitive の改修**:
  - Show: `children?: () => Node` / `fallback?: () => Node` に型変更、active
    branch のみ呼ぶ
  - Switch: `fallback?: () => Node` に型変更、Match descriptor の `child:
() => Node` 化
  - For: `fallback?: () => Node` に型変更。children: `(item, i) => Node`
    は元のまま
  - ErrorBoundary: `children: () => Node` 既存維持。forward-compat 確認
- **router の foldRouteTree 改修 (B-4-b、別 commit / ADR 0026 候補)**:
  - `wrapLayout` の `children: Node` 引数を `children: () => Node` に変更
  - layoutMod.default に渡す children も getter 化
  - leaf の `children: () => leafMod.default(...)` は既存維持

### テスト

- hydrate.test.ts に「Show fallback あり」「Switch fallback あり / 複数 Match
  inactive」「For fallback あり list 非空」を追加し全 pass を目標
- show.test.ts / switch.test.ts / for.test.ts の既存 fail (Signal 型推論の
  pre-existing) は本 ADR 範囲外
- 手書き `h(Component, props, node)` 経路 (tests 内) は
  - render-to-string.test.ts / router-ssr.test.ts などで `h(ErrorBoundary,
null, ...)` を直接書いている箇所 → children を関数で渡す形に書き換え
    or transform 経由 JSX に書き換え

### 過去 ADR の Revisit when 訂正

本 ADR で以下の Revisit when の射程を **「B-4 = children getter 化のみ、
Suspense は B-5」** に再定義:

- ADR 0004 論点 5: 「`<Suspense>` 等、他の遅延評価 primitive を入れる時に
  一緒にやる」 → **B-4 では Suspense は対象外、children getter 化のみ。
  Suspense は B-5**
- ADR 0005 Revisit when: 「JSX runtime の children getter 化 (B-4) を入れる時」
  → **本 ADR で実施 (Show / Switch / Match を一括移行)**
- ADR 0007 Revisit when: 「Suspense + children getter 化 (roadmap B-4) を
  実装する時」 → **B-4 では proxy 展開ルール再設計は不要 (children 素通しの
  既存ルールで動く)。Suspense は B-5 に移動**
- ADR 0019 Revisit when: 既に ADR 0020 で訂正済 (B-4 関連は本 ADR の射程に
  入る)
- ADR 0022 / 0023 / 0024 Revisit when: 「B-4 (children getter 化) で fallback
  も `() => Node` 化」 → **本 ADR で実施**

### server / client bundle への影響

- server bundle: transform で thunk が増える分、production minify 後でも
  数百 byte 増を見込む
- client bundle: 同上。thunk overhead は component 境界 1 hop なので fine-grained
  reactivity の他コストに埋もれる範囲
- server markup: 変化なし (anchor は B-3c で既に出てる)

## Revisit when

- **B-5 (Suspense + createResource) を入れる時**: Owner / Effect の suspend hook、
  resource primitive の lifecycle、streaming SSR (Phase C 後段) との接続を
  別 ADR で設計
- **手書き `h(Component, props, ...children)` を deprecated にする時**: lint
  rule で警告 → transform 強制。test pattern を全 JSX 経由に書き換える工数が
  必要
- **transform の component 判定で false positive / negative が出た時**:
  PascalCase 規約から外れる component (lowercase 名前) を許容するか、規約
  違反として lint で警告するか
- **proxy 展開ルールを再設計したい時**: children を Proxy で展開しない既存
  ルールを変える (children を marker 付き thunk と区別する等) なら、ADR 0007
  Revisit when の延長で別 ADR

## 関連 ADR

- 0004: ErrorBoundary 論点 5 (本 ADR で「B-4 = children getter のみ」に縮小、
  Suspense は B-5 に移動)
- 0005: Switch / Match Revisit when (本 ADR で実施)
- 0007: Component props proxy (children 素通し既存ルール踏襲)
- 0010: Layout error propagation (foldRouteTree の wrapLayout は B-4-b で
  children getter 対応)
- 0019: hydrate primitive (intrinsic 用 `_$text` / `_$dynamicChild` の規約
  踏襲、component 用 transform は別 axis)
- 0020: B-3b Router sync 初期化 (B-3d への前段、本 ADR で「B-3d は B-4 + 本
  ADR 完了後」確定)
- 0022 / 0023 / 0024: Show / Switch / For anchor (B-3c-2/3/4、fallback 完全
  hydrate は本 ADR で達成)
- 次: **Step B-4-b** (router foldRouteTree の getter 化、ADR 0026 候補)、
  その後 **Step B-3d** (main.tsx を hydrate に切替)、独立して **Step B-5**
  (Suspense + createResource)
