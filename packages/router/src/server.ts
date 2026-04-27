// `/__loader` (loader JSON endpoint) と navigation (accept: text/html) の両方を
// 同じ WinterCG fetch handler として提供する。dev (@vidro/plugin の
// serverBoundary middleware) と prod (Cloudflare Workers 向けの server entry)
// の両方で同じ関数を使う。
//
// 入力は `RouteRecord` で、dev では vite の `server.ssrLoadModule()` を
// lazy loader として埋めたもの、prod では `.vidro/route-manifest.ts` から
// 生成された静的 import 版 (plugin の routeTypes() が吐く)。どちらも
// `compileRoutes` に食わせれば同じ `CompiledRoutes` が得られる設計 (ADR 0012)。
//
// 案 B-2 Phase A (SSR data injection): navigation request には `env.ASSETS` で
// 取得した index.html に `<script type="application/json" id="__vidro_data">` を
// inject する。client 側 Router が初回 mount 時にこの script を読んで
// `/__loader` fetch を skip することで、初回表示の往復数が 3 → 2 に減る。
//
// 案 B-2 Phase B Step B-2c (true SSR): navigation で renderToString を走らせて
// `<div id="app">` の中身として markup を inject する。bootstrap data script は
// hydration (Step B-3) の props 復元源として残す。renderToString が throw した
// ら Phase A 動作に degrade (空 `<div id="app">` + bootstrap data のみ) して、
// client render に逃がす (toy runtime のセーフネット)。

import { renderToReadableStream, VIDRO_STREAMING_RUNTIME } from "@vidro/core/server";
import {
  compileRoutes,
  matchRoute,
  type RouteRecord,
  type ServerModule,
  type ServerModuleLoader,
} from "./route-tree";
import { Router, type ResolvedModules } from "./router";
import { currentParams, currentPathname } from "./navigation";

/**
 * navigation 処理に必要な per-request context。dev middleware は渡さず、
 * prod entry (Cloudflare Workers) が `env.ASSETS` を assets として注入する。
 */
export type ServerContext = {
  /** `env.ASSETS` 相当。渡されていれば navigation で index.html を fetch + inject。 */
  assets?: { fetch(request: Request): Promise<Response> };
};

/** WinterCG 準拠の fetch handler 型。ctx は assets 等の per-request 依存を渡す。 */
export type ServerHandler = (request: Request, ctx?: ServerContext) => Promise<Response>;

export type CreateServerHandlerOptions = {
  manifest: RouteRecord;
  /** loader endpoint path。default: "/__loader" */
  endpoint?: string;
};

/**
 * dev / prod 共通の server handler。
 *   1. `/__loader?path=...` → loader 並列実行 + JSON
 *   2. POST request → action 呼出 + loader 自動 revalidate (ADR 0037 Phase 3 R-min)
 *   3. navigation (accept: text/html, ctx.assets あり) → index.html + data inject
 *   4. それ以外 → 404 (entry 側で assets fallback する前提)
 */
export function createServerHandler(options: CreateServerHandlerOptions): ServerHandler {
  const { manifest, endpoint = "/__loader" } = options;
  const compiled = compileRoutes(manifest);

  return async (request, ctx = {}) => {
    const url = new URL(request.url);

    if (url.pathname === endpoint) {
      return handleLoaderEndpoint(url, compiled);
    }

    // POST は accept より method 優先で分岐 (form submit / programmatic 両対応)。
    // R-min は form (multipart / x-www-form-urlencoded) 経路のみ。programmatic な
    // useSubmit({json}) は R-mid 以降。
    if (request.method === "POST") {
      return handleAction(url, request, compiled);
    }

    const accept = request.headers.get("accept") ?? "";
    if (ctx.assets && accept.includes("text/html")) {
      return handleNavigation(url, ctx.assets, manifest, compiled);
    }

    return new Response(null, { status: 404 });
  };
}

// --- handlers ---

async function handleLoaderEndpoint(url: URL, compiled: CompiledFromRoutes): Promise<Response> {
  const path = url.searchParams.get("path");
  if (!path) {
    return jsonResponse(400, { error: { message: "missing `path` query" } });
  }
  const data = await gatherRouteData(path, compiled);
  return jsonResponse(200, data);
}

