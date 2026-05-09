// ADR 0070 Phase 2a: server function registry — bundler が認識する server
// function の集合 (= file path / export name / kind / URL) を作る utility 集。
//
// Phase 2 全体は 4 サブステップ:
//   2a (本 file): AST scan + URL 生成 + collision 検出 ← 今ここ
//   2b: client bundle stub transform (= `import { fn } from "./server"` を fetch 化)
//   2c: server runtime dispatch (= URL ↔ handler の table 構築)
//   2d: universal `.tsx` / `.client.tsx` 内 inline `serverFn(...)` を build error
//
// 本 file はあくまで **identification + URL 規則** に閉じる。stub 生成 / runtime
// dispatch / build error は別 file (= 別 commit) で。
//
// 設計判断: ADR 0070 論点 1 (= server.ts / *.server.tsx の named export 認識)、
// 論点 4-A (= file path 1:1 URL、routes/ 内のみ strip)、論点 7 (= 位置引数で
// dynamic param、ただし URL 生成では関数名 suffix のみ扱う)。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";

// @babel/traverse の ESM 互換 (= scan-imports.ts と同じ wrap)
const traverse = (_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse;

/**
 * scanServerFnExports が返す 1 export の判定。
 *
 *   - "serverFn-wrapped" = `export const fn = serverFn(...)` (= ADR 0070 推奨形)
 *   - "async-function"   = `export async function fn() {}` または
 *                          `export const fn = async (...) => {}` (= bare RPC、
 *                          middleware なしだが本 ADR で認識対象)
 */
export type ServerFnKind = "serverFn-wrapped" | "async-function";

/**
 * 1 file (= server.ts または *.server.tsx) 内の 1 export 分の情報。AST scan
 * 結果。URL は別途 urlForServerFn で生成する (= file path 由来なので scan 単独
 * では決まらない、project root が要る)。
 */
export type ServerFnExport = {
  exportName: string;
  kind: ServerFnKind;
};

/**
 * registry に乗る 1 server function の最終形。stub 生成 / runtime dispatch は
 * これを参照する。
 */
export type ServerFnEntry = ServerFnExport & {
  /** absolute file path (= server.ts または *.server.tsx) */
  filePath: string;
  /** 自動生成 URL (= POST endpoint、論点 4-A 規則)。先頭 `/` 付き */
  url: string;
};

// --- AST scan ----

/**
 * source を AST 解析して named export のうち server function 候補を抽出する。
 * file 種別 (= server.ts / *.server.tsx) は呼出元判定、本 fn は中身だけ見る。
 *
 * 拾うもの:
 *   - `export const fn = serverFn(...)` → "serverFn-wrapped"
 *   - `export async function fn() {}` → "async-function"
 *   - `export const fn = async (...) => {}` → "async-function"
 *
 * 拾わないもの (= データ export として client bundle にそのまま乗る):
 *   - `export const schema = z.object({ ... })`
 *   - `export const FOO = "bar"`
 *   - `export type X = ...` / `export interface X {}`
 *   - `export default ...` (= page component default export)
 *   - re-export `export { fn } from "./other"` (= Phase 2a scope 外、後続で検討)
 *
 * **未対応の制約 (= Phase 2d 候補)**: `import { serverFn as sf } from "@vidro/router"`
 * 経由の aliased call (`sf(async ...)`) は拾えない (= callee Identifier 名の直接
 * 比較のため)。現状 user code が alias を書くケースは想定していないが、Phase 2d
 * の build error 系で「serverFn は alias 不可、または alias call も認識する」を
 * 決める。当面は alias = stub 化されない silent fail なので、test で意図確認のみ。
 */
export function scanServerFnExports(source: string, _filePath: string): ServerFnExport[] {
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["jsx", "typescript"],
  });

  const exports: ServerFnExport[] = [];

  traverse(ast, {
    ExportNamedDeclaration(path) {
      const decl = path.node.declaration;
      if (!decl) return;

      // export async function fn() {}
      if (decl.type === "FunctionDeclaration") {
        if (!decl.async) return;
        if (!decl.id) return; // 匿名 (= 構文的にはあり得ないが念のため)
        exports.push({ exportName: decl.id.name, kind: "async-function" });
        return;
      }

      // export const fn = serverFn(...) / async (...) => {}
      if (decl.type === "VariableDeclaration") {
        for (const declarator of decl.declarations) {
          if (declarator.id.type !== "Identifier") continue; // 分割代入は対象外
          if (!declarator.init) continue;
          const init = declarator.init;

          // serverFn(...) 呼出 (= 推奨形)
          if (
            init.type === "CallExpression" &&
            init.callee.type === "Identifier" &&
            init.callee.name === "serverFn"
          ) {
            exports.push({ exportName: declarator.id.name, kind: "serverFn-wrapped" });
            continue;
          }

          // async arrow function (= bare RPC 形)
          if (init.type === "ArrowFunctionExpression" && init.async) {
            exports.push({ exportName: declarator.id.name, kind: "async-function" });
            continue;
          }

          // async function expression (= `export const fn = async function () {}`)
          if (init.type === "FunctionExpression" && init.async) {
            exports.push({ exportName: declarator.id.name, kind: "async-function" });
            continue;
          }
        }
      }
    },
  });

  return exports;
}

