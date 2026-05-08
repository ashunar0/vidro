import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { Plugin } from "vite";

// routes/ ディレクトリを walk して `.vidro/` 配下の静的 artifact を生成する
// vite plugin。生成物は 3 種類:
//
// 1. `.vidro/routes.d.ts` — `RouteMap` interface の module augmentation。
//    `routes/users/[id]/index.tsx` から `"/users/:id": { params: { id: string } }`
//    を起こして Routes 辞書経由で LoaderArgs<R> / PageProps<typeof loader> を
//    type-safe に使えるようにする (ADR 0011)。
// 2. `.vidro/route-manifest.ts` — server bundle 向けの **静的 import** による
//    `RouteRecord`。dev は vite の `server.ssrLoadModule()` で loader を
//    on-the-fly 読み込みするが、prod の Cloudflare Workers では動的 fs 読みが
//    できないので、build 時に全 `.server.ts` / `layout.server.ts` を静的 import
//    で並べた manifest を生成して server entry から読む (案 B-2 Step 1.1)。
// 3. `.vidro/server-entry.ts` — Cloudflare Workers 向け fetch handler entry。
//    manifest を読み `createServerHandler(routeManifest)` を `{ fetch }` として
//    default export する固定 snippet。`@cloudflare/vite-plugin` が
//    `wrangler.toml` 経由で source を直接読み、dev では workerd in-process、
//    prod では `.vidro/build/ssr/index.js` に bundle して deploy 可能形にする (ADR 0043)。
//
// 置き場は vite root 直下の `.vidro/` に集約 (ADR 0013)。user の tsconfig.app.json
// で `include: ["src", ".vidro/**/*.d.ts"]` のように `.vidro/` 配下の auto-gen
// `routes.d.ts` を取り込んでもらう (ADR 0046 で extends 路線から inline に移行)。

export type RouteTypesOptions = {
  /** routes ディレクトリ (vite root 相対)。default: "src/routes" */
  routesDir?: string;
  /** 出力先 .d.ts (vite root 相対)。default: ".vidro/routes.d.ts" */
  outFile?: string;
  /** 出力先 manifest .ts (vite root 相対)。default: ".vidro/route-manifest.ts" */
  manifestFile?: string;
  /** 出力先 server entry (vite root 相対)。default: ".vidro/server-entry.ts" */
  serverEntryFile?: string;
  /**
   * Per-route `+types.d.ts` の出力 base ディレクトリ (vite root 相対)。default: ".vidro/+types"
   *
   * ADR 0067: 各 route directory ごとに `Route` namespace を export する `+types.d.ts`
   * を生成する。tsconfig.json の `rootDirs: ["./src", "./.vidro/+types"]` 設定で
   * `src/routes/posts/[slug]/index.server.tsx` から `./+types` が `.vidro/+types/routes/posts/[slug]/+types.d.ts`
   * に解決される (= path B、per-route codegen 主軸)。
   */
  plusTypesDir?: string;
};

