# 0053 — `LoaderArgs` に `request: Request` を追加: loader が URL / headers を読める経路

## Status

**Proposed** — 2026-05-02 (44th session)

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

### test (`packages/router/tests/`)

- `server.test.ts`: loader が `request` を受けることを検証 (URL から `?page=` を読む test 追加)
- `loader-args.test.ts` (新規 or 既存に追加): `LoaderArgs<"/path">` の型 narrow と request 受け取りを compile-time test

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

2. **dev mode の `/__loader?path=X` endpoint で loader が受ける request**: `path` は query で来るので `request.url` は `/__loader?path=...`。user の loader は「自分が `/notes` の loader」と思って `request.url` を見ると `/__loader?...` が見える。これは混乱の元。

   解決案: handleLoaderEndpoint は **`new Request(new URL(path, base), { headers: request.headers })`** で **route の URL に偽装した request** を loader に渡す。本物の `/__loader` request を user に晒さない。

3. **AsyncLocalStorage 化**: request を loader に渡すと、loader 内から fetch する際に headers (cookie / authorization) を forward したい場面が出る。toy 段階では「user が手で伝搬」する方針 (= Hono 流儀)、AsyncLocalStorage 経由の context は別 ADR (memory `project_pending_rewrites` の SSR concurrency 案件と連動)。

## 関連

- ADR 0011 (`LoaderArgs/ActionArgs` の 1 箇所拡張原則) — 本 ADR の伏線回収
- ADR 0052 (`searchParams()` primitive) — client URL state 経路、本 ADR と対をなす server URL 読み取り経路
- memory `project_pending_rewrites` — SSR concurrency / AsyncLocalStorage 案件 (本 ADR と独立、将来案件)
- memory `project_design_north_star` — Hono 透明性 / WinterCG 流儀
