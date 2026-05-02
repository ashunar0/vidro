# 0053 — `LoaderArgs` に `request: Request` を追加: loader が URL / headers を読める経路

## Status

**Accepted** — 2026-05-02 (44th session、dogfood + reviewer fix 込み)

依存: ADR 0011 (LoaderArgs/ActionArgs の拡張は 1 箇所に閉じる) / ADR 0052 (`searchParams()` primitive)

## Context

### 痛み A の起点 — pagination dogfood で気付いた

ADR 0052 で `searchParams()` を accept し、URL search 部分を **client URL state primitive** として扱う設計が成立した。次に pagination UI を `/notes` に追加して `<Link href="?page=2">` + popstate + `revalidate()` の経路を dogfood しようとしたところ、**loader が `?page=` を読めない** ことが判明した。

現状の型定義 (`packages/router/src/page-props.ts:22-24`):

```ts
export type LoaderArgs<R extends keyof Routes = keyof Routes> = {
  params: Routes[R]["params"];
};
```

`params` のみで request も URL も来ない。ADR 0011 の comment で「将来 `request` / worker context 等が増えたときもここ 1 箇所に足せば、helper を使ってる全 loader が追従する」と予告されていた拡張ポイントの **未着地** が、ちょうど pagination で必要になった瞬間に表面化した。

### action との非対称

`ActionArgs<R>` は既に `request: Request` を受けており (`packages/router/src/action.ts`)、`server.ts:168` で `actionFn({ request, params })` として呼ばれている。loader だけ取り残されている形。

```ts
// 現状の対称性 (loader が劣後)
ActionArgs: {
  request: Request;
  params;
} // ✓ URL / headers / body を読める
LoaderArgs: {
  params;
} // ✗ URL すら読めない
```

action は body を読むため request 必須だが、loader も「URL 由来の情報 (search / pathname / headers)」を読みたい場面は多い (pagination / sort / lang detection / authz による fetch 切替等)。

### Vidro identity からの制約

memory `project_design_north_star`: 「サーバーは初期状態を作って HTML を返す装置、その後の加工は client」哲学。
memory `project_html_first_wire`: HTML transition が default。
memory `project_legibility_test`: 「Web 標準の Request を loader に渡す」と訳せれば OK。

→ ADR 0052 は **client URL state** を独立させた。本 ADR は **server-side rendering 時に URL を読める経路** を埋めるだけで、ADR 0052 の思想とは独立して整合する。両者は「同じ URL を server / client 両側から見られる」二面性を成立させる。

### 設計書 (canonical reference) との整合

`~/brain/docs/エデン 設計書.md` の 5 つの哲学のうち:

- **Hono 的透明性**: `Request` を素のまま渡す → ◎
- **AI-native 規約 / 型貫通**: `LoaderArgs<R>` の generic で route 別 params を narrow しつつ request shape は WinterCG 共通 → ◎
- **Cloudflare Workers primary target (WinterCG)**: `Request` は Workers 標準入力 → ◎

## Options

### A: `searchParams: URLSearchParams` のみ追加 (= ADR 0052 と対称、最小)

```ts
export type LoaderArgs<R> = {
  params: Routes[R]["params"];
  searchParams: URLSearchParams;
};
```

- Pros: ADR 0052 の `searchParams()` と shape が揃う、必要な情報だけ
- Cons: 将来 headers / cookie / body 等が必要になったら型拡張連鎖、Web 標準から離れた専用 shape を作ることになる、Workers 流儀から外れる

### B: `request: Request` を追加 (= action と shape 一致、WinterCG 流儀、採用候補)

```ts
export type LoaderArgs<R> = {
  request: Request;
  params: Routes[R]["params"];
};
```

```ts
// user 側
export async function loader({ request, params }: LoaderArgs<"/notes">) {
  const url = new URL(request.url);
  const page = Number(url.searchParams.get("page") ?? "1");
  return { notes: paginate(notes, page) };
}
```