/** @vidro/plugin の routeTypes plugin 本体。 */
export function routeTypes(options: RouteTypesOptions = {}): Plugin {
  const routesDirOpt = options.routesDir ?? "src/routes";
  // 生成物は vite root 直下の `.vidro/` に集約 (SvelteKit `.svelte-kit/` /
  // Astro `.astro/` 式)。`.gitignore` に `.vidro/` を入れて artifact 扱いにする。
  const outFileOpt = options.outFile ?? ".vidro/routes.d.ts";
  const manifestFileOpt = options.manifestFile ?? ".vidro/route-manifest.ts";
  const serverEntryFileOpt = options.serverEntryFile ?? ".vidro/server-entry.ts";
  const plusTypesDirOpt = options.plusTypesDir ?? ".vidro/+types";

  let routesDirAbs = "";
  let outFileAbs = "";
  let manifestFileAbs = "";
  let serverEntryFileAbs = "";
  let plusTypesDirAbs = "";

  return {
    name: "vidro-route-types",
    async configResolved(config) {
      routesDirAbs = resolve(config.root, routesDirOpt);
      outFileAbs = resolve(config.root, outFileOpt);
      manifestFileAbs = resolve(config.root, manifestFileOpt);
      serverEntryFileAbs = resolve(config.root, serverEntryFileOpt);
      plusTypesDirAbs = resolve(config.root, plusTypesDirOpt);
      await generateAll(
        routesDirAbs,
        outFileAbs,
        manifestFileAbs,
        serverEntryFileAbs,
        plusTypesDirAbs,
      );
    },
    async buildStart() {
      // watch 外から呼ばれる CLI (vp build 等) でも確実に生成されるよう二重化。
      await generateAll(
        routesDirAbs,
        outFileAbs,
        manifestFileAbs,
        serverEntryFileAbs,
        plusTypesDirAbs,
      );
    },
    configureServer(server) {
      // routesDir 配下の routable file の add/unlink/rename で再生成。
      // 既存ファイルの編集は artifact の形を変えないので listen しない (再生成
      // コストを抑える)。
      const handler = async (file: string) => {
        if (!file.startsWith(routesDirAbs)) return;
        if (!isRouteShapeFile(file)) return;
        await generateAll(
          routesDirAbs,
          outFileAbs,
          manifestFileAbs,
          serverEntryFileAbs,
          plusTypesDirAbs,
        );
      };
      server.watcher.on("add", handler);
      server.watcher.on("unlink", handler);
      // dir 単位の削除 (rename 等) は file 粒度の event が来ないことがあるので
      // 無条件で regenerate する。routes 数が多くない toy runtime 段階では十分。
      server.watcher.on("unlinkDir", () => {
        void generateAll(
          routesDirAbs,
          outFileAbs,
          manifestFileAbs,
          serverEntryFileAbs,
          plusTypesDirAbs,
        );
      });
    },
  };
}

// --- internal helpers ---

type RouteFileKind =
  | "index"
  | "index.server"
  | "layout"
  | "server"
  | "layout.server"
  | "error"
  | "not-found";

type RouteFile = {
  kind: RouteFileKind;
  absPath: string;
};

// ADR 0058 + ADR 0060: `index.server.tsx` (= server-only component file) も leaf
// route として扱う。`index.tsx` と URL pattern は同じで dedupe される。
const ROUTE_FILE_KIND: Record<string, RouteFileKind> = {
  "index.tsx": "index",
  "index.server.tsx": "index.server",
  "layout.tsx": "layout",
  "server.ts": "server",
  "layout.server.ts": "layout.server",
  "error.tsx": "error",
  "not-found.tsx": "not-found",
};

function basenameOf(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? "";
}

function isRouteShapeFile(filePath: string): boolean {
  return basenameOf(filePath) in ROUTE_FILE_KIND;
}

// routes/ を再帰的に walk し、規約上の routable file を全部拾う。
async function collectRouteFiles(routesDirAbs: string): Promise<RouteFile[]> {
  if (!existsSync(routesDirAbs)) return [];
  const files: RouteFile[] = [];
  await walk(routesDirAbs, files);
  // 決定的な生成のため absPath でソート (input の readdir 順に依存させない)。
  files.sort((a, b) => a.absPath.localeCompare(b.absPath));
  return files;
}

async function walk(dir: string, out: RouteFile[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      await walk(full, out);
      continue;
    }
    const kind = ROUTE_FILE_KIND[entry.name];
    if (!kind) continue;
    out.push({ kind, absPath: full });
  }
}

// "/Users/.../routes/users/[id]/server.ts" → "/routes/users/[id]/server.ts"
// compileRoutes は filePath を `.replace(/^.*?\/routes/, "")` で解釈するので、
// "/routes/" を含む形にしておけば absolute / relative どちらでも同じ解釈になる。
function toManifestKey(absPath: string, routesDirAbs: string): string {
  const suffix = absPath.slice(routesDirAbs.length).replace(/\\/g, "/");
  return `/routes${suffix}`;
}

// dirToRoutePath: "users/[id]" → "/users/:id"、"" (routes 直下) → "/"
function dirToRoutePath(rel: string): string {
  if (rel === "") return "/";
  const parts = rel.split(/[\\/]/).map((p) => p.replace(/^\[([^\]]+)\]$/, ":$1"));
  return "/" + parts.join("/");
}

