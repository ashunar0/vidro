// `/__loader` (loader JSON endpoint) と navigation (accept: text/html) の両方を
// 同じ WinterCG fetch handler として提供する。dev では `@cloudflare/vite-plugin`
// が workerd を in-process 起動して全 request をこの handler に流し、prod では
// Cloudflare Workers 向けの server entry が同じ handler を呼ぶ (ADR 0043)。
//
// 入力は `RouteRecord` で、dev / prod ともに `.vidro/route-manifest.ts` から
// 生成された静的 import 版を使う (plugin の routeTypes() が吐く)。
// `compileRoutes` に食わせれば `CompiledRoutes` が得られる設計 (ADR 0012)。
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

import {
  renderToReadableStream,
  renderToStringAsync,
  VIDRO_STREAMING_RUNTIME,
} from "@vidro/core/server";
import {
  compileRoutes,
  diffLayoutChain,
  matchRoute,
  type RouteRecord,
  type ServerModule,
  type ServerModuleLoader,
} from "./route-tree";
import { Router, type ResolvedModules, type SSRProps } from "./router";
import { currentParams, currentPathname } from "./navigation";
import { runWithRequestEnv } from "./request-env-scope";
import { dispatchServerFn, type ServerFnRuntimeEntry } from "./server-fn";

// `getRequestEnv<T>()` を server export にも露出。user は `.server.ts` /
// loader / action / async function component から D1 / KV / 任意の env を取得する。
export { getRequestEnv } from "./request-env-scope";

// ADR 0070 Phase 2c: server function runtime entry の型を server export 経由で
// 露出。plugin 側 (= `.vidro/server-fn-manifest.ts`) が型 import に使う。
export type { ServerFnRuntimeEntry };

/**
 * navigation 処理に必要な per-request context。dev middleware は渡さず、
 * prod entry (Cloudflare Workers) が `env.ASSETS` を assets として注入する。
 *
 * env は Cloudflare Workers の bindings (= D1 / KV / R2 等) や任意の user 側 context を
 * per-request で route 全域に共有する経路。`getRequestEnv<MyEnv>()` で `.server.ts` /
 * loader / action / async function component から型付きで取得できる (= ADR 0066 dogfood
 * から提案、SQLite + Drizzle 統合等)。
 */
export type ServerContext = {
  /** `env.ASSETS` 相当。渡されていれば navigation で index.html を fetch + inject。 */
  assets?: { fetch(request: Request): Promise<Response> };
  /** Cloudflare Workers の env binding 等を per-request で渡す経路。`getRequestEnv<T>()` で取得。 */
  env?: unknown;
};

/** WinterCG 準拠の fetch handler 型。ctx は assets 等の per-request 依存を渡す。 */
export type ServerHandler = (request: Request, ctx?: ServerContext) => Promise<Response>;

export type CreateServerHandlerOptions = {
  manifest: RouteRecord;
  /** loader endpoint path。default: "/__loader" */
  endpoint?: string;
  /**
   * ADR 0070 Phase 2c: server function entries (= URL ↔ handler の table)。
   * `.vidro/server-fn-manifest.ts` から `serverFnManifest` を import して渡す。
   * POST request の dispatch path に組み込まれ、URL match した entry の handler を
   * Phase 1 の serverFn factory 経由で実行 (= middleware chain 込み)。
   *
   * 未指定または空配列なら従来通り (= POST はすべて action 経路に流れる、Pages
   * mode 互換)。AppRouter mode で server function を使う app は plugin が自動
   * 生成する manifest を渡す。
   */
  serverFns?: readonly ServerFnRuntimeEntry[];
};

/**
 * dev / prod 共通の server handler。
 *   1. `/__loader?path=...` → loader 並列実行 + JSON
 *   2. POST request → action 呼出 + loader 自動 revalidate (ADR 0037 Phase 3 R-min)
 *   3. navigation (accept: text/html, ctx.assets あり) → index.html + data inject
 *   4. それ以外 → 404 (entry 側で assets fallback する前提)
 */