// --- URL 生成 ----

export type UrlForServerFnOptions = {
  /** absolute file path */
  filePath: string;
  /** 抽出した named export 名 */
  exportName: string;
  /** project root (= absolute) */
  projectRoot: string;
  /** src directory 名、default "src" */
  srcDir?: string;
  /** routes directory 名 (= src からの相対)、default "routes" */
  routesDir?: string;
};

/**
 * file path + export name から URL を生成する (= ADR 0070 論点 4-A)。
 *
 * 規則:
 *   1. projectRoot 相対化、posix separator に統一
 *   2. srcDir prefix を strip (= "src/")
 *   3. routesDir で始まれば routes も strip (= page と URL が一致、bonus)
 *   4. file basename:
 *      - "server.ts" / "server.js" → drop (= directory のみ残す)
 *      - "*.server.tsx" / "*.server.ts" / "*.server.jsx" / "*.server.js" → drop
 *   5. 末尾に `/${exportName}` 付与
 *
 * 例:
 *   src/routes/posts/[slug]/edit/server.ts + updatePost
 *     → /posts/[slug]/edit/updatePost
 *   src/features/posts/server.ts + createPost
 *     → /features/posts/createPost
 *   src/routes/posts/new/index.server.tsx + createPost
 *     → /posts/new/createPost
 *
 * 入力 path が src/ 配下にない場合は throw (= 想定外、bundler が誤って scan
 * したら早めに気付かせる)。
 */
export function urlForServerFn(options: UrlForServerFnOptions): string {
  const { filePath, exportName, projectRoot } = options;
  const srcDir = options.srcDir ?? "src";
  const routesDir = options.routesDir ?? "routes";

  // projectRoot 相対化、separator は posix に統一して URL 構築しやすくする
  const rel = relative(projectRoot, filePath).split(sep).join(posix.sep);

  // src/ prefix チェック。configurable な srcDir をそのまま頭に付けて compare
  const srcPrefix = `${srcDir}${posix.sep}`;
  if (!rel.startsWith(srcPrefix)) {
    throw new Error(
      `[vidro/server-fn-registry] File ${filePath} is outside src/ directory ` +
        `(projectRoot=${projectRoot}, srcDir=${srcDir}). ` +
        `server.ts / *.server.tsx must live under src/.`,
    );
  }
  let stripped = rel.slice(srcPrefix.length);

  // routes/ で始まれば routes/ も strip (= page と URL が 1:1 になる bonus)
  // `src/routes/server.ts` 等は strip 後 `server.ts` となり、後段の basename
  // drop で dirPart 空になるので別分岐は不要。
  const routesPrefix = `${routesDir}${posix.sep}`;
  if (stripped.startsWith(routesPrefix)) {
    stripped = stripped.slice(routesPrefix.length);
  }

  // file basename を drop (= directory part のみ残す)
  // server.ts / server.js は完全一致、*.server.{ts,tsx,js,jsx} は suffix 一致
  const lastSlash = stripped.lastIndexOf(posix.sep);
  const dirPart = lastSlash >= 0 ? stripped.slice(0, lastSlash) : "";
  const baseName = lastSlash >= 0 ? stripped.slice(lastSlash + 1) : stripped;

  if (!isServerFnFile(baseName)) {
    throw new Error(
      `[vidro/server-fn-registry] File ${filePath} is not a recognized server function file. ` +
        `Expected basename "server.{ts,js}" or "*.server.{ts,tsx,js,jsx}", got "${baseName}".`,
    );
  }

  // dirPart 空 (= src/routes 直下 server.ts 等) の場合 URL は `/${exportName}` のみ
  return dirPart ? `/${dirPart}/${exportName}` : `/${exportName}`;
}

/**
 * basename (= 拡張子込み) が server function file かを判定する。
 *   - "server.ts" / "server.js" → ◯
 *   - "*.server.tsx" / "*.server.ts" / "*.server.jsx" / "*.server.js" → ◯
 *
 * `layout.server.ts` は loader 用途 (= 既存 ADR) で server function ではない、
 * ただし basename pattern は一致してしまうので呼出元 (= discoverServerFns) で
 * 除外判定する。本 fn は形式 check のみ。
 */
function isServerFnFile(baseName: string): boolean {
  if (baseName === "server.ts" || baseName === "server.js") return true;
  if (/\.server\.(tsx|ts|jsx|js)$/.test(baseName)) return true;
  return false;
}

// --- registry walk + collision 検出 ----

