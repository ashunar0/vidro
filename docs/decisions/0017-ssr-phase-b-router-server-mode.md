# 0017 — SSR Phase B Step B-2b: Router server mode + preload helper

## Status

Accepted — 2026-04-24

## Context

ADR 0016 (Step B-1) で universal renderer 抽象を入れ、ADR 0016 Step B-2a で
`renderToString(fn)` を実装した。次は Router を server で評価できるようにする
(Step B-2b)。Router は navigation + data fetch + DOM swap を内包する最重量
component で、現状:

- `window.location.pathname` / `window.addEventListener("popstate")` を直叩き
- `fetch("/__loader?path=...")` で loader 結果を取得
- route / layout / error.tsx を **dynamic import (Promise)** で lazy load
- `effect(...)` の中で `Promise.all([...]).then(() => swap(node))` という **非同期
  フロー**。同期的に return されるのは anchor だけ入った DocumentFragment

そのまま `renderToString(() => <Router />)` を呼ぶと、sync renderToString では
microtask が回らず、anchor だけの空 fragment が serialize されて終わる。

論点は 3 つ:

1. server モードの注入 API shape: 新 component (`ServerRouter`) vs prop 追加
2. sync 化の方法: renderToString 自体を async 化 vs preload + 同期 fold
3. ErrorBoundary の server 対応: foldRouteTree が ErrorBoundary を使うため必須

## Options

### 論点 1: server モードの注入 API shape

- **1-a (新 `ServerRouter` component)**: client `Router` とは別 export を作り、
  `ssr` 前提の同期 API を持つ
- **1-b (既存 `Router` に optional prop)**: `<Router ssr={{...}} />` で server
  モードを明示。props 未指定なら従来の client 挙動
- **1-c (SSR 専用 internal function)**: `@vidro/router/server` だけに公開した
  `renderRouteTree(...)` を内部で使い、Router component は触らない

### 論点 2: sync 化の方法

- **2-a (renderToString を async 化)**: `async function renderToString` にして
  dynamic import / Promise を await できるようにする
- **2-b (preload helper + 同期 fold)**: 呼び側が `preloadRouteComponents` で
  dynamic import を事前解決、`bootstrapData` で loader 結果を注入。Router は
  `ssr` を受け取ったら effect / popstate / fetch を使わず同期 fold

### 論点 3: ErrorBoundary の server 対応

- **3-a (isServer 分岐)**: `getRenderer().isServer` なら try/catch + fallback
  を同期実行、effect / anchor / fragment を一切使わない
- **3-b (server では ErrorBoundary を剥がす)**: Router の foldRouteTree で server
  mode のときだけ ErrorBoundary wrap をスキップ、代わりに直接 try/catch
- **3-c (server 用 renderer に anchor/fragment 操作を追加)**: Renderer I/F に
  `insertBefore` / `removeChild` を足し、ErrorBoundary を無変更で動かす

## Decision

- 論点 1 → **1-b (既存 `Router` に optional `ssr` prop)**
- 論点 2 → **2-b (preload helper + 同期 fold)**
- 論点 3 → **3-a (ErrorBoundary に `isServer` 分岐)**

### Router props の shape

```ts
type SSRProps = {
  /** server 側で gatherRouteData した結果 (pathname / params / layers) */
  bootstrapData: { pathname: string; params: Record<string, string>; layers: BootstrapLayer[] };
  /** preloadRouteComponents で事前解決した component 群 */
  resolvedModules: ResolvedModules;
};

type RouterProps = {
  routes: RouteRecord;
  ssr?: SSRProps;
};
```

`ssr` が渡されると Router は以下に切替:

- `compileRoutes` + `matchRoute(ssr.bootstrapData.pathname, compiled)` を sync 実行
- `resolvedModules.route === null` なら 404 text を返して早期 return
- `bootstrapData.layers` を `hydrateError` で client 経路と同形に整え、既存の
  `foldRouteTree()` に食わせる (pure 関数、server / client 共通)
- effect / popstate / fetch / anchor / fragment / swap は一切使わない
- `reset` は no-op (次回 navigation は client hydration 後)

### preloadRouteComponents (`@vidro/router/server`)

```ts
export async function preloadRouteComponents(
  manifest: RouteRecord,
  pathname: string,
): Promise<ResolvedModules>;
```

- `compileRoutes` + `matchRoute` で match を計算
- `match.route?.load` (なければ `compiled.notFound`) / `match.layouts[i].load` /
  `match.errors[i].load` を `Promise.all` で並列 load
- 個別 `error.tsx` の load 失敗は null に吸収 (client mode と同じ)
- leaf module は `route` フィールドに詰める。not-found.tsx がある場合はそれを
  `route` に入れるので、server caller は 404 かどうかを `route === null` で判定
  できる

### ErrorBoundary の server 対応 (packages/core/src/error-boundary.ts)

```ts
export function ErrorBoundary(props: ErrorBoundaryProps): Node {
  const renderer = getRenderer();
  if (renderer.isServer) {
    try {
      return props.children();
    } catch (err) {
      props.onError(err);
      return props.fallback(err, () => {});
    }
  }
  // --- client mode (reactive 切替版、既存コード) ---
  // ...
}
```

## Rationale

### 論点 1: `Router` に optional prop (1-b)

- 別 component (1-a) は client / server で 2 本維持することになり、ADR 0016
  の「同じ JSX runtime が両側で動く」universal 哲学に逆行する。ADR 0016 が
  明示的に却下した「SSR 専用 renderer (1-c)」と同じ精神の分断
- Internal function (1-c) も component を 2 本に分けるのと同じ分断を生む。
  foldRouteTree を共通化しても「user が Router を呼べるのは client だけ」と
  いう枷が残る