export function createServerHandler(options: CreateServerHandlerOptions): ServerHandler {
  const { manifest, endpoint = "/__loader", serverFns } = options;
  const compiled = compileRoutes(manifest);

  return async (request, ctx = {}) => {
    // 全 dispatch path を `runWithRequestEnv` で wrap する。これで loader / action /
    // navigation / `.server.tsx` 内 `getRequestEnv<MyEnv>()` が same scope で env を
    // 引ける。ctx.env が未指定なら null を立てて (= getRequestEnv は throw する側で
    // user に「server entry で env を渡せ」と伝える) Workers 並行 race を回避。
    return runWithRequestEnv(ctx.env ?? null, async () => {
      const url = new URL(request.url);

      if (url.pathname === endpoint) {
        return handleLoaderEndpoint(url, request, compiled);
      }

      // ADR 0061: SPA navigation 用の partial HTML endpoint。`/__loader` と
      // 対称な internal infrastructure。
      if (url.pathname === "/__partial") {
        return handlePartialEndpoint(url, request, manifest, compiled);
      }

      // ADR 0070 Phase 2c: POST → server function dispatch を action より先に
      // 試行。URL は file path 由来 (= 例: `/posts/new/createPost`、関数名 suffix
      // 付き)、Pages mode の action POST URL (= page path = `/posts/new`) とは
      // 構造的に分離されているので衝突しない。match なし (= null) なら body は
      // 未読のまま action に流す (= dispatchServerFn は match 時のみ body を読む)。
      if (request.method === "POST" && serverFns && serverFns.length > 0) {
        const sfRes = await dispatchServerFn(request, serverFns, { env: ctx.env });
        if (sfRes) return sfRes;
      }

      // POST は accept より method 優先で分岐 (form submit / programmatic 両対応)。
      // R-min は form (multipart / x-www-form-urlencoded) 経路のみ。programmatic な
      // useSubmit({json}) は R-mid 以降。
      if (request.method === "POST") {
        return handleAction(url, request, compiled);
      }

      const accept = request.headers.get("accept") ?? "";
      if (ctx.assets && accept.includes("text/html")) {
        return handleNavigation(url, request, ctx.assets, manifest, compiled);
      }

      return new Response(null, { status: 404 });
    });
  };
}

// --- handlers ---

async function handleLoaderEndpoint(
  url: URL,
  request: Request,
  compiled: CompiledFromRoutes,
): Promise<Response> {
  // `path` query は `/notes?q=Vidro&page=2` の形式 (= route 側 URL の pathname+search)。
  // 単純な path だけでなく query も含む点に注意。
  const path = url.searchParams.get("path");
  if (!path) {
    return jsonResponse(400, { error: { message: "missing `path` query" } });
  }
  // ADR 0053 Open Question 2: loader が `request.url` を見たとき `/__loader?path=...`
  // ではなく **route 自身の URL** に見えるよう request を偽装する。headers (cookie /
  // accept-language 等) は original から forward。method は GET 固定 (= /__loader 経路は
  // navigation 用 GET fetch と同等の意味付け)。
  let routeUrl: URL;
  try {
    routeUrl = new URL(path, url.origin);
  } catch {
    return jsonResponse(400, { error: { message: "invalid path" } });
  }
  // `javascript:`, `data:`, `file:` 等の non-http scheme は `new URL(path, base)` で
  // base 無視され non-http URL として解決される。そのまま `new Request` に渡すと
  // TypeError で unhandled 500 になるので clean な 400 に倒す (= reviewer Issue (a))。
  if (routeUrl.protocol !== "http:" && routeUrl.protocol !== "https:") {
    return jsonResponse(400, { error: { message: "invalid path scheme" } });
  }
  const routeRequest = new Request(routeUrl, { headers: request.headers });
  const data = await gatherRouteData(routeRequest, compiled);
  return jsonResponse(200, data);
}