- Pros: ActionArgs と shape 完全一致 (= 学習コスト 1 箇所で済む)、Workers 流儀、Web 標準の Request で headers / cookie 等も触れる、Hono / Remix と同じ慣習
- Cons: `new URL(request.url)` boilerplate (1 行)、searchParams を取るだけのケースで request 経由は冗長に感じる場面あり

### C: `url: URL` を追加 (= 軽量、parse 済 URL を渡す)

```ts
export type LoaderArgs<R> = {
  url: URL;
  params: Routes[R]["params"];
};
```

- Pros: `new URL(request.url)` の boilerplate なし
- Cons: action が request、loader が url で **shape 非対称が悪化**。headers / cookie が欲しくなったら結局 request も必要 → 二重 surface

### D: A + B 両方 (= 両流派、redundant)

`{ request, searchParams, params }`。`searchParams` は `new URL(request.url).searchParams` の syntactic sugar。

- Cons: 1 つの情報を 2 経路で渡すのは原則 ill (memory `project_legibility_test` 違反気味)、YAGNI。**却下**。

## Decision

**B** を採用。

| 観点                                                | A (searchParams) | B (request)          | C (url) |
| --------------------------------------------------- | ---------------- | -------------------- | ------- |
| ADR 0011 の予告 (`request` 名指し)                  | ✗                | ◎                    | △       |
| ActionArgs との shape 対称                          | ✗                | ◎                    | ✗       |
| WinterCG / Workers 流儀                             | ✗                | ◎                    | △       |
| memory `project_legibility_test` (Web 標準で訳せる) | △                | ◎                    | △       |
| user code 短さ (search だけ取る場合)                | ◎                | △ (1 行 boilerplate) | ◎       |
| 拡張余地 (headers / cookie / body)                  | ✗                | ◎                    | ✗       |
| 実装コスト                                          | 軽               | 軽                   | 軽      |

→ B が compelling。`new URL(request.url)` boilerplate は 1 行で、user 側の typical pattern として吸収可能。重要なのは ActionArgs との対称性と Web 標準への寄せ方。memory `project_design_north_star` の「Hono / Remix の良さを継ぐ」とも整合。

## Implementation

### 型変更 (`packages/router/src/page-props.ts`)

```ts
export type LoaderArgs<R extends keyof Routes = keyof Routes> = {
  request: Request;
  params: Routes[R]["params"];
};
```

`AnyLoader` (内部 helper) も `args: { request: Request; params: any }` に shape 揃える。

### 呼出経路 (`packages/router/src/server.ts`)

`gatherRouteData(path, compiled)` を `gatherRouteData(request, compiled)` に変更。loader 呼び出し時に request を渡す:

```ts
async function runLoader(
  loadFn: ServerModuleLoader | null,
  request: Request,
  params: Record<string, string>,
): Promise<LayerResult> {
  // ...
  const data = await mod.loader({ request, params });
}
```

callsite:

- `handleLoaderEndpoint(url, compiled)` → request を再構築して `gatherRouteData(request, compiled)` に渡す。注意: original request の method / headers を保つには handler の入口で request を引き回す方が筋。`createServerHandler` の dispatch を `(request, ctx)` のまま `handleLoaderEndpoint(request, compiled)` に変える。
- `handleAction` の loader 自動 revalidate 経路: 同じく `gatherRouteData(request, compiled)`。
- `handleNavigation` 経路: 同じく request を渡す。

### `_runtime` 経路の互換

`@vidro/plugin` の serverBoundary は `mod.loader` を直接呼ばず、`route-tree.ts` 経由 (= ServerModuleLoader) で routes を解決する。loader 引数 shape は `runLoader` (server.ts) 1 箇所でしか組まれていないので、変更点は最小。

### dogfood 駆動で発覚した core / design hole

ADR 0053 の dogfood で `<For each={data.notes}>` が pagination の Page 1→2 切替に追従しない bug が発覚。深堀りで以下 3 点が出た。本 ADR に **込みで** 修正する (= dogfood が ADR の検証なので、bug を放置すると ADR の意義が立たない)。

