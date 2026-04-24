import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import type { Plugin, ViteDevServer } from "vite-plus";
import {
  compileRoutes,
  matchRoute,
  type RouteRecord,
  type ServerModule,
  type ServerModuleLoader,
} from "@vidro/router";

// Vidro の server boundary plugin。dev server に `/__loader` の HTTP endpoint を
// 生やし、Router が navigation 時に fetch("/__loader?path=...") を叩くと、
// 対応する server.ts / layout.server.ts の loader を server 側で実行して
// JSON で返す (Remix 式)。これにより `.server.ts` の中身が client bundle に
// 混ざらず、DB credential / server-only logic を client に晒さない (ADR 0012 予定)。
//
// Step 2: route 解決 + loader 並列実行 + JSON 返却。
//   Step 3 で Router を RPC モードに切替、Step 4 で client bundle 除外。

export type ServerBoundaryOptions = {
  /** routes ディレクトリ (vite root 相対)。default: "src/routes" */
  routesDir?: string;
};

export function serverBoundary(options: ServerBoundaryOptions = {}): Plugin {
  const routesDirOpt = options.routesDir ?? "src/routes";
  let routesDirAbs = "";

  return {
    name: "vidro-server-boundary",
    configResolved(config) {
      routesDirAbs = resolve(config.root, routesDirOpt);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith("/__loader")) return next();
        handleLoader(req, res, server, routesDirAbs).catch((err) => {
          console.error("[serverBoundary] unexpected error:", err);
          respondJson(res, 500, { error: { message: String(err) } });
        });
      });
    },
  };
}

// --- request handler ---

async function handleLoader(
  req: IncomingMessage,
  res: ServerResponse,
  server: ViteDevServer,
  routesDirAbs: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.searchParams.get("path");
  if (!path) {
    respondJson(res, 400, { error: { message: "missing `path` query" } });
    return;
  }

  const modules = await collectRouteModules(routesDirAbs, server);
  const compiled = compileRoutes(modules);
  const match = matchRoute(path, compiled);

  // 各 layer の loader を並列実行 (Router 側の runServerLoader と同じ形)。
  // layouts は浅い → 深い順、最後が leaf。Router 側の `loaderResults` 並びに合わせる。
  const layerLoads = [
    ...match.layouts.map((l) => runLoader(l.serverLoad, match.params)),
    runLoader(match.server ? match.server.load : null, match.params),
  ];
  const layers = await Promise.all(layerLoads);

  respondJson(res, 200, { params: match.params, layers });
}

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

type SerializedError = { name: string; message: string; stack?: string };

function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { name: "Error", message: String(err) };
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

// --- route module collection (server-side) ---

// routes/ を walk し、compileRoutes に食わせる RouteRecord を作る。
// server.ts / layout.server.ts は `server.ssrLoadModule(absPath)` で実際に
// 読める関数。その他 (index.tsx / layout.tsx / error.tsx / not-found.tsx) は
// matchRoute の entry 作成に必要なだけなので、呼ばれないはずの stub loader を置く。
async function collectRouteModules(
  routesDirAbs: string,
  server: ViteDevServer,
): Promise<RouteRecord> {
  const out: RouteRecord = {};
  if (!existsSync(routesDirAbs)) return out;
  await walk(routesDirAbs, out, server);
  return out;
}

async function walk(dir: string, out: RouteRecord, server: ViteDevServer): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out, server);
      continue;
    }
    if (!isRouteFile(entry.name)) continue;
    // compileRoutes は filePath を `.replace(/^.*?\/routes/, "")` で解釈するので、
    // 絶対パスを渡しても "/routes/..." 部以降を正しく取り出せる。
    if (isServerFile(entry.name)) {
      out[full] = () => server.ssrLoadModule(full);
    } else {
      // tsx は matchRoute のために entry を作る目的でしか使わない。load は走らない。
      out[full] = stubLoader;
    }
  }
}

function isRouteFile(name: string): boolean {
  return (
    name === "index.tsx" ||
    name === "layout.tsx" ||
    name === "server.ts" ||
    name === "layout.server.ts" ||
    name === "error.tsx" ||
    name === "not-found.tsx"
  );
}

function isServerFile(name: string): boolean {
  return name === "server.ts" || name === "layout.server.ts";
}

const stubLoader = (): Promise<unknown> => Promise.resolve({});