// "/users/:id" から ["id"]、"/" から []
function extractParams(path: string): string[] {
  const names: string[] = [];
  const re = /:([^/]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) names.push(m[1]!);
  return names;
}

// --- renderers ---

function renderDts(files: RouteFile[], routesDirAbs: string): string {
  // index.tsx / index.server.tsx / layout.tsx が存在する dir の URL pattern を
  // dir 単位で dedupe。ADR 0058 + ADR 0060: `index.server.tsx` も同じ URL pattern。
  const set = new Set<string>();
  for (const f of files) {
    if (f.kind !== "index" && f.kind !== "index.server" && f.kind !== "layout") continue;
    const relDir = relative(routesDirAbs, dirname(f.absPath));
    set.add(dirToRoutePath(relDir));
  }
  const paths = Array.from(set).sort();

  const lines: string[] = [];
  lines.push("// AUTO-GENERATED by @vidro/plugin routeTypes() — DO NOT EDIT");
  // side effect import で @vidro/router の module resolution を確実に発火させ、
  // その上で interface augmentation を重ねる。
  lines.push('import "@vidro/router";');
  lines.push("");
  lines.push('declare module "@vidro/router" {');
  lines.push("  interface RouteMap {");
  for (const p of paths) {
    const params = extractParams(p);
    const paramsType =
      params.length === 0
        ? "Record<string, never>"
        : `{ ${params.map((n) => `${n}: string`).join("; ")} }`;
    lines.push(`    "${p}": { params: ${paramsType} };`);
  }
  lines.push("  }");
  lines.push("}");
  return lines.join("\n") + "\n";
}

function renderManifest(files: RouteFile[], routesDirAbs: string, manifestFileAbs: string): string {
  // server.ts / layout.server.ts は静的 import で実 module をロード、それ以外の
  // SSR Phase B (Step B-2c) 以降は tsx 系も renderToString で評価する必要があり、
  // 全ファイル (server.ts / layout.server.ts / *.tsx) を実 import で並べる。
  // server bundle のみで使われるため client bundle 肥大化には影響しない。
  const manifestDir = dirname(manifestFileAbs);

  const lines: string[] = [];
  lines.push("// AUTO-GENERATED by @vidro/plugin routeTypes() — DO NOT EDIT");
  lines.push("// prod server bundle 向け: 全 route ファイルを静的 import で並べた RouteRecord。");
  lines.push("// tsx 系も renderToString で server 評価されるため実 import が必要 (ADR 0018)。");
  lines.push("");
  lines.push('import type { RouteRecord } from "@vidro/router";');
  lines.push("");

  files.forEach((f, i) => {
    const relImport = relative(manifestDir, f.absPath).replace(/\\/g, "/");
    const importPath = relImport.startsWith(".") ? relImport : `./${relImport}`;
    lines.push(`import * as m${i} from "${importPath}";`);
  });
  if (files.length > 0) lines.push("");

  lines.push("export const routeManifest: RouteRecord = {");
  files.forEach((f, i) => {
    const key = toManifestKey(f.absPath, routesDirAbs);
    lines.push(`  "${key}": () => Promise.resolve(m${i}),`);
  });
  lines.push("};");
  return lines.join("\n") + "\n";
}

