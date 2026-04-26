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

import { renderToString } from "@vidro/core/server";
import {
  compileRoutes,
  matchRoute,
  type RouteRecord,
  type ServerModule,
  type ServerModuleLoader,
} from "./route-tree";
import { Router, type ResolvedModules } from "./router";

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
 *   2. navigation (accept: text/html, ctx.assets あり) → index.html + data inject
 *   3. それ以外 → 404 (entry 側で assets fallback する前提)
 */
export function createServerHandler(options: CreateServerHandlerOptions): ServerHandler {
  const { manifest, endpoint = "/__loader" } = options;
  const compiled = compileRoutes(manifest);

  return async (request, ctx = {}) => {
    const url = new URL(request.url);

    if (url.pathname === endpoint) {
      return handleLoaderEndpoint(url, compiled);
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

  // SSR markup を build。renderToString が throw したら Phase A degrade
  // (空 `<div id="app">` のまま) で client render に逃がす。
  let appHTML = "";
  try {
    appHTML = renderToString(() =>
      Router({
        routes: manifest,
        ssr: {
          bootstrapData: { pathname: url.pathname, params: data.params, layers: data.layers },
          resolvedModules,
        },
      }),
    );
  } catch (err) {
    console.error("[vidro] renderToString failed, degrading to client render:", err);
  }

  const withApp = injectAppHTML(html, appHTML);
  const injected = injectBootstrapData(withApp, data);

  return new Response(injected, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
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
  const leafLoader = match.route ? match.route.load : compiled.notFound;

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

// --- HTML injection ---

/**
 * `<div id="app">...</div>` の中身を `appHTML` で差し替える。属性 (class /
 * data-* 等) が将来増えても耐えるよう正規表現で `<div id="app"...>` を吸収する。
 * match しなければ html をそのまま返す (template が書き換わってる想定の保険)。
 */
function injectAppHTML(html: string, appHTML: string): string {
  // `id="app"` の直後は `>` か whitespace で区切られているはず (`appx` 等の混入回避)。
  // `\b` は `"` ↔ `>` の両 non-word では成立しないので明示的な lookahead を使う。
  const re = /<div\s+id="app"(?=[\s>])[^>]*>[\s\S]*?<\/div>/i;
  if (!re.test(html)) return html;
  return html.replace(re, (match) => {
    // 元 div の開きタグ部分だけ保持して中身を差し替える。属性は維持。
    const openTag = match.match(/<div\s+id="app"(?=[\s>])[^>]*>/i)?.[0] ?? '<div id="app">';
    return `${openTag}${appHTML}</div>`;
  });
}

/**
 * `<script type="application/json" id="__vidro_data">` を `</head>` 直前に inject。
 * JSON.stringify の結果は `<` を `<` に置換することで `</script>` を含めない
 * (XSS 対策、Next.js の __NEXT_DATA__ と同じアプローチ)。
 */
function injectBootstrapData(html: string, data: unknown): string {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const scriptTag = `<script type="application/json" id="__vidro_data">${json}</script>`;
  if (html.includes("</head>")) {
    return html.replace("</head>", `${scriptTag}</head>`);
  }
  // `</head>` が無い (minimal index.html) 場合は `</body>` の手前 or 末尾に append。
  if (html.includes("</body>")) {
    return html.replace("</body>", `${scriptTag}</body>`);
  }
  return html + scriptTag;
}