/**
 * POST handler — Phase 3 R-min (ADR 0037) + R-mid-3 (ADR 0042 nested action)
 * + ADR 0068 (action 置き場 + resource route)。
 *
 * action 解決順序 (path 完全一致のみ、deepest-first fallback はしない):
 *   1. leaf の `server.ts` (= match.server.load) に `action` export → これを呼ぶ
 *      (= 既存 user 互換、`server.ts` 優先のため最上位に置く)
 *   2. ADR 0068: leaf route が `index.server.tsx` で `action` named export を持つ
 *      なら、それを呼ぶ (= page と action の co-location 完全形、痛み点 2 解消)
 *   3. ADR 0068: route 不在 + leaf server.ts 不在の時、`server.ts` 単独 directory
 *      (= resource route) を `compiled.servers` から path match で探して呼ぶ
 *      (= 痛み点 6 解消、`/posts/:slug/delete/server.ts` 等を REST 自然に切れる)
 *   4. それも無ければ「pathPrefix が url.pathname と完全一致する layout.server.ts」を
 *      候補に加える (ADR 0042)。loader 不在の layout も想定するため、load 自体は
 *      まず試して action フィールドの有無で判定する。
 *   5. どれも無ければ 405 NoActionError
 *
 * 「完全一致」は動的 segment 対応必須: `pathPrefix = "/users/:id"` は実 URL
 * `"/users/123"` にマッチさせる。LayoutEntry.pattern は **prefix-match** 用
 * (= 子 path も拾う) なのでそのままは使えない。専用の完全一致比較を行う。
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

  const candidates: ServerModuleLoader[] = [];

  // 1. leaf の server.ts (= 既存路線、最優先で `server.ts` 優先 semantics を保持)
  if (match.server) candidates.push(match.server.load);

  // 2. ADR 0068: leaf route が `.server.tsx` の時、その module を action 候補に
  //    追加。dynamic import の戻り値は default + named exports 全部入っているので
  //    ServerModuleLoader 互換 (action フィールド有無を `mod.action` で判定する
  //    既存ループに乗る)。`server.ts` が同 directory にある場合は 1 で先に拾われ
  //    ているので shadow されない (= server.ts 優先、ADR 0068 Decision 論点 3)。
  if (match.route && match.route.filePath.endsWith("/index.server.tsx")) {
    candidates.push(match.route.load as unknown as ServerModuleLoader);
  }

  // 3. ADR 0068: resource route。route 不在 + leaf server.ts 不在の時、
  //    `compiled.servers` から url.pathname に path match する ServerEntry を
  //    探して candidates に積む。`/posts/:slug/delete/server.ts` のような
  //    page を持たない action-only directory が REST 自然に動く。
  //    params も resource route の path pattern から抽出して action に渡す
  //    (= matchRoute は route 不在時 params を空にしてしまうため)。
  let resourceParams: Record<string, string> | null = null;
  if (!match.route && !match.server) {
    const resource = findResourceServer(url.pathname, compiled);
    if (resource) {
      candidates.push(resource.load);
      resourceParams = resource.params;
    }
  }

  // 4. layout.server.ts (= ADR 0042、既存路線)
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
    // resource route の場合は match.params が空なので findResourceServer で
    // 抽出した params を使う。それ以外は match.params (route + layouts 由来)。
    result = await actionFn({ request, params: resourceParams ?? match.params });
  } catch (err) {
    // ADR 0059: action が `throw new Response(...)` した場合 (= validation error
    // 等の意図的 status code) は serialize せずそのまま return する。client 側
    // dispatchSubmit が 4xx + JSON + body has `fields` を判定して sub.fieldError に
    // 流す。
    if (err instanceof Response) return err;
    return jsonResponse(500, { error: serializeError(err) });
  }

  // Response 戻り値はそのまま return (redirect / 任意 status code 用)
  if (result instanceof Response) return result;

  // plain value → action result + loader 自動 revalidate
  // ADR 0053: loader 自動 revalidate は POST 直後の文脈なので、original POST request の
  // body を消費せずに「同 URL で GET っぽく」見える request を偽装して loader に渡す。
  // headers は forward (cookie / accept-language 等を保つ)、method は GET 固定。
  const revalidateRequest = new Request(url.toString(), { headers: request.headers });
  const loaderData = await gatherRouteData(revalidateRequest, compiled);
  return jsonResponse(200, { actionResult: result, loaderData });
}

/**
 * ADR 0061: `/__partial?to=<encoded>&from=<encoded>` を捌く endpoint。
 *
 * - `from` 必須 (= E-α)、不在は 400
 * - to / from は `pathname + search` を encodeURIComponent した値 (= G-α)
 * - 200: partial fragment HTML、`X-Vidro-Diverge-Index` header に divergeIndex
 * - 4xx/5xx: 最小 body (= F-α、client は full reload)
 *
 * `/__loader` と同じ scheme guard で `javascript:` / `data:` 等の non-http URL を
 * 弾く (= reviewer 指摘 pattern と整合)。
 */
