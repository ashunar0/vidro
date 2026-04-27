# 0027 — SSR Phase B Step B-3d: main.tsx hydrate 切替 + Phase B 完成

## Status

Accepted — 2026-04-27

## Context

ADR 0019 (hydrate primitive) → 0020 (Router sync 初期化) → 0021〜0024 (anchor
系 primitive 4 種) → 0025 (children getter 化) → 0026 (foldRouteTree
depth-first) と段階的に積み上げてきた hydrate 経路の前提条件がすべて揃った。
本 ADR は SSR Phase B の **着地** として、`apps/router-demo/src/main.tsx` の
`mount` を `hydrate` に切替え、初めて end-to-end で SSR markup → client hydrate
の経路を実機で動作させる。

着地条件:

1. anchor primitive 群の hydrate (B-3c-1 ~ B-3c-4) ✓
2. JSX runtime の children getter 化 + `_$dynamicChild` auto-invoke (B-4-a / ADR 0025) ✓
3. foldRouteTree の depth-first 順 (B-4-b / ADR 0026) ✓

そのうえで `mount(...) → hydrate(...)` に置き換え、`Router` の `eagerModules`
prop (B-3b で導入したが試験運用扱い) を本格採用する。

実機 (`wrangler dev` + Playwright) で初めて hydrate 経路を回した際に、unit
test では出ていなかった 2 件の構造的バグが顕在化した。本 ADR では切替方針と
合わせて、それらの修正を 1 つの判断パッケージとして残す。

## Options

### 論点 1: lazy / eager glob の同 pattern 重複

`Router` は `routes` (= `() => Promise<Module>` 形式) と `eagerModules`
(= `Module` 直値) の両方を必要とする (前者が compileRoutes / navigation
経路、後者が hydrate 経路の sync fold 用)。同じ glob pattern を 2 度書くと
Vite が `INEFFECTIVE_DYNAMIC_IMPORT` warning を出す。

- **1-a (lazy / eager を別々に書く)**: 自然だが 17 ファイル分の warning が
  出る。Vite の chunk 分離の最適化が効かない (eager で全部 static になるため
  実害は無い)
- **1-b (eager 1 経路から lazy を派生)**:
  ```ts
  const eagerModules = import.meta.glob("./routes/**/*.{ts,tsx}", { eager: true });
  const routes = Object.fromEntries(
    Object.entries(eagerModules).map(([k, m]) => [k, () => Promise.resolve(m)]),
  );
  ```
  glob 1 個で済む。warning が消える。`routes` の load 関数は事前解決済み
  module を `Promise.resolve` でラップするだけなので、navigation 経路の
  Promise.all も従来通り動く

### 論点 2: `@vidro/router` の `Link` で hydrate cursor が崩れる

`packages/router/src/link.tsx` は `<a>{props.children}</a>` の JSX で書かれて
いた。`@vidro/router` の build (`vp pack`) は `@vidro/plugin` の `jsxTransform`
を **経由しない** (toy 段階の build 構成)。そのため `{props.children}` が
`_$dynamicChild(() => props.children)` で wrap されず、TS automatic JSX runtime
の `jsx("a", { children: props.children })` のまま `h("a", props, children)`
に渡る。h の intrinsic 経路は `createElement` を **先**、`appendChild` で内側
text を **後** に評価するので post-order を破る → HydrationRenderer の cursor
が「a を期待したのに text になっている」と mismatch する (`expected <a>, got
text "Home" at index 2` を実機で観測)。

- **2-a (Link を vanilla `h(...)` + 手書き `_$dynamicChild` に書き換え)**:
  ```ts
  return h("a", { href, class, onClick }, _$dynamicChild(() => props.children));
  ```
  `_$dynamicChild` が h の引数として **先** に評価されるので post-order を
  保証する。Link 1 ファイルの局所修正で済む。**暫定策**