- prop 追加 (1-b) は Router 内部に `if (props.ssr)` の 1 分岐を増やすコスト
  だけで universal 哲学を保てる。server 側の複雑さ (preload / bootstrap 注入)
  は呼び側に出るが、それは本来 server の責務なので適切な場所に落ちる
- RSC-like を将来入れるときは、今の Router ごと `ServerRouter` / `ClientRouter`
  に分離する (memory `project_rsc_like_rewrites` 参照)。今の 1-b 判断は将来
  書き換え前提だが、B-2b 時点の哲学整合を優先した

### 論点 2: preload + 同期 fold (2-b)

- renderToString 非同期化 (2-a) は RSC-like の async server component を
  見据えるなら自然な path だが、本 ADR 範囲を超える変更 (ADR 0016 論点 6 の
  再検討が必要)。Phase B 段階では sync renderToString のほうが debug も serialize
  も素直
- preload + 同期 fold (2-b) は、dynamic import を呼び側で await する責任を明示
  する。server handler は元々 async なので await は自然に書ける。Router 内部
  は sync 化できるので fold logic を client と共有できる
- トレードオフ: 呼び側が 2 ステップ (preload → renderToString) を踏む必要が
  ある。handler helper でラップすれば隠せるので問題にならない (Step B-2c で対応)

### 論点 3: ErrorBoundary `isServer` 分岐 (3-a)

- server で ErrorBoundary を剥がす (3-b) は foldRouteTree 側の分岐を増やし、
  「client / server で fold のコードが違う」状態になる。universal 哲学と
  相性が悪い
- Renderer I/F に insertBefore を足す (3-c) は ErrorBoundary を無変更で
  動かせるが、server renderer は anchor + swap を模倣する意味がない
  (effect が走らないので切り替えが不要)。実装コストが見合わない
- isServer 分岐 (3-a) は ErrorBoundary 内に 10 行未満の分岐を追加するだけ。
  server では try/catch + 同期 fallback で等価挙動。ADR 0016 論点 6 の
  「effect は server で 1 回走らせて捨てる」と同じ精神

## Consequences

### 実装

- `packages/core/src/error-boundary.ts`: `getRenderer().isServer` で server
  分岐を追加、try/catch + 同期 fallback
- `packages/router/src/router.tsx`:
  - `ResolvedModules` / `SSRProps` 型 export
  - `Router(props)` の先頭で `if (props.ssr) return renderServerSide(...)`
    早期 return
  - `foldRouteTree()` を pure 関数に抽出 (client / server 共通)
  - client mode の `document.*` 呼び出しを `getRenderer()` 経由に統一
    (universal 哲学の貫徹)
- `packages/router/src/server.ts`: `preloadRouteComponents` を追加
- `packages/router/src/index.ts`: `ResolvedModules` / `SSRProps` type export
- `packages/router/tests/router-ssr.test.ts`: 7 ケース
  - layout + index の sync render
  - nested route (/about) の single-layer render
  - loader data の props 伝播
  - loader error → error.tsx 置換
  - render error → ErrorBoundary fallback 置換
  - 404 (素朴 text)
  - not-found.tsx がある場合

### 動作確認

- **unit test**: `vp test` in `packages/router` で 7/7 pass
- **core regressions**: ErrorBoundary 9/9 pass、render-to-string 14/14 pass、
  既存 pre-existing failures 13 件は不変 (For / Show / Switch の Signal 型
  推論問題、本 ADR 非関連)
- **client regressions**: `vp build` in `apps/router-demo` で client bundle +
  ssr server bundle の build 通過。Step B-2c で wrangler / Playwright 回帰
  検証

### 制約・既知の課題

- **preload 2 ステップ**: 呼び側が `preloadRouteComponents` + renderToString
  を踏む必要。Step B-2c で `createServerHandler` 内に集約する
- **reset is no-op on server**: error.tsx の `reset` ボタンは server render 時
  点では機能しない。Hydration (B-3) 後に client が取って代わる
- **resolvedModules 型の生々しさ**: `{ route, layouts, errors }` が component
  module object の raw array。将来 RSC-like に行くときは payload 形式に再設計
  (memory `project_rsc_like_rewrites` 参照)
- **Signal 追従は server で効かない**: Router の client mode は
  `currentPathname` signal を subscribe して再 render するが、server mode は
  同期 1 回だけ。これは ADR 0016 論点 6 の方針通りで期待動作
- **ErrorBoundary server 分岐の副作用なし**: onError は同期で呼ばれ、fallback
  も同期評価。parentOwner への bubble up は `throw` で自然に行われるため、
  nested ErrorBoundary (将来) でも同じセマンティクスで動く

### 設計書への影響

- なし (B-2b は実装詳細)。B-2c で handler 統合時にまとめて反映

## Revisit when

- **RSC-like 導入時**: Router を `ServerRouter` / `ClientRouter` に分離。
  `ssr` prop は捨てて payload 対応 API に進化 (memory
  `project_rsc_like_rewrites` の touchpoints)
- **renderToString async 化時**: dynamic import を Router 内で直接 await
  可能に。`preloadRouteComponents` helper は不要になる。Phase C (streaming
  SSR) や RSC-like の async server component を入れるときに検討
- **Show / Switch / For の server 対応**: 今は ErrorBoundary だけを server
  対応した。他の control flow primitive が server で必要になったら同じ
  `isServer` 分岐パターンで一括対応
- **Hydration (B-3) 実装時**: server render の出力と client render の出力が
  node-by-node で一致するか検証。ずれが出たら foldRouteTree の client 経路
  (anchor + swap) を server 経路と揃える方向で調整