async function handlePartialEndpoint(
  url: URL,
  request: Request,
  manifest: RouteRecord,
  compiled: CompiledFromRoutes,
): Promise<Response> {
  const toRaw = url.searchParams.get("to");
  const fromRaw = url.searchParams.get("from");

  if (!toRaw) return new Response("missing `to` query", { status: 400 });
  if (!fromRaw) return new Response("missing `from` query", { status: 400 });

  let toUrl: URL;
  let fromUrl: URL;
  try {
    toUrl = new URL(toRaw, url.origin);
    fromUrl = new URL(fromRaw, url.origin);
  } catch {
    return new Response("invalid `to`/`from` URL", { status: 400 });
  }

  if (toUrl.protocol !== "http:" && toUrl.protocol !== "https:") {
    return new Response("invalid `to` scheme", { status: 400 });
  }
  if (fromUrl.protocol !== "http:" && fromUrl.protocol !== "https:") {
    return new Response("invalid `from` scheme", { status: 400 });
  }

  // routeRequest: loader が `request.url` を見たとき to URL に見えるよう偽装
  // (= /__loader と同じ pattern)。headers (cookie / accept-language 等) は forward。
  const routeRequest = new Request(toUrl, { headers: request.headers });

  let result: { html: string; divergeIndex: number; status: number };
  try {
    result = await renderPartialHTML(toUrl, fromUrl, manifest, compiled, routeRequest);
  } catch {
    // F-α: infrastructure error (= module load 失敗 / unhandled throw 等) は
    // 500 + 最小 body。client は full reload に倒す。
    return new Response("partial render failed", { status: 500 });
  }

  if (result.status !== 200) {
    return new Response("not found", { status: result.status });
  }

  return new Response(result.html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-vidro-diverge-index": String(result.divergeIndex),
    },
  });
}