- **2-b (`@vidro/router` の build に `@vidro/plugin` の `jsxTransform` を
  組み込む)**: 本来策。`packages/router` の build configuration に plugin を
  挿す必要があり、librarymode で babel transform を走らせる構成検討が要る。
  範囲が大きいので別 ADR で取り扱う

### 論点 3: hydrate 経路で `currentNodes` (swap 対象) が空になる

`Router` は initial render で `initialNode` (foldRouteTree の戻り = fragment)
を作り、その `childNodes` を `currentNodes` に記録して、navigate 時の swap で
removeChild する設計だった。ところが hydrate 経路では:

- `HydrationRenderer.appendChild` は **target 内の既存 Node を fragment に
  動かさない** (ADR 0021)。SSR markup は target 直下に居続け、fragment 側は
  空 anchor だけ
- 結果 `initialNode.childNodes` も空 → `currentNodes = []` になる
- navigate で swap が呼ばれても remove する Node が無い → 古い SSR markup が
  残ったまま、新しい route の DOM が anchor の前に挿入されて **重複表示**

実機で `/` → `/about` 遷移時に 2 つの layout が並んで観測。

- **3-a (anchor.previousSibling を辿って `currentNodes` を再構築)**:
  hydrate 経路 (anchor が既に DOM に居る = `anchor.parentNode` が non-null)
  なら、anchor の前の Node 群が SSR markup そのもの。`previousSibling` を
  辿って配列化する。mount 経路では従来通り `initialNode.childNodes`
- **3-b (`HydrationRenderer.appendChild` の semantics を変えて Node を
  fragment に動かす)**: 副作用が大きい。anchor primitive 群 (Show / Switch /
  For / ErrorBoundary) の hydrate 整合は「target 内 Node は動かさない」
  前提で組んである (ADR 0021 ~ 0024)。これを覆すと 4 ADR 分の hydrate test
  が壊れる
- **3-c (target を Router に渡して `Array.from(target.childNodes)` で
  記録)**: `<Router>` の API surface が増える。component 側で host 要素を
  知ること自体が違和感

## Decision

- 論点 1 → **1-b (eager 1 経路から lazy を派生)**
- 論点 2 → **2-a (Link を vanilla h + `_$dynamicChild` に書き換え)** + 宿題
- 論点 3 → **3-a (anchor.previousSibling 経由で `currentNodes` 再構築)**

## Rationale

### 1-b: eager から lazy を派生

- glob を 1 回書くだけで済む。重複 warning が消えるだけでなく、source 内で
  「同じ pattern を 2 回書いている」見た目の冗長さも解消
- lazy 形式の `() => Promise.resolve(m)` は完全に既存 navigation 経路と互換。
  fetch を伴わない static load なので tick を消費するだけで semantics は同じ
- production build の chunk 分離は eager 1 経路で「全 routes が initial bundle
  に static import される」状態が確定する。toy 段階の router-demo は全 route
  を即時利用したいので望ましい挙動。将来 production app が個別 lazy load を
  欲する場合は別途 chunk hint で吸収する話

### 2-a: Link は局所書き換え、build 統合は宿題

- B-3d の本論は「main.tsx を hydrate に切替えて Phase B を着地させること」。
  `@vidro/router` の build に jsxTransform を組み込むのは別軸の作業で、
  失敗時に Phase B 着地が遅延するリスクがある
- Link は単一ファイル、handwritten で post-order を保証するのは数行の差
- 暫定であることを link.tsx の冒頭コメントに明記。後日 jsxTransform 統合 ADR
  を切ってから JSX に戻す

### 3-a: anchor の previousSibling を辿る

- hydrate 経路は「anchor が既に target 内に居る」状態が定義域 (HydrationRenderer
  の createComment が target 内 Node を返したため)。`anchor.parentNode` が
  non-null なら hydrate、null なら mount という判別が局所で完結する
- 走査は線形で、target 直下の Node 数 (= layout + Router anchor 数) しか
  ない。`Array.from(target.childNodes).filter(n => n !== anchor)` でも書ける
  が、`anchor.previousSibling` 経由なら target 参照が要らず Router 関数の
  scope に閉じる
