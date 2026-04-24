// `/__loader` endpoint の実装を WinterCG fetch handler として提供する。
// dev (@vidro/plugin の serverBoundary middleware) と prod (Cloudflare Workers
// 向けの server entry、案 B-2 Step 1.3 で追加) の両方で同じ関数を使う。
//
// 入力は `RouteRecord` で、dev では vite の `server.ssrLoadModule()` を
// lazy loader として埋めたもの、prod では `.vidro/route-manifest.ts` から
// 生成された静的 import 版 (plugin の routeTypes() が吐く)。どちらも
// `compileRoutes` に食わせれば同じ `CompiledRoutes` が得られる設計 (ADR 0012)。

import {
  compileRoutes,
  matchRoute,
  type RouteRecord,
  type ServerModule,
  type ServerModuleLoader,
} from "./route-tree";

/** WinterCG 準拠の fetch handler 型。Cloudflare Workers の `fetch(req)` もこの形。 */
export type ServerHandler = (request: Request) => Promise<Response>;

export type CreateServerHandlerOptions = {
  /** loader endpoint path。default: "/__loader" */
  endpoint?: string;
};

/** `/__loader?path=...` を受けて全 layer の loader を並列実行し JSON で返す handler。 */
export function createServerHandler(
  manifest: RouteRecord,
  options: CreateServerHandlerOptions = {},
): ServerHandler {
  const endpoint = options.endpoint ?? "/__loader";
  const compiled = compileRoutes(manifest);

  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== endpoint) {
      return new Response(null, { status: 404 });
    }
    const path = url.searchParams.get("path");
    if (!path) {
      return jsonResponse(400, { error: { message: "missing `path` query" } });
    }

    const match = matchRoute(path, compiled);
    // 各 layer を Promise.all で並列実行 (Remix 式)。layouts は浅い → 深い順、
    // 最後が leaf。Router 側の `loaderResults` 並びと一致させる。
    const layerLoads: Promise<LayerResult>[] = [
      ...match.layouts.map((l) => runLoader(l.serverLoad, match.params)),
      runLoader(match.server ? match.server.load : null, match.params),
    ];
    const layers = await Promise.all(layerLoads);
    return jsonResponse(200, { params: match.params, layers });
  };
}

// --- internal ---

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