// ADR 0067: 各 route directory ごとの `+types.d.ts` を生成する。
// 出力位置は `<plusTypesDirAbs>/routes/<relDir>/+types.d.ts` で、user 側 tsconfig の
// `rootDirs: ["./src", "./.vidro/+types"]` 経由で `src/routes/.../*.tsx` から見た
// `./+types` がこのファイルに解決される (= per-route auto type lookup)。
//
// 各 +types.d.ts は `Route` namespace を export し、5 type を載せる:
//   - PageProps           (index.tsx / index.server.tsx 用)
//   - LayoutProps         (layout.tsx / layout.server.tsx 用、children 付き)
//   - LoaderArgs          (server.ts loader 用、request + params)
//   - ActionArgs          (server.ts action 用、request + params)
//   - ErrorBoundaryProps  (error.tsx 用、params は最寄り match で 404 ケース空 object 可)
//
// 内部実装は `RouteMap` interface lookup 経由 (= ADR 0011 が生成する routes.d.ts):
//   type Params = RouteMap["/posts/:slug"]["params"];
// これで RouteMap 改名 (= [slug] → [postSlug]) 時に per-route +types も追従、
// user の destructure が型エラーで知らせてくれる (= rename 追従の root mechanism)。
function renderPerRoutePlusTypes(routePath: string): string {
  const lines: string[] = [];
  lines.push("// AUTO-GENERATED by @vidro/plugin routeTypes() — DO NOT EDIT");
  lines.push(`// Per-route types for ${routePath} (ADR 0067)`);
  lines.push('import type { RouteMap } from "@vidro/router";');
  lines.push("");
  lines.push("export namespace Route {");
  lines.push(`  type Params = RouteMap["${routePath}"]["params"];`);
  lines.push("");
  lines.push("  // index.tsx / index.server.tsx で使う page component の props 型");
  lines.push("  export type PageProps = {");
  lines.push("    params: Params;");
  lines.push("  };");
  lines.push("");
  lines.push("  // layout.tsx / layout.server.tsx で使う layout component の props 型");
  lines.push("  export type LayoutProps = {");
  lines.push("    params: Params;");
  lines.push("    children: Node;");
  lines.push("  };");
  lines.push("");
  lines.push("  // server.ts の loader 関数引数型 (ADR 0053: ActionArgs と shape 統一)");
  lines.push("  export type LoaderArgs = {");
  lines.push("    request: Request;");
  lines.push("    params: Params;");
  lines.push("  };");
  lines.push("");
  lines.push("  // server.ts の action 関数引数型");
  lines.push("  export type ActionArgs = {");
  lines.push("    request: Request;");
  lines.push("    params: Params;");
  lines.push("  };");
  lines.push("");
  lines.push("  // error.tsx の props 型。params は最寄り match (404 ケースで空 object 可)");
  lines.push("  export type ErrorBoundaryProps = {");
  lines.push("    params: Record<string, string>;");
  lines.push("    error: unknown;");
  lines.push("    reset: () => void;");
  lines.push("  };");
  lines.push("}");
  return lines.join("\n") + "\n";
}

function renderServerEntry(): string {
  // 完全固定 template。user が拡張したくなったら将来 A with C override
  // (src/entry.server.ts があればそれを優先) で受ける方針 (案 B-2 Step 1.3)。
  //
  // Cloudflare Workers Assets + SPA mode + bootstrap data inject (Phase A):
  //   1. `/__loader` endpoint、または navigation (accept: text/html) は handler が処理
  //      navigation の場合は `env.ASSETS` で index.html を取り `__vidro_data` script
  //      を inject して返す (client の初回 loader fetch が skip される)
  //   2. handler が 404 を返したもの (static asset hit / non-HTML API request) は
  //      `env.ASSETS.fetch(request)` に委譲。static hit すれば直接、miss は
  //      `not_found_handling: "single-page-application"` 経由で index.html に
  //      fallback (この場合も Router は __vidro_data が無いので従来通り fetch)
  //
  // Phase B (真の SSR) 実装時は handler 内の navigation 分岐に renderToString が
  // 挿入されるだけで、entry signature は共通。
  const lines: string[] = [];
  lines.push("// AUTO-GENERATED by @vidro/plugin routeTypes() — DO NOT EDIT");
  lines.push("// Cloudflare Workers 向け fetch handler。`@cloudflare/vite-plugin` が");
  lines.push('// `wrangler.toml` の `main = "./.vidro/server-entry.ts"` 経由で source を読み、');
  lines.push(
    "// dev は workerd in-process、prod は `.vidro/build/ssr/index.js` に bundle する (ADR 0043)。",
  );
  lines.push("");
  lines.push('import { createServerHandler } from "@vidro/router/server";');
  lines.push('import { routeManifest } from "./route-manifest";');
  lines.push("");
  // Workers の env は wrangler.toml の bindings (D1 / KV / R2 / 任意) で生え方が
  // 変わるため、Vidro 側では `Record<string, unknown>` の base 型に ASSETS だけ
  // 明示する形に倒し、handler に丸ごと渡す。user が `getRequestEnv<MyEnv>()` で
  // type assertion する経路で具体型を取得する (= ADR 0066 dogfood で導入)。
  lines.push("type Env = {");
  lines.push("  ASSETS?: { fetch: (request: Request) => Promise<Response> };");
  lines.push("} & Record<string, unknown>;");
  lines.push("");
  lines.push("const handler = createServerHandler({ manifest: routeManifest });");
  lines.push("");
  lines.push("export default {");
  lines.push("  async fetch(request: Request, env: Env): Promise<Response> {");
  // env を丸ごと ctx.env に渡す。`getRequestEnv<T>()` は ALS scope で per-request に
  // 引ける (= packages/router/src/request-env-scope.ts、createServerHandler 内 wrap)。
  lines.push("    const response = await handler(request, { assets: env.ASSETS, env });");
  lines.push("    if (response.status !== 404) return response;");
  lines.push("    // handler 範囲外 (static asset / non-HTML API) は assets に委譲。");
  lines.push("    if (env.ASSETS) return env.ASSETS.fetch(request);");
  lines.push('    return new Response("Not Found", { status: 404 });');
  lines.push("  },");
  lines.push("};");
  return lines.join("\n") + "\n";
}