#### 1. `@vidro/core/src/store.ts` — splice の length 不変ケースで subscriber に届かない

- 現象: ADR 0049 diff merge の id-keyed reconcile で `splice(0, 5, ...new5)` 全置換が走るが、length が 5→5 で同じだと `lengthSignal` が `Object.is` 同値スキップで notify されない
- 修正: 構造変化 nonce signal (`structureSignal`) を追加。`length` access 経路で両 signal を track、mutating method 後に `batch` で両方 update。length 不変の要素入れ替え (= splice 全置換 / sort / reverse) も subscriber に届く
- test: `packages/core/tests/store.test.ts` に structural change で length 不変な test ケースを追加

#### 2. `@vidro/core/src/for.ts` — initial run で dependency 未登録のまま return

- 現象: For の effect 内で `initialEffect` フラグで初回スキップしてるが、その前に `each` の readReactiveSource しか呼んでない。`each` が **store array proxy 直接** (= plain T、関数 / Signal を介さない) だと subscribe が一度も成立せず、後続の splice / push でも再 fire しない
- 修正: 初回 invocation でも `void list.length` を読んで dependency 登録。array proxy の length access が structure / length 両方を track するので、要素入れ替えも拾える
- test: 既存 For の test は each に Signal / 関数を渡すケースが多く、plain array proxy 経路が未 cover。dogfood で初めて表面化

#### 3. `<Link href={dynamic}>` は reactive 追従しない (= 仕様)

- 現象: pagination の Prev/Next を `<Link href={buildHref(currentPage.value - 1)}>` で書くと、currentPage 変化で href が更新されない
- 原因: memory `feedback_props_unification_preference` 通り **コンポーネントの props は snapshot**。`wrapComponentProps` (`packages/core/src/jsx.ts`) が transform marker 付き関数を即時評価で展開するので、Link 受け側で props.href は static
- 解決: pagination は `<button onClick={() => navigate(buildHref(currentPage.value - 1))}>` にする。`disabled` / `class` 等の **DOM element 直接 attribute** は `applyProp` で reactive 化されるので追従する。`<a href>` 直書きでも transform 経由で reactive 化される
- 含意: Link primitive で reactive href が欲しいケースは別 ADR 案件 (= primitive 側で href を Signal で受ける拡張)。今は user code で button + navigate に倒すのが Vidro 流。memory `feedback_dx_first_design` で書いた「DX-first」の限界 — props snapshot 哲学を保つなら `<Link>` は最もシンプルなケース用と割り切る

### client → server の search 保持 (`packages/router/src/router.tsx`)

dogfood で気付いた追加 scope。LoaderArgs に request を渡せても、**client 側が server に search を送ってないと loader が `?page=` / `?q=` を読めない**。3 経路あるうち初回 navigate 経路 (handleNavigation) は元から request 全体が server に届くが、以下 2 経路は path しか送っていなかった:

- 経路 2 (= `revalidate()` / `<Link>` で同 page 内 navigate 後の loader 再 fire): `fetchLoaders(pathname)` が `/__loader?path=${pathname}` で送る → search が捨てられる
- 経路 3 (= form submit 後の loader 自動 revalidate): `handleFormSubmit` で `path = action || currentPathname.value` → POST `/notes` で送る → search が捨てられる

修正:

- `fetchLoaders(pathname, search)` に search 引数を追加し、fetch URL を `/__loader?path=${encodeURIComponent(pathname + search)}` にする。bootstrap 比較は pathname のみ (= 初回 hydrate は経路 1 で search 込み HTML が来てるので、bootstrap data の pathname 一致だけで OK)
- effect 内で `const search = window.location.search` を読んで fetchLoaders に渡す
- `handleFormSubmit` で `path = action attr || (currentPathname.value + search)` にする (POST URL に search を載せる)
- `dispatchSubmit` 内の同 path 判定を `new URL(path, origin).pathname === currentPathname.value` に書き換え (path に search を含めても same-page bootstrapData 上書き経路に正しく入る)

