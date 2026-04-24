import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { build, type Plugin, type ResolvedConfig, type ViteDevServer } from "vite-plus";
import { createServerHandler, type ServerHandler } from "@vidro/router/server";
import type { RouteRecord } from "@vidro/router";

// Vidro の server boundary plugin。dev server に `/__loader` の HTTP endpoint を
// 生やし、Router が navigation 時に fetch("/__loader?path=...") を叩くと、
// 対応する server.ts / layout.server.ts の loader を server 側で実行して
// JSON で返す (Remix 式、ADR 0012)。
//
// 案 B-2 Step 1.2 以降: loader 実行本体は `@vidro/router/server` の
// `createServerHandler(manifest)` に委譲し、dev / prod で同じロジックを共有する。
// dev は vite の `server.ssrLoadModule()` を lazy loader に埋めた RouteRecord を、
// prod は `.vidro/route-manifest.ts` (routeTypes() 生成、静的 import 版) を渡す。
//
// client bundle 除外: `.server.{ts,tsx,js,jsx}` を client 側で load したら空
// module を返す。`import.meta.glob("./routes/**/*.{ts,tsx}")` が辿る動的 import も
// 最終的にここを通るので、glob 経由でも中身は漏れない。SSR (opts.ssr === true) は
// serverBoundary 自身が ssrLoadModule で叩く pipeline なので、そちらは通して
// 実体を読ませる。
//
// 案 B-2 Step 1.3: `vp build` (client bundle) 終了後、closeBundle hook で
// vite の programmatic build() を 2nd pass として呼び、`.vidro/server-entry.ts`
// を ssr build して `dist-server/index.mjs` を生成する。Cloudflare Workers 等の
// WinterCG 環境で `wrangler.toml` の `main` として直接参照できる形。再帰阻止は
// `config.build.ssr` が立ってたら抜けるだけで足りる (ssr build 時のみ立つ)。

export type ServerBoundaryOptions = {
  /** routes ディレクトリ (vite root 相対)。default: "src/routes" */
  routesDir?: string;
  /** server entry ファイル (vite root 相対)。default: ".vidro/server-entry.ts" */
  serverEntry?: string;
  /** server build の出力 dir (vite root 相対)。default: "dist-server" */
  serverOutDir?: string;
};

export function serverBoundary(options: ServerBoundaryOptions = {}): Plugin {
  const routesDirOpt = options.routesDir ?? "src/routes";
  const serverEntryOpt = options.serverEntry ?? ".vidro/server-entry.ts";
  const serverOutDirOpt = options.serverOutDir ?? "dist-server";
  let routesDirAbs = "";
  let config: ResolvedConfig | null = null;

  return {
    name: "vidro-server-boundary",
    // vite 内蔵 loader や他 plugin が `.server.ts` の実ファイルを先に返してしまう
    // ことがあるため、pre で先取りしてから stub に差し替える。
    enforce: "pre",
    configResolved(c) {
      config = c;
      routesDirAbs = resolve(c.root, routesDirOpt);
    },
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
          writeJson(res, 500, { error: { message: String(err) } });
        });
      });
    },
    closeBundle: {
      sequential: true,
      order: "post",
      async handler() {
        if (!config) return;
        // dev / preview / serve 等は対象外、`vp build` だけ。
        if (config.command !== "build") return;
        // 2nd pass 本体 (ssr build) 中に closeBundle が再発火しても、
        // build.ssr が立っているのでここで抜ける。再帰阻止。
        if (config.build.ssr) return;

        await build({
          // user の vite.config.ts を自動検出させる (configFile 未指定)。
          // jsxTransform() と routeTypes() は 2nd pass でも走ってほしいが、
          // 再帰の起点である serverBoundary の closeBundle は `build.ssr` で抜ける。
          root: config.root,
          build: {
            ssr: serverEntryOpt,
            outDir: serverOutDirOpt,
            emptyOutDir: true,
            target: "es2022",
            rollupOptions: {
              output: {
                entryFileNames: "index.mjs",
                format: "esm",
              },
            },
          },
          ssr: {
            // Cloudflare Workers (workerd) 向け。Node 向けに出す時は user が
            // 上書きできるよう option 化する余地を残す (YAGNI、今は Workers 一択)。
            target: "webworker",
            // Workers では node_modules を配らないので all inline。
            noExternal: true,
          },
          resolve: {
            // @vidro/router 等が workerd / worker / browser の export
            // condition を持つようになった時に拾えるようにしておく。
            conditions: ["workerd", "worker", "browser"],
          },
        });
      },
    },
  };
}

// --- dev middleware: Node req/res ↔ WinterCG Request/Response 変換 ---

async function handleLoader(
  req: IncomingMessage,
  res: ServerResponse,
  server: ViteDevServer,
  routesDirAbs: string,
): Promise<void> {
  const manifest = await collectRouteModules(routesDirAbs, server);
  // dev middleware は /__loader 専用。navigation (index.html) は vite 本体の
  // middleware が serve するので ctx.assets は渡さない (handler は loader endpoint
  // のみ処理し、それ以外は 404 → next で vite に委譲される)。
  const handler: ServerHandler = createServerHandler({ manifest });
  const request = nodeToRequest(req);
  const response = await handler(request);
  await writeResponse(response, res);
}

function nodeToRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? "localhost";
  const url = `http://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers.set(k, v);
    else if (Array.isArray(v)) for (const vv of v) headers.append(k, vv);
  }
  // loader endpoint は GET only (read-only)。body は渡さない。
  return new Request(url, { method: req.method ?? "GET", headers });
}

async function writeResponse(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((v, k) => res.setHeader(k, v));
  const body = await response.text();
  res.end(body);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

// --- route module collection (dev 固有) ---

// routes/ を walk し、compileRoutes に食わせる RouteRecord を作る。
// server.ts / layout.server.ts は `server.ssrLoadModule(absPath)` で実際に
// 読める関数を埋める。その他 (index.tsx / layout.tsx / error.tsx / not-found.tsx)
// は matchRoute の entry 作成に必要なだけなので、呼ばれないはずの stub を置く。
// prod では plugin の routeTypes() が `.vidro/route-manifest.ts` に同形式の
// RouteRecord を静的 import 版で生成するので、server entry から直接 import して
// createServerHandler に渡す (Step 1.3 で実装)。
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
    if (isServerFile(entry.name)) {
      out[full] = () => server.ssrLoadModule(full);
    } else {
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