- 既存 anchor primitive 群の hydrate semantics に手を入れずに済む (3-b 不要)

## Consequences

### 完了 (本 ADR 内容)

- **`apps/router-demo/src/main.tsx`**:
  - `mount(...)` → `hydrate(...)` に切替
  - eager glob 1 経路から lazy を派生 (`Object.fromEntries(...)` で wrap)
  - `Router` に `eagerModules` prop を本格採用
- **`packages/router/src/link.tsx`**:
  - JSX (`<a>{props.children}</a>`) → vanilla `h(...)` + `_$dynamicChild`
  - 暫定理由をファイル冒頭コメントに記載
- **`packages/router/src/router.tsx`**:
  - `currentNodes` 計算を hydrate / mount で分岐
  - hydrate: `anchor.previousSibling` を辿って配列化
  - mount: 従来通り `initialNode.childNodes` or `[initialNode]`
- **テスト**:
  - `packages/router/tests/router-hydrate.test.ts` 新規追加 (jsdom env)。
    SSR markup を再利用して hydrate される (Node identity 維持) を検証
  - 既存 hydrate 23/23 + router 9/9 全 pass
- **実機確認 (wrangler dev + Playwright)**:
  - `/` (Home): hydrate 成功、blink 無し、console error 無し
  - `/` → `/about`: navigation で重複無し、新しい route が単独表示
  - `/broken-render`: ErrorBoundary fallback (`Something went wrong`) に
    切替成功。意図的 throw の onError ログが期待通り出る
  - `/users/1`: 動的 route + nested layout + loader data (`Leanne Graham`)
    全て表示

### 副次の発見 (Phase B 完成にあたって表面化)

- **`@vidro/router` の build が jsxTransform を経由していない**: 現状は
  `vp pack src/index.ts src/server.ts --dts` で素の Vite library build。
  src 内の JSX は TS automatic runtime 経由で `jsx(...)` call になるが、
  `_$text` / `_$dynamicChild` への書き換えが入らないので post-order を保てない。
  Link で局所回避したが、router 内に他の JSX を書いた場合は同じ問題が出る
- **router 内では現状 JSX を使わない方針が無難**。今のところ link.tsx 以外は
  TSX を使っていない。新規追加時は handwritten h で書くか、別 ADR で
  jsxTransform 統合してから JSX に戻す

### 派生変更なし

- `@vidro/core` 側のロジックは変更なし (hydrate / `_$dynamicChild` /
  HydrationRenderer は ADR 0019 ~ 0026 のまま)
- LayoutProps / RouteProps の公開型は変更なし
- user code (router-demo の routes/) は変更なし

## Revisit when

- **`@vidro/router` の build に jsxTransform を統合する作業に着手するとき**:
  別 ADR (e.g. "Router の build pipeline に @vidro/plugin を組み込む") を
  起こす。完了したら link.tsx を JSX に戻すコミットも合わせて切る
- **mount 経路を Router で本格利用する状況が出たとき**: 現状 router-demo は
  hydrate 一択。mount 経路の `currentNodes` 計算は手付かずなので、再利用が
  必要になったら本 ADR の 3 番論点を再検討する
- **Phase B-5 (Suspense + createResource) を始めるとき**: hydrate 経路 +
  async resource 解決の relationship を別途検討。本 ADR で確立した hydrate
  cursor 整合性が崩れないか注意

## 関連 ADR

- 0019: hydrate primitive (本 ADR の前提)
- 0020: B-3b Router sync 初期化 + eagerModules prop (本 ADR で本格採用)
- 0021 / 0022 / 0023 / 0024: anchor primitive 4 種の hydrate 対応
- 0025: B-4-a children getter 化
- 0026: B-4-b foldRouteTree depth-first
- 次 (独立 task): **Step B-5** (Suspense + createResource) — Phase B 完成後の
  本命 async primitive
- 宿題 (本 ADR から派生): **Router build pipeline 統合 ADR** (Link を JSX に
  戻すための前提作業)