これで pagination / filter / sort 等の URL 駆動 server-side state が、初回 navigate / 同 page 内 revalidate / form submit 後 revalidate **全 3 経路で保たれる**。

### test (`packages/router/tests/server-loader.test.ts` 新規)

4 ケース追加:

1. `/__loader` endpoint: `path=/notes?q=Vidro&page=2` で loader.request.url が **route URL に偽装** されている (= `/__loader?...` の文字列を user の loader に晒さない)
2. `/__loader` endpoint: headers (cookie / accept-language) は original request から forward される
3. POST → loader 自動 revalidate: revalidate 時の loader.request.url は POST 先 URL (= search 込み) を保つ
4. 引数を取らない loader (`async () => ({...})`) も互換 (= 関数 contravariance、既存 fixture 破壊しない)

### apps 側 dogfood (= 本 ADR のトリガー)

`apps/router/src/routes/notes/server.ts`:

```ts
const PAGE_SIZE = 5;

export async function loader({ request }: LoaderArgs<"/notes">) {
  const url = new URL(request.url);
  const page = Number(url.searchParams.get("page") ?? "1");
  const q = url.searchParams.get("q") ?? "";
  const filtered = q ? notes.filter((n) => n.title.toLowerCase().includes(q.toLowerCase())) : notes;
  const start = (page - 1) * PAGE_SIZE;
  return {
    notes: filtered.slice(start, start + PAGE_SIZE),
    totalPages: Math.ceil(filtered.length / PAGE_SIZE),
    page,
  };
}
```

`apps/router/src/routes/notes/index.tsx`:

```tsx
const sp = searchParams<{ q?: string; page?: string }>();

// ADR 0052 Path Y dogfood: searchParam 変化を loader 再 fire に bind
effect(() => {
  void sp.page.value;
  void revalidate();
});

// pagination UI (実 page 数は server から)
<nav>
  <Link href={buildHref({ ...sp, page: String(currentPage - 1) })}>Prev</Link>
  <span>{`Page ${currentPage} / ${data.totalPages.value}`}</span>
  <Link href={buildHref({ ...sp, page: String(currentPage + 1) })}>Next</Link>
</nav>;
```

## Migration

破壊的変更だが apps は内部のみ。`packages/router/tests/` の loader を持つ全 fixture を `({ request, params })` shape に書き換え。

外部 user 不在 (= 公開前) なので semver 配慮なし。

## Open Questions

1. **loader が `request.formData()` を読むケース**: action と loader で同 request body を 2 回読むと第 2 回が空になる (`Body already used`)。ただし loader 経路で body を読むのは設計上不要 (= POST は action、GET は loader)。一応 doc で明記。

2. **dev mode の `/__loader?path=X` endpoint で loader が受ける request** (Resolved): `path` は query で来るので `request.url` は `/__loader?path=...`。user の loader が `request.url` を見ると `/__loader?...` が見えて混乱の元。

   **着地**: handleLoaderEndpoint で **`new Request(new URL(path, base), { headers: request.headers })`** で **route の URL に偽装した request** を loader に渡す。本物の `/__loader` request を user に晒さない。`javascript:` / `data:` 等の non-http scheme は `new URL` で base 無視されるので 400 で早期に弾く (= unhandled 500 防止、reviewer fix)。

3. **AsyncLocalStorage 化**: request を loader に渡すと、loader 内から fetch する際に headers (cookie / authorization) を forward したい場面が出る。toy 段階では「user が手で伝搬」する方針 (= Hono 流儀)、AsyncLocalStorage 経由の context は別 ADR (memory `project_pending_rewrites` の SSR concurrency 案件と連動)。

## 関連

- ADR 0011 (`LoaderArgs/ActionArgs` の 1 箇所拡張原則) — 本 ADR の伏線回収
- ADR 0052 (`searchParams()` primitive) — client URL state 経路、本 ADR と対をなす server URL 読み取り経路
- memory `project_pending_rewrites` — SSR concurrency / AsyncLocalStorage 案件 (本 ADR と独立、将来案件)
- memory `project_design_north_star` — Hono 透明性 / WinterCG 流儀