async function handleNavigation(
  url: URL,
  request: Request,
  assets: NonNullable<ServerContext["assets"]>,
  manifest: RouteRecord,
  compiled: CompiledFromRoutes,
): Promise<Response> {
  // loader 並列実行 と module 並列 load は独立なので Promise.all で並列化。
  // どちらも pathname のみに依存し、互いを参照しない。
  const [data, resolvedModules, indexRes] = await Promise.all([
    gatherRouteData(request, compiled),
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
  //
  // ADR 0052: `search` (= `?q=Vidro` 含む URL の search 部分、無ければ "") を渡し、
  // Router server mode が `_initServerSearch()` でこれを per-request initial 値に
  // 立てる。これで `/notes?q=Vidro` 直打ちで `searchParams().q.value === "Vidro"`
  // が server 側でも成立し、pre-filtered HTML が描画される。
  const routerBootstrap = {
    pathname: url.pathname,
    search: url.search,
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
 * request から全 layer の loader を並列実行し、`{params, layers}` を返す。
 * loader endpoint / navigation の両方が同じ形で data を得るための共通関数。
 *
 * ADR 0053: pathname (string) でなく Request を受ける。loader に request を渡せる
 * ようにした (= URL search / headers / cookie を user 側で読める)。pathname は
 * matchRoute 用に request.url から内部で抽出する。
 */
async function gatherRouteData(
  request: Request,
  compiled: CompiledFromRoutes,
): Promise<{ params: Record<string, string>; layers: LayerResult[] }> {
  const pathname = new URL(request.url).pathname;
  const match = matchRoute(pathname, compiled);
  const layerLoads: Promise<LayerResult>[] = [
    ...match.layouts.map((l) => runLoader(l.serverLoad, request, match.params)),
    runLoader(match.server ? match.server.load : null, request, match.params),
  ];
  const layers = await Promise.all(layerLoads);
  return { params: match.params, layers };
}

type SerializedError = { name: string; message: string; stack?: string };
type LayerResult = { data?: unknown; error?: SerializedError };

async function runLoader(
  loadFn: ServerModuleLoader | null,
  request: Request,
  params: Record<string, string>,
): Promise<LayerResult> {
  if (!loadFn) return { data: undefined };
  try {
    const mod = (await loadFn()) as ServerModule;
    if (!mod.loader) return { data: undefined };
    const data = await mod.loader({ request, params });
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

/**
 * ADR 0068: resource route lookup。`compiled.servers` は ServerEntry の配列で、
 * ServerEntry.path は `"/posts/:slug/delete"` のような pattern string。pathname を
 * 各 entry の path pattern と完全一致させて、entry と抽出した params を返す。
 *
 * 通常 `matchRoute` は route が無いと `match.server` も null にしてしまうので、
 * resource route (= page を持たない server.ts 単独 directory) では handleAction
 * 内でこの helper を使って path match で server を引き当てる。params も併せて
 * 抽出するのは、action に `{ request, params }` で `:slug` 等を渡せる必要がある
 * ため (= matchRoute は route 不在時 params を空にしてしまう)。
 */
function findResourceServer(
  pathname: string,
  compiled: CompiledFromRoutes,
): { load: ServerModuleLoader; params: Record<string, string> } | null {
  for (const server of compiled.servers) {
    const paramNames: string[] = [];
    const source =
      "^" +
      server.path.replace(/:([^/]+)/g, (_, name: string) => {
        paramNames.push(name);
        return "([^/]+)";
      }) +
      "$";
    const m = pathname.match(new RegExp(source));
    if (!m) continue;
    const params: Record<string, string> = {};
    for (let i = 0; i < paramNames.length; i++) {
      params[paramNames[i]!] = m[i + 1]!;
    }
    return { load: server.load, params };
  }
  return null;
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
 * ADR 0061: partial HTML render の中核。to URL / from URL を受け取り、
 * 共通 layout を skip した layer N 以降の HTML fragment を生成して返す。
 *
 * 流れ:
 * 1. to / from の matchRoute → diffLayoutChain で divergeIndex 計算
 * 2. divergeIndex 以降の layout module + leaf module + 全 error module を並列 load
 * 3. divergeIndex 以降の layout の loader + leaf の loader を並列実行
 * 4. Router の SSR mode (= partial: { startIdx: divergeIndex }) で renderToString
 *    → fragment は anchor 無しの partial fragment HTML に
 *
 * 戻り値 status:
 * - 200: 正常 (= loader/render error は ErrorBoundary + error.tsx で吸収済の partial HTML)
 * - 404: to の route 不在 (= notFound) — 現状は最小実装で client は full reload に倒す
 *
 * 共通 prefix の loader data は server で再実行しない (= partial の趣旨)。client 側は
 * 既存の page-level state (= filter / accordion / scroll) を保ったまま layer N 以降の
 * DOM だけ swap する設計と整合 (= ADR 0061 B-β)。
 *
 * notFound 経路の partial 化 (= 200 + notFound page を partial として返す) は
 * 別途 dogfood で必要になったら拡張。
 */
export async function renderPartialHTML(
  toUrl: URL,
  fromUrl: URL,
  manifest: RouteRecord,
  compiled: CompiledFromRoutes,
  request: Request,
): Promise<{ html: string; divergeIndex: number; status: number }> {
  const toMatch = matchRoute(toUrl.pathname, compiled);
  const fromMatch = matchRoute(fromUrl.pathname, compiled);

  if (!toMatch.route) {
    // notFound: 現状は 404 を返して client 側 full reload (= F-α infrastructure error
    // 経路に倒す)。partial 内で notFound page を render する経路は YAGNI。
    return { html: "", divergeIndex: 0, status: 404 };
  }

  const { divergeIndex } = diffLayoutChain(fromMatch, toMatch);
  const partialLayouts = toMatch.layouts.slice(divergeIndex);

  // 並列: leaf module + partial layout modules + 全 error modules
  // (errors は selectErrorMod が match.errors 全体を見るので全 chain load 必要)
  const [route, layouts, errors] = await Promise.all([
    toMatch.route.load() as Promise<RouteModuleLike>,
    Promise.all(partialLayouts.map((l) => l.load() as Promise<RouteModuleLike>)),
    Promise.all(
      toMatch.errors.map((e) => (e.load() as Promise<ErrorModuleLike>).catch(() => null)),
    ),
  ]);

  // 並列: partial layout の loader + leaf の loader
  const layerLoads: Promise<LayerResult>[] = [
    ...partialLayouts.map((l) => runLoader(l.serverLoad, request, toMatch.params)),
    runLoader(toMatch.server ? toMatch.server.load : null, request, toMatch.params),
  ];
  const layers = await Promise.all(layerLoads);

  const ssr: SSRProps = {
    bootstrapData: {
      pathname: toUrl.pathname,
      search: toUrl.search,
      params: toMatch.params,
      layers,
    },
    resolvedModules: {
      route: route as ResolvedModules["route"],
      layouts: layouts as ResolvedModules["layouts"],
      errors: errors as ResolvedModules["errors"],
    },
    partial: { startIdx: divergeIndex },
  };

  // ADR 0066 dogfood: async function component (= `.server.tsx` 内 `await db.x()`
  // 直書き) が partial swap でも動くよう、renderToStringAsync (1-pass async tree walk +
  // AsyncScope.pending allSettled) に切り替え。Suspense なし shell-pass 全 await の
  // 古典 SSR 動作 (ADR 0066 論点 3) でそのまま markup に焼ける。
  // 共通 prefix の per-request scope (currentPathname / currentParams / search /
  // loaderData) は Router の renderServerSide が try/finally で握る。
  const { html } = await renderToStringAsync(() => Router({ routes: manifest, ssr }));

  return { html, divergeIndex, status: 200 };
}

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
