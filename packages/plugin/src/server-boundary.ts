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
// Step 3: Router を RPC モードに切替 (既存 runServerLoader 廃止)。
// Step 4: load hook で client 環境での `.server.{ts,tsx,js,jsx}` を空 module に
//   差し替え、client bundle に中身が含まれないようにする。SSR 側 (/__loader の
//   ssrLoadModule 経由) は `opts.ssr === true` で通す。

export type ServerBoundaryOptions = {
  /** routes ディレクトリ (vite root 相対)。default: "src/routes" */
  routesDir?: string;
};

export function serverBoundary(options: ServerBoundaryOptions = {}): Plugin {
  const routesDirOpt = options.routesDir ?? "src/routes";
  let routesDirAbs = "";

  return {
    name: "vidro-server-boundary",
    // vite 内蔵 loader や他 plugin が `.server.ts` の実ファイルを先に返してしまう
    // ことがあるため、pre で先取りしてから stub に差し替える。
    enforce: "pre",
    configResolved(config) {
      routesDirAbs = resolve(config.root, routesDirOpt);
    },
    // client bundle 除外: `.server.{ts,tsx,js,jsx}` を client 側で load したら
    // 空 module を返す。`import.meta.glob("./routes/**/*.{ts,tsx}")` が辿る
    // 動的 import も最終的にここを通るので、glob 経由でも中身は漏れない。
    // SSR (opts.ssr === true) は serverBoundary 自身が ssrLoadModule で叩く
    // pipeline なので、そちらは通して実体を読ませる。
    load(id, opts) {
      if (opts?.ssr) return null;
      if (!isServerOnlyId(id)) return null;
      return "export {}";
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

// client 側で stub に差し替える id 判定。query string (`?import` / `?url` 等) を
// 剥がしてから basename を見る。Vidro の routes 下では:
//   - leaf route loader: `server.ts`
//   - layout loader: `layout.server.ts`
// 加えて `*.server.{ts,tsx,js,jsx}` (設計書の `.server.ts` 拡張子規約) も保険で拾う。
function isServerOnlyId(id: string): boolean {
  const clean = id.split("?")[0] ?? id;
  const name = clean.replace(/^.*[\\/]/, "");
  if (name === "server.ts" || name === "layout.server.ts") return true;
  return /\.server\.(ts|tsx|js|jsx)$/.test(clean);
}

const stubLoader = (): Promise<unknown> => Promise.resolve({});