// --- writers ---

async function generateAll(
  routesDirAbs: string,
  outFileAbs: string,
  manifestFileAbs: string,
  serverEntryFileAbs: string,
  plusTypesDirAbs: string,
): Promise<void> {
  const files = await collectRouteFiles(routesDirAbs);
  writeIfChanged(outFileAbs, renderDts(files, routesDirAbs));
  writeIfChanged(manifestFileAbs, renderManifest(files, routesDirAbs, manifestFileAbs));
  writeIfChanged(serverEntryFileAbs, renderServerEntry());
  writePerRoutePlusTypes(files, routesDirAbs, plusTypesDirAbs);
}

// ADR 0067: 各 route directory ごとに `+types.d.ts` を書き出す。
//
// 入力 files の中で、route file (index/layout/server/error 等) を含む directory を
// dedupe で集めて、各 directory の URL pattern ベースで Route namespace を生成する。
// 出力位置は `<plusTypesDirAbs>/routes/<relDir>/+types.d.ts`。
//
// 注意: stale ファイル (= 削除された route の +types) のクリーンアップは v1 では
// 行わない (= YAGNI)。stale が残った場合、user 側で TS の dangling import エラーで
// 検出される or `rm -rf .vidro/+types` で resolve できる前提。
function writePerRoutePlusTypes(
  files: RouteFile[],
  routesDirAbs: string,
  plusTypesDirAbs: string,
): void {
  // directory 単位で dedupe (= 1 dir に複数 route file があっても 1 つの +types で OK)
  const dirs = new Map<string, string>(); // relDir -> URL pattern
  for (const f of files) {
    const relDir = relative(routesDirAbs, dirname(f.absPath)).replace(/\\/g, "/");
    if (dirs.has(relDir)) continue;
    dirs.set(relDir, dirToRoutePath(relDir));
  }

  for (const [relDir, routePath] of dirs) {
    // `<plusTypesDirAbs>/routes/<relDir>/+types.d.ts` に書く。
    // routes/ prefix を付けるのは、user 側の rootDirs 設定で `./src` と
    // `./.vidro/+types` を merge したときに `src/routes/...` と
    // `.vidro/+types/routes/...` が同じ logical path になるよう揃えるため。
    const outPath =
      relDir === ""
        ? resolve(plusTypesDirAbs, "routes/+types.d.ts")
        : resolve(plusTypesDirAbs, "routes", relDir, "+types.d.ts");
    writeIfChanged(outPath, renderPerRoutePlusTypes(routePath));
  }
}

function writeIfChanged(outFileAbs: string, content: string): void {
  mkdirSync(dirname(outFileAbs), { recursive: true });
  let existing = "";
  if (existsSync(outFileAbs)) {
    try {
      existing = readFileSync(outFileAbs, "utf8");
    } catch {
      existing = "";
    }
  }
  if (existing !== content) writeFileSync(outFileAbs, content, "utf8");
}
