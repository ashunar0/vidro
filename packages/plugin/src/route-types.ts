import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { Plugin } from "vite-plus";

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
// 3. `.vidro/server-entry.ts` — Cloudflare Workers 等の WinterCG 環境向け entry。
//    manifest を読み `createServerHandler(routeManifest)` を `{ fetch }` として
//    default export する固定 snippet。serverBoundary() plugin が 2nd pass
//    ssr build でこのファイルを bundle して dist-server/index.mjs を作る
//    (案 B-2 Step 1.3)。
//
// 置き場は vite root 直下の `.vidro/` に集約 (ADR 0013)。tsconfig base は plugin
// package に同梱されている (`@vidro/plugin/tsconfig.base.json`) ので、user
// tsconfig が extends するだけで Vidro が必要とする compilerOptions が揃う。

export type RouteTypesOptions = {
  /** routes ディレクトリ (vite root 相対)。default: "src/routes" */
  routesDir?: string;
  /** 出力先 .d.ts (vite root 相対)。default: ".vidro/routes.d.ts" */
  outFile?: string;
  /** 出力先 manifest .ts (vite root 相対)。default: ".vidro/route-manifest.ts" */
  manifestFile?: string;
  /** 出力先 server entry (vite root 相対)。default: ".vidro/server-entry.ts" */
  serverEntryFile?: string;
};

/** @vidro/plugin の routeTypes plugin 本体。 */
export function routeTypes(options: RouteTypesOptions = {}): Plugin {
  const routesDirOpt = options.routesDir ?? "src/routes";
  // 生成物は vite root 直下の `.vidro/` に集約 (SvelteKit `.svelte-kit/` /
  // Astro `.astro/` 式)。`.gitignore` に `.vidro/` を入れて artifact 扱いにする。
  const outFileOpt = options.outFile ?? ".vidro/routes.d.ts";
  const manifestFileOpt = options.manifestFile ?? ".vidro/route-manifest.ts";
  const serverEntryFileOpt = options.serverEntryFile ?? ".vidro/server-entry.ts";

  let routesDirAbs = "";
  let outFileAbs = "";
  let manifestFileAbs = "";
  let serverEntryFileAbs = "";

  return {
    name: "vidro-route-types",
    async configResolved(config) {
      routesDirAbs = resolve(config.root, routesDirOpt);
      outFileAbs = resolve(config.root, outFileOpt);
      manifestFileAbs = resolve(config.root, manifestFileOpt);
      serverEntryFileAbs = resolve(config.root, serverEntryFileOpt);
      await generateAll(routesDirAbs, outFileAbs, manifestFileAbs, serverEntryFileAbs);
    },
    async buildStart() {
      // watch 外から呼ばれる CLI (vp build 等) でも確実に生成されるよう二重化。
      await generateAll(routesDirAbs, outFileAbs, manifestFileAbs, serverEntryFileAbs);
    },
    configureServer(server) {
      // routesDir 配下の routable file の add/unlink/rename で再生成。
      // 既存ファイルの編集は artifact の形を変えないので listen しない (再生成
      // コストを抑える)。
      const handler = async (file: string) => {
        if (!file.startsWith(routesDirAbs)) return;
        if (!isRouteShapeFile(file)) return;
        await generateAll(routesDirAbs, outFileAbs, manifestFileAbs, serverEntryFileAbs);
      };
      server.watcher.on("add", handler);
      server.watcher.on("unlink", handler);
      // dir 単位の削除 (rename 等) は file 粒度の event が来ないことがあるので
      // 無条件で regenerate する。routes 数が多くない toy runtime 段階では十分。
      server.watcher.on("unlinkDir", () => {
        void generateAll(routesDirAbs, outFileAbs, manifestFileAbs, serverEntryFileAbs);
      });
    },
  };
}

// --- internal helpers ---

type RouteFileKind = "index" | "layout" | "server" | "layout.server" | "error" | "not-found";

type RouteFile = {
  kind: RouteFileKind;
  absPath: string;
};

const ROUTE_FILE_KIND: Record<string, RouteFileKind> = {
  "index.tsx": "index",
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
  // index.tsx / layout.tsx が存在する dir の URL pattern を dir 単位で dedupe。
  const set = new Set<string>();
  for (const f of files) {
    if (f.kind !== "index" && f.kind !== "layout") continue;
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
  // tsx 系は stub (server 側では呼ばれないが matchRoute の entry 作成のため key
  // は残す)。
  const manifestDir = dirname(manifestFileAbs);
  const serverFiles = files.filter((f) => f.kind === "server" || f.kind === "layout.server");

  const lines: string[] = [];
  lines.push("// AUTO-GENERATED by @vidro/plugin routeTypes() — DO NOT EDIT");
  lines.push(
    "// prod server bundle 向け: server.ts / layout.server.ts を静的 import で並べた RouteRecord。",
  );
  lines.push("// tsx 系 (index / layout / error / not-found) は server では実行されないが、");
  lines.push("// compileRoutes が matchRoute の entry を作るため key を stub で残す。");
  lines.push("");
  lines.push('import type { RouteRecord } from "@vidro/router";');
  lines.push("");

  serverFiles.forEach((f, i) => {
    const relImport = relative(manifestDir, f.absPath).replace(/\\/g, "/");
    const importPath = relImport.startsWith(".") ? relImport : `./${relImport}`;
    lines.push(`import * as m${i} from "${importPath}";`);
  });
  if (serverFiles.length > 0) lines.push("");

  lines.push("export const routeManifest: RouteRecord = {");
  let si = 0;
  for (const f of files) {
    const key = toManifestKey(f.absPath, routesDirAbs);
    if (f.kind === "server" || f.kind === "layout.server") {
      lines.push(`  "${key}": () => Promise.resolve(m${si}),`);
      si++;
    } else {
      lines.push(`  "${key}": () => Promise.resolve({}),`);
    }
  }
  lines.push("};");
  return lines.join("\n") + "\n";
}

function renderServerEntry(): string {
  // 完全固定 template。user が拡張したくなったら将来 A with C override
  // (src/entry.server.ts があればそれを優先) で受ける方針 (案 B-2 Step 1.3)。
  const lines: string[] = [];
  lines.push("// AUTO-GENERATED by @vidro/plugin routeTypes() — DO NOT EDIT");
  lines.push("// Cloudflare Workers 等の WinterCG 環境向け fetch handler。");
  lines.push('// `wrangler.toml` から `main = "./dist-server/index.mjs"` で指すだけで動く。');
  lines.push("");
  lines.push('import { createServerHandler } from "@vidro/router/server";');
  lines.push('import { routeManifest } from "./route-manifest";');
  lines.push("");
  lines.push("export default {");
  lines.push("  fetch: createServerHandler(routeManifest),");
  lines.push("};");
  return lines.join("\n") + "\n";
}

// --- writers ---

async function generateAll(
  routesDirAbs: string,
  outFileAbs: string,
  manifestFileAbs: string,
  serverEntryFileAbs: string,
): Promise<void> {
  const files = await collectRouteFiles(routesDirAbs);
  writeIfChanged(outFileAbs, renderDts(files, routesDirAbs));
  writeIfChanged(manifestFileAbs, renderManifest(files, routesDirAbs, manifestFileAbs));
  writeIfChanged(serverEntryFileAbs, renderServerEntry());
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