/**
 * POST handler — Phase 3 R-min (ADR 0037) + R-mid-3 (ADR 0042 nested action)。
 *
 * action 解決順序 (path 完全一致のみ、deepest-first fallback はしない):
 *   1. leaf の `server.ts` (= match.server.load) に `action` export → これを呼ぶ
 *   2. 1 が無ければ、`pathPrefix === url.pathname` の layout の `layout.server.ts`
 *      に `action` export → これを呼ぶ (ADR 0042、layout が path の owner)
 *   3. どちらも無ければ 405 NoActionError
 *
 * その他の挙動 (R-min から不変):
 *   - action throw → SerializedError JSON で 500 (client 側 submission.error に流す)
 *   - action 戻り値が `Response` → そのまま return (= `Response.redirect()` 経由の
 *     navigation や任意 status code の制御を server side で完結させる)
 *   - plain value 戻り値 → loader を 自動 revalidate して
 *     `{ actionResult, loaderData: {params, layers} }` を JSON で返却
 *
 * loader 自動 revalidate は `gatherRouteData` が全 layer 並列実行するので、
 * leaf action でも layout action でも同じく全 layer revalidate される。
 *
 * R-min は form 経路 (multipart / x-www-form-urlencoded) のみ前提だが、本 handler
 * 自体は content-type を見ない (= action 内で `request.formData()` を呼ぶ user
 * code に委譲)。programmatic な JSON encoding は R-mid-1 (ADR 0038) で対応済。
 */
async function handleAction(
  url: URL,
  request: Request,
  compiled: CompiledFromRoutes,
): Promise<Response> {
  const match = matchRoute(url.pathname, compiled);

  // 1. leaf の server.ts → action を試す
  // 2. 無ければ「pathPrefix が url.pathname と完全一致する layout.server.ts」を
  //    候補に加える (ADR 0042)。loader 不在の layout も想定するため、load 自体は
  //    まず試して action フィールドの有無で判定する。
  //
  //    「完全一致」は動的 segment 対応必須: `pathPrefix = "/users/:id"` は実 URL
  //    `"/users/123"` にマッチさせる。LayoutEntry.pattern は **prefix-match** 用
  //    (= 子 path も拾う) なのでそのままは使えない。専用の完全一致比較を行う。
  const candidates: ServerModuleLoader[] = [];
  if (match.server) candidates.push(match.server.load);
  for (const layout of match.layouts) {
    if (layout.serverLoad && layoutPathMatchesExact(layout.pathPrefix, url.pathname)) {
      candidates.push(layout.serverLoad);
    }
  }

  let actionFn: NonNullable<ServerModule["action"]> | null = null;
  for (const load of candidates) {
    let mod: ServerModule;
    try {
      mod = (await load()) as ServerModule;
    } catch (err) {
      // 単一候補の load 失敗は即 500。複数候補がある場合に一方だけ failed しても
      // user の期待は「該当 module の問題」なので素直に 500 で返す。
      return jsonResponse(500, { error: serializeError(err) });
    }
    if (mod.action) {
      actionFn = mod.action;
      break;
    }
  }

  if (!actionFn) {
    return jsonResponse(405, {
      error: {
        name: "NoActionError",
        message: `no action for route ${url.pathname}`,
      },
    });
  }

  let result: unknown;
  try {
    result = await actionFn({ request, params: match.params });
  } catch (err) {
    return jsonResponse(500, { error: serializeError(err) });
  }

  // Response 戻り値はそのまま return (redirect / 任意 status code 用)
  if (result instanceof Response) return result;

  // plain value → action result + loader 自動 revalidate
  const loaderData = await gatherRouteData(url.pathname, compiled);
  return jsonResponse(200, { actionResult: result, loaderData });
}