export type DiscoverServerFnsOptions = {
  /** absolute project root */
  projectRoot: string;
  /** src directory 名、default "src" */
  srcDir?: string;
  /** routes directory 名、default "routes" */
  routesDir?: string;
  /** test 用 fs override (= 与えなければ node:fs で実 walk) */
  fs?: VirtualFs;
};

/**
 * fs walk を override 可能にするための minimal interface (= test 用)。
 * 実 fs を使う本番経路では node:fs を使う default impl が走る。
 */
export type VirtualFs = {
  existsSync(path: string): boolean;
  readdirSync(path: string): string[];
  statSync(path: string): { isDirectory(): boolean; isFile(): boolean };
  readFileSync(path: string, encoding: "utf-8"): string;
};

/**
 * project root の src/ 配下を walk して、server.ts / *.server.tsx を全列挙し、
 * 各 file 内の named export を scan、URL を生成、collision 検出を行って
 * registry を返す。
 *
 * 除外:
 *   - `layout.server.ts` (= loader 用途、既存 ADR)
 *   - node_modules / .vidro / dist 等の機械生成 dir
 *
 * collision (= 同一 URL に複数 entry) は build error として throw。user が同
 * directory に server.ts と *.server.tsx を両置きして同名 export を書くと
 * 起きる、稀だが起こり得る。
 */
export function discoverServerFns(options: DiscoverServerFnsOptions): ServerFnEntry[] {
  const fs: VirtualFs = options.fs ?? defaultFs;
  const projectRoot = options.projectRoot;
  const srcDir = options.srcDir ?? "src";
  const routesDir = options.routesDir ?? "routes";

  const srcAbs = join(projectRoot, srcDir);
  if (!fs.existsSync(srcAbs)) return [];

  const files: string[] = [];
  walk(srcAbs, fs, files);

  const entries: ServerFnEntry[] = [];
  // URL collision 検出 map
  const urlSeen = new Map<string, ServerFnEntry>();

  for (const filePath of files) {
    const source = fs.readFileSync(filePath, "utf-8");
    const exports = scanServerFnExports(source, filePath);
    for (const exp of exports) {
      const url = urlForServerFn({
        filePath,
        exportName: exp.exportName,
        projectRoot,
        srcDir,
        routesDir,
      });
      const entry: ServerFnEntry = { ...exp, filePath, url };
      const prev = urlSeen.get(url);
      if (prev) {
        throw new Error(
          `[vidro/server-fn-registry] URL collision: ${url}\n` +
            `  - ${prev.filePath} (export ${prev.exportName})\n` +
            `  - ${filePath} (export ${exp.exportName})\n` +
            `Two server functions cannot resolve to the same URL. ` +
            `Rename one export, move one file, or restructure.`,
        );
      }
      urlSeen.set(url, entry);
      entries.push(entry);
    }
  }

  return entries;
}

// dir を再帰 walk して server.ts / *.server.tsx を集める。`layout.server.ts` /
// node_modules / dotted directory (.vidro / .git 等) は除外。
function walk(dirAbs: string, fs: VirtualFs, out: string[]): void {
  const names = fs.readdirSync(dirAbs);
  for (const name of names) {
    if (shouldSkipDirent(name)) continue;
    const childAbs = join(dirAbs, name);
    const stat = fs.statSync(childAbs);
    if (stat.isDirectory()) {
      walk(childAbs, fs, out);
      continue;
    }
    if (!stat.isFile()) continue;
    if (!isPickedFile(name)) continue;
    out.push(childAbs);
  }
}

function shouldSkipDirent(name: string): boolean {
  if (name === "node_modules") return true;
  if (name === ".vidro") return true;
  if (name === "dist") return true;
  if (name.startsWith(".")) return true; // .git / .DS_Store 等
  return false;
}

// layout.server.ts は loader 用途 (= 既存 ADR、`server-boundary.ts` の
// `isServerOnlyId` も同 file を server-only として扱う) で server function では
// ない。判定 logic が `server-boundary.ts` と分散している自覚あり、Phase 2b 以降
// で「server.ts / *.server.tsx 識別」を共通 util に抽出する候補。今は YAGNI で
// 並列維持、layout 系の追加 (= layout.server.tsx 等) があれば両方更新が必要。
function isPickedFile(baseName: string): boolean {
  if (baseName === "layout.server.ts" || baseName === "layout.server.js") return false;
  if (baseName === "server.ts" || baseName === "server.js") return true;
  if (/\.server\.(tsx|ts|jsx|js)$/.test(baseName)) return true;
  return false;
}

// node:fs の default 実装 (= test 不使用)。readdirSync は encoding を明示して
// Buffer 経路を回避 (= macOS / linux で utf-8 string[] 確定、Windows でも安全)。
const defaultFs: VirtualFs = {
  existsSync,
  readdirSync: (path) => readdirSync(path, { encoding: "utf-8" }),
  statSync: (path) => statSync(path),
  readFileSync: (path, encoding) => readFileSync(path, encoding),
};