async function handleNavigation(
  url: URL,
  assets: NonNullable<ServerContext["assets"]>,
  manifest: RouteRecord,
  compiled: CompiledFromRoutes,
): Promise<Response> {
  // loader 並列実行 と module 並列 load は独立なので Promise.all で並列化。
  // どちらも pathname のみに依存し、互いを参照しない。
  const [data, resolvedModules, indexRes] = await Promise.all([
    gatherRouteData(url.pathname, compiled),
    preloadRouteComponents(manifest, url.pathname),
    assets.fetch(new Request(new URL("/index.html", url.origin).toString())),
  ]);

  if (!indexRes.ok) {
    // index.html が取れなければ 404 を返して entry 側で assets fallback に委譲。
    return new Response(null, { status: 404 });
  }
  const html = await indexRes.text();

  // bootstrap data router 部分のみ。resources は core の renderToReadableStream
  // が tail で `__vidroSetResources(...)` patch script を出すので、shell には
  // 含めない。client 側 Resource は patch 後の `__vidro_data` を hydrate 時に読む。
  const routerBootstrap = {
    pathname: url.pathname,
    params: data.params,
    layers: data.layers,
  };

  // index.html を `<div id="app">[X]</div>` で前後分割 + head に bootstrap data
  // と inline runtime を inject。shell prefix = head + body 開始 + `<div id="app">`、
  // shell suffix = `</div>` 以降。
  const split = splitAppContainer(html);
  if (!split) {
    // template 構造が想定外 (`<div id="app">` 不在) — 404 で entry 側 fallback に委譲
    return new Response(null, { status: 404 });
  }
  const headExtras =
    `<script type="application/json" id="__vidro_data">${escapeJson(routerBootstrap)}</script>` +
    `<script>${VIDRO_STREAMING_RUNTIME}</script>`;
  const shellPrefix = injectIntoHead(split.prefix, headExtras);
  const shellSuffix = split.suffix;

  // Phase C streaming SSR (ADR 0031): shell + tail 形式。core の
  // `renderToReadableStream` は #app 中身 (shell + resources patch + boundary
  // fills) のみ流す。本関数は shell prefix / suffix で挟んで Response body を
  // 組み立てる。shell-pass throw は core の controller.error 経由で client 側
  // が体感する (toy minimum で degrade なし、ADR 0031 論点 9)。
  const appStream = renderToReadableStream(() =>
    Router({
      routes: manifest,
      ssr: { bootstrapData: routerBootstrap, resolvedModules },
    }),
  );
  const composed = composeResponseStream(
    shellPrefix,
    appStream,
    shellSuffix,
    url.pathname,
    data.params,
  );

  return new Response(composed, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * shell prefix → core stream chunks → shell suffix を順に enqueue する合成 stream。
 * core stream を AsyncIterable として消費し、Cloudflare Workers / WinterCG の
 * ReadableStream 機構の上で素直な linear pipe を作る。
 *
 * streaming 中は `currentPathname` / `currentParams` を per-request 値に固定する
 * (boundary-pass は Router の外で動くため、renderServerSide の try/finally だけ
 * では不足。out-of-order full streaming 化までは本 stream 全体で握る方針)。
 * Workers 並行 request の race は project_pending_rewrites で AsyncLocalStorage
 * 化 (旧記録の延長) する宿題。
 */
function composeResponseStream(
  prefix: string,
  inner: ReadableStream<Uint8Array>,
  suffix: string,
  pathname: string,
  params: Record<string, string>,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const prevPathname = currentPathname.value;
      const prevParams = currentParams.value;
      currentPathname.value = pathname;
      currentParams.value = params;
      try {
        controller.enqueue(enc.encode(prefix));
        const reader = inner.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) controller.enqueue(value);
          }
        } finally {
          reader.releaseLock();
        }
        controller.enqueue(enc.encode(suffix));
      } finally {
        currentPathname.value = prevPathname;
        currentParams.value = prevParams;
        controller.close();
      }
    },
  });
}

// --- shared: loader gather ---

type CompiledFromRoutes = ReturnType<typeof compileRoutes>;

/**
 * pathname から全 layer の loader を並列実行し、`{params, layers}` を返す。
 * loader endpoint / navigation の両方が同じ形で data を得るための共通関数。
 */
async function gatherRouteData(
  path: string,
  compiled: CompiledFromRoutes,
): Promise<{ params: Record<string, string>; layers: LayerResult[] }> {
  const match = matchRoute(path, compiled);
  const layerLoads: Promise<LayerResult>[] = [
    ...match.layouts.map((l) => runLoader(l.serverLoad, match.params)),
    runLoader(match.server ? match.server.load : null, match.params),
  ];
  const layers = await Promise.all(layerLoads);
  return { params: match.params, layers };
}

type SerializedError = { name: string; message: string; stack?: string };
type LayerResult = { data?: unknown; error?: SerializedError };

async function runLoader(
  loadFn: ServerModuleLoader | null,
  params: Record<string, string>,
): Promise<LayerResult> {
  if (!loadFn) return { data: undefined };
  try {
    const mod = (await loadFn()) as ServerModule;
    if (!mod.loader) return { data: undefined };
    const data = await mod.loader({ params });
    return { data };
  } catch (err) {
    return { error: serializeError(err) };
  }
}

function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { name: "Error", message: String(err) };
}

/**
 * ADR 0042 の layout action 解決用、`pathPrefix` と pathname の **完全一致**比較。
 * 動的 segment (例: `/users/:id`) は実 URL の対応 segment 1 個と任意マッチさせる。
 *
 * - `pathPrefix === ""` (root layout) は pathname が "/" の場合のみ true
 * - その他は `:name` を `[^/]+` に置換した完全一致 RegExp で test
 */
function layoutPathMatchesExact(prefix: string, pathname: string): boolean {
  if (prefix === "") return pathname === "/";
  const source = "^" + prefix.replace(/:([^/]+)/g, "[^/]+") + "$";
  return new RegExp(source).test(pathname);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// --- Phase B: preload helpers (renderToString 用) ---
// Router の server mode は sync fold するので、dynamic import は呼び側が
// 事前に await しておく必要がある。manifest + pathname から match を計算し、
// layout / leaf (or not-found) / error.tsx の全 modules を並列 load して
// `ResolvedModules` で返す (ADR 0017)。
//
// 個別 error.tsx の load 失敗は client mode と同じく null に吸収。leaf / layout
// の load 失敗はここで throw (呼び側の createServerHandler が捕捉する)。

/** client mode の `RouteModule` / `ErrorModule` と同じ shape (router.tsx と揃える) */
type RouteModuleLike = { default: (props: Record<string, unknown>) => unknown };
type ErrorModuleLike = {
  default: (props: {
    error: unknown;
    reset: () => void;
    params: Record<string, string>;
  }) => unknown;
};

/**
 * pathname から match を計算し、必要な modules を全部並列 load する。
 * `renderToString(<Router ssr={{resolvedModules, bootstrapData}} />)` の前に呼ぶ。
 */
export async function preloadRouteComponents(
  manifest: RouteRecord,
  pathname: string,
): Promise<ResolvedModules> {
  const compiled = compileRoutes(manifest);
  const match = matchRoute(pathname, compiled);

  // leaf: match.route があればそれ、無ければ not-found.tsx、どちらも無ければ null
  const leafLoader = match.route ? match.route.load : compiled.notFound?.load;

  const [route, layouts, errors] = await Promise.all([
    leafLoader
      ? (leafLoader() as Promise<RouteModuleLike>).catch(() => null)
      : Promise.resolve(null),
    Promise.all(match.layouts.map((l) => l.load() as Promise<RouteModuleLike>)),
    Promise.all(match.errors.map((e) => (e.load() as Promise<ErrorModuleLike>).catch(() => null))),
  ]);

  return {
    route: route as ResolvedModules["route"],
    layouts: layouts as ResolvedModules["layouts"],
    errors: errors as ResolvedModules["errors"],
  };
}

// --- HTML splitting / injection (Phase C streaming) ---

/**
 * index.html を `<div id="app">[X]</div>` で前後分割。
 *   prefix: 先頭から `<div id="app"...>` (開きタグ含む) まで
 *   suffix: `</div>` (#app の閉じ) から末尾まで
 *
 * 属性 (class / data-* 等) が将来増えても耐えるよう、開きタグは regex で吸収。
 * `<div id="app">` が無いか、対応する `</div>` を見つけられなければ null。
 */
function splitAppContainer(html: string): { prefix: string; suffix: string } | null {
  // `id="app"` の直後は `>` か whitespace で区切られているはず (`appx` 等の混入回避)。
  const openRe = /<div\s+id="app"(?=[\s>])[^>]*>/i;
  const openMatch = openRe.exec(html);
  if (!openMatch) return null;
  const openEnd = openMatch.index + openMatch[0].length;
  // `<div id="app">` 内に nested `<div>` があると単純な indexOf では誤マッチする。
  // toy 段階の index.html template は `<div id="app"></div>` 形式 (nested なし)
  // を前提として直近 `</div>` を取る。将来 nested 対応するなら proper HTML parser
  // が必要 (router_pending_rewrites で記録)。
  const closeIdx = html.indexOf("</div>", openEnd);
  if (closeIdx < 0) return null;
  return {
    prefix: html.slice(0, openEnd),
    suffix: html.slice(closeIdx),
  };
}

/**
 * `</head>` の直前に `extras` を inject。`</head>` が無ければ `<body>` 直前、
 * それも無ければ末尾に append。bootstrap script + inline runtime を head に
 * 入れることで、shell flush 時点で client 側に届く順序を保証する。
 */
function injectIntoHead(htmlPrefix: string, extras: string): string {
  if (htmlPrefix.includes("</head>")) {
    return htmlPrefix.replace("</head>", `${extras}</head>`);
  }
  if (htmlPrefix.includes("<body")) {
    return htmlPrefix.replace(/<body\b/, `${extras}<body`);
  }
  return htmlPrefix + extras;
}

/**
 * `<script type="application/json">` 内に embed する用の JSON escape (XSS 対策、
 * Next.js の __NEXT_DATA__ と同じアプローチ — `<` を `<` に置換して
 * `</script>` 閉じを防ぐ)。
 */
function escapeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
