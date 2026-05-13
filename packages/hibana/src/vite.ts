// @vidro/hibana/vite — Hibana の Vite plugin。Phase 1 Step 3-b で導入。
//
// 機構:
//   1. `.island.tsx` を glob で自動発見し、virtual module `virtual:hibana/islands` 経由で
//      islandMap (= name → component default export の lookup table) を提供する (= Phase A)
//   2. `.island.tsx` の default export を `defineIsland` で自動 wrap する transform hook を
//      提供する (= Phase B-1)。user は `export default function Counter(...)` を書くだけで
//      よく、`defineIsland(Counter, "Counter")` の手書きは不要になる。name は filename から
//      自動付与される (= `Counter.island.tsx` → `"Counter"`)
//
// これにより apps 側の体験は:
//
//   旧 (Phase A まで):
//     // Counter.island.tsx
//     import { defineIsland } from "@vidro/hibana";
//     function Counter({ initial }: { initial: number }) { ... }
//     export default defineIsland(Counter, "Counter");
//
//   新 (Phase B-1 以降):
//     // Counter.island.tsx
//     export default function Counter({ initial }: { initial: number }) { ... }
//
// 設計書「Vite plugin で .island.tsx 自動発見、AST 解析不要 (= glob で十分)」原則との整合:
//   - 「発見」は glob のみ (= AST 不要)
//   - 「default export の auto-wrap」は build-time transform、AST が必要だが scope は 1 file 内
//     の default export だけ。設計書原則の意図 (= cross-file scan を避ける) は満たす
//
// 残 (= Phase B-2): client.ts 自体を plugin が virtual で生成 / `hibana()` の `clientScript`
// option 撲滅。docs/roadmap-hibana.md 参照。

import type { Plugin } from "vite";
import { parse } from "@babel/parser";
import _traverse, { type NodePath } from "@babel/traverse";
import _generate from "@babel/generator";
import * as t from "@babel/types";

// @babel/traverse / @babel/generator は ESM 互換性のために default.default を持つことがある。
// @vidro/plugin の jsx-transform.ts と同じ workaround。
const traverse = (_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse;
const generate = (_generate as unknown as { default?: typeof _generate }).default ?? _generate;

const VIRTUAL_ID = "virtual:hibana/islands";
// vite の慣習: virtual module の resolved id は `\0` prefix を付けて他 plugin の処理対象外にする。
const RESOLVED_VIRTUAL_ID = "\0" + VIRTUAL_ID;

// browser bundle の entry を提供する virtual module (Phase B-2)。旧来は user の
// apps/<app>/src/client.ts に手書きしていた 3 行を、ここで生成して plugin が提供する。
// shell HTML の <script> tag は `hibana()` middleware が dev/prod 分岐で URL を決める:
//   dev:  /@id/__x00__virtual:hibana/client-entry  (= vite dev server が直接 transform/serve)
//   prod: /static/client.js                        (= `vite build --mode client` の出力先)
const CLIENT_ENTRY_ID = "virtual:hibana/client-entry";
const RESOLVED_CLIENT_ENTRY_ID = "\0" + CLIENT_ENTRY_ID;

// filesystem-based routing (= @vidro/hibana/fs と並走比較版、第 21 周目で追加)。
// `/app/routes/**/*.tsx` を glob 発見して fsRoutes 配列を提供する virtual module。
// user は `import { fsRoutes } from "virtual:hibana/fs-routes"` で受け取り、
// `createFsApp(fsRoutes, options)` で Hono app を組み立てる。
const FS_ROUTES_ID = "virtual:hibana/fs-routes";
const RESOLVED_FS_ROUTES_ID = "\0" + FS_ROUTES_ID;

export type HibanaViteOptions = {
  /**
   * `.island.tsx` の glob pattern。vite の root からの絶対パス (= `/` 始まり) で書く。
   * default: `/src/**\/*.island.tsx`
   *
   * 例: monorepo の app が src/ 配下に集約されている前提。深い nest (例:
   * `src/domains/posts/components/Counter.island.tsx`) も `**` で再帰的に拾える。
   */
  islandGlob?: string;
  /**
   * filesystem-based routing の root directory (= `@vidro/hibana/fs` 利用時のみ)。
   * default: `/src/routes` (= Vite/Node 慣習 + Vidro 側 apps 整合)。virtual:hibana/fs-routes が
   * `${fsRoutesRoot}/**\/*.tsx` を glob 発見する。
   *
   * 第 21 周目で `/app/routes` (= HonoX 流) から `/src/routes` に変更:
   *   - Hibana は HonoX との差別化が identity の核なので /app/ 規約を借りる必要なし
   *   - Vidro 側 apps (= apps/vidro-tutorial 等) と命名揃え
   *   - `app.ts` (= Hono instance entry) と `app/` directory の命名衝突回避
   *
   * handler-based 版 (= 既存 apps/hibana-demo) では virtual:hibana/fs-routes を
   * import しないので無視される (= 配置されてれば glob 走るが entry 0 で問題なし)。
   */
  fsRoutesRoot?: string;
};

/**
 * Hibana の `.island.tsx` 自動発見 + auto-wrap + virtual module 提供 plugin。
 *
 * vite.config.ts:
 *   plugins: [hibanaVite(), jsxTransform()]
 *
 * plugin order: 両方 `enforce: "pre"`、vite plugin 配列順で hibanaVite → jsxTransform。
 * hibanaVite が **素の** `.island.tsx` の default export を auto-wrap した後、jsxTransform が
 * 内部 JSX を `_$dynamicChild` 等で再 transform する流れ。
 */
export function hibanaVite(options: HibanaViteOptions = {}): Plugin {
  const glob = options.islandGlob ?? "/src/**/*.island.tsx";
  const fsRoutesRoot = options.fsRoutesRoot ?? "/src/routes";

  return {
    name: "vidro-hibana-islands",
    // jsxTransform より先に走らせて、素の AST を扱う。jsxTransform は本 plugin の output に
    // 対して child position の `{x}` → `_$dynamicChild(() => x)` 等を後段で適用する。
    enforce: "pre",

    resolveId(id: string) {
      if (id === VIRTUAL_ID) return RESOLVED_VIRTUAL_ID;
      if (id === CLIENT_ENTRY_ID) return RESOLVED_CLIENT_ENTRY_ID;
      if (id === FS_ROUTES_ID) return RESOLVED_FS_ROUTES_ID;
      return null;
    },

    load(id: string) {
      if (id === RESOLVED_VIRTUAL_ID) {
        // 返すコード内の `import.meta.glob` は vite が build-time / dev-time に静的展開する。
        // `eager: true` で実 import を実行して default export を取れる形にする。
        // 各 path から `<Name>.island.tsx` の `<Name>` 部分を抽出し、islandMap の key に使う。
        //
        // filename match に失敗した場合 (= 通常起きないが) はフルパスを fallback key にする。
        // 重複 (= 同名 island.tsx が複数 folder にある) は Object.fromEntries の後勝ち動作で
        // 上書きされる: Phase A では検出だけで warn しない、Phase B で build error 化検討。
        return `
const modules = import.meta.glob(${JSON.stringify(glob)}, { eager: true });
export const islandMap = Object.fromEntries(
  Object.entries(modules).map(([path, mod]) => {
    const match = path.match(/([^/]+)\\.island\\.tsx$/);
    return [match ? match[1] : path, mod.default];
  })
);
`;
      }

      if (id === RESOLVED_CLIENT_ENTRY_ID) {
        // browser bundle の entry。旧 apps/<app>/src/client.ts の手書きをここで提供。
        // user は client.ts を書かなくて済む。@hono/vite-dev-server 環境でも `mode === "client"`
        // 環境でも同じ内容で動く (= setupIslandHydration / setupNavigation が冪等)。
        //
        // ADR 0080 (Step 5、Phase 2): setupNavigation を併設して <Link> の click intercept +
        // 最深 Frame swap を提供する。`<Link>` を書いてない app では発火しないので無害。
        return `
import { setupIslandHydration, setupNavigation } from "@vidro/hibana/client";
import { islandMap } from "virtual:hibana/islands";
setupIslandHydration(islandMap);
setupNavigation();
`;
      }

      if (id === RESOLVED_FS_ROUTES_ID) {
        // filesystem-based routing の fsRoutes 配列を生成する virtual module。
        //
        // 規約 (HonoX 流の命名 pattern を /src/routes 配下に展開):
        //   /src/routes/_renderer.tsx           → root layout
        //   /src/routes/<seg>/_renderer.tsx     → /<seg>/* に scoped layout
        //   /src/routes/index.tsx                → GET /
        //   /src/routes/<seg>/index.tsx          → GET /<seg>
        //   /src/routes/<seg>/[id]/index.tsx     → GET /<seg>/:id
        //   /src/routes/<seg>/[id].tsx           → GET /<seg>/:id (= 単体ファイル形式も対応)
        //
        // 各 route の layouts は、parent dir 階層の _renderer.tsx を順に集めて [親, 子] 配列に。
        // Hono の middleware execution order に乗らない (= filesystem-based は middleware ではない)
        // ため、createFsApp の handler wrapper が毎 request で stack 初期化的に set する。
        //
        // route file の `export const metadata` も module export として import される
        // (= `mod.metadata` 参照)、ADR 0079 経路の Component.metadata と並走可能。
        //
        // import.meta.glob を eager にして全 module を build 時 / dev start 時に統合 import、
        // module の path から URL pattern を計算、ranking 不要 (= Hono 側の matcher に委ねる)。
        //
        // path prefix 比較は fsRoutesRoot (= vite root 起点 absolute) で統一する
        // (= code-review [1] 反映、`String.prototype.replace` の最初一致依存を slice + startsWith
        // に置き換え)。[2] の glob path 形式への configResolved 経由の完全 absolute 化は、
        // 実装時に確認したところ vite の `import.meta.glob` は glob pattern と同じ vite root
        // 起点 absolute (= "/app/routes/posts/index.tsx" 形式) で result path を返す安定仕様で、
        // 完全 absolute 化は不要 (= overengineering と判断、startsWith 比較自体が形式変更耐性に
        // 寄与する)。
        return `
const modules = import.meta.glob(${JSON.stringify(fsRoutesRoot + "/**/*.tsx")}, { eager: true });
const ROOT = ${JSON.stringify(fsRoutesRoot)};

// 第 1 パス: _renderer.tsx を直 path → layout default export の map に
const layoutsByDir = {};
for (const [path, mod] of Object.entries(modules)) {
  const m = path.match(/^(.+)\\/_renderer\\.tsx$/);
  if (m) layoutsByDir[m[1]] = mod.default;
}

// 第 2 パス: route file を発見、Hono path + layouts + metadata + handler を組み立てる
// 規約: default export = GET、named export POST/PUT/DELETE/PATCH = method 別 handler。
// default 無し + named のみの file (= 例: routes/posts/[id]/delete.tsx で POST だけ) も OK。
const METHODS = ["POST", "PUT", "DELETE", "PATCH"];
const routes = [];
for (const [path, mod] of Object.entries(modules)) {
  if (path.endsWith("/_renderer.tsx")) continue;
  if (!path.endsWith(".tsx")) continue;
  if (!path.startsWith(ROOT)) continue;  // 想定外 path を防御的に skip
  const hasAnyHandler = mod.default || METHODS.some((m) => mod[m]);
  if (!hasAnyHandler) continue;  // どの method export も無い file は route ではない

  // URL path: ROOT prefix を slice で外し、/index.tsx と .tsx を落とし、[id] → :id
  // 例: ROOT/posts/[id]/index.tsx → /posts/:id
  //     ROOT/posts/index.tsx       → /posts
  //     ROOT/index.tsx             → /
  let urlPath = path.slice(ROOT.length);
  urlPath = urlPath.replace(/\\/index\\.tsx$/, "");
  urlPath = urlPath.replace(/\\.tsx$/, "");
  urlPath = urlPath.replace(/\\[([^\\]]+)\\]/g, ":$1");
  if (urlPath === "") urlPath = "/";

  // 親 dirs を順に辿って _renderer.tsx があれば layouts に追加 (= 親が先、子が後)
  const dirPath = path.replace(/\\/[^/]+\\.tsx$/, "");
  const appliedLayouts = [];
  if (dirPath.startsWith(ROOT)) {
    let cur = ROOT;
    if (layoutsByDir[cur]) appliedLayouts.push(layoutsByDir[cur]);
    const restSegments = dirPath.slice(ROOT.length).split("/").filter(Boolean);
    for (const seg of restSegments) {
      cur += "/" + seg;
      if (layoutsByDir[cur]) appliedLayouts.push(layoutsByDir[cur]);
    }
  }

  // GET (= default export)。metadata は GET にだけ attach (= page render 経路でしか意味を持たない)
  if (mod.default) {
    routes.push({
      method: "GET",
      path: urlPath,
      handler: mod.default,
      metadata: mod.metadata,
      layouts: appliedLayouts,
    });
  }
  // POST 等 named export。metadata は付けない (= redirect / json 返す想定で page render しない)
  for (const method of METHODS) {
    if (mod[method]) {
      routes.push({
        method,
        path: urlPath,
        handler: mod[method],
        layouts: appliedLayouts,
      });
    }
  }
}

// Hono の Router (= LinearRouter / SmartRouter の特定 fallback) によっては registration 順で route matching するため、
// static segment が多い (= 具体的) path を先に register する。第 25 周目 dogfood で /posts/new が /posts/:id に
// 吸われて 404 になる F4 を発見、sort を入れて修正。RegExpRouter / TrieRouter は内部で static-first を保証するが
// SmartRouter が必ずそれを選ぶ保証は無いので defensive に sort する。
// path を segment 単位で比較し、static は dynamic より先、同形なら長い path を先にする。
routes.sort((a, b) => {
  const aSegs = a.path.split('/');
  const bSegs = b.path.split('/');
  const len = Math.min(aSegs.length, bSegs.length);
  for (let i = 0; i < len; i++) {
    const aDyn = aSegs[i].startsWith(':');
    const bDyn = bSegs[i].startsWith(':');
    if (aDyn !== bDyn) return aDyn ? 1 : -1;
  }
  return bSegs.length - aSegs.length;
});

export const fsRoutes = routes;
`;
      }

      return null;
    },

    transform(code: string, id: string) {
      if (id.includes("node_modules")) return null;

      // `.island.tsx` の auto-wrap (Phase B-1)
      const islandMatch = id.match(/([^/]+)\.island\.tsx(?:\?.*)?$/);
      if (islandMatch) {
        return transformIsland(code, islandMatch[1]!);
      }

      // 他の `.tsx` (= page module 想定) で `export const metadata` があれば
      // default export に `.metadata` プロパティを attach する (ADR 0079)。
      // 軽量な事前 string 判定で AST parse 自体を skip する case を増やす。
      if (id.match(/\.tsx(?:\?.*)?$/) && code.includes("export const metadata")) {
        return transformMetadata(code, id);
      }

      return null;
    },
  };
}

// `.island.tsx` の default export を `__hibana_defineIsland(<expr>, "<name>")` に置換する transform。
// FunctionDeclaration → FunctionExpression 化、ClassDeclaration → ClassExpression 化、
// 既に `defineIsland(...)` で wrap されてる case は skip (= 互換維持)。
function transformIsland(code: string, islandName: string) {
  const ast = parse(code, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  });

  let transformed = false;

  traverse(ast, {
    ExportDefaultDeclaration(path: NodePath<t.ExportDefaultDeclaration>) {
      const decl = path.node.declaration;

      let originalExpr: t.Expression;
      if (t.isFunctionDeclaration(decl)) {
        originalExpr = t.functionExpression(
          decl.id,
          decl.params,
          decl.body,
          decl.generator,
          decl.async,
        );
      } else if (t.isClassDeclaration(decl)) {
        originalExpr = t.classExpression(decl.id, decl.superClass, decl.body, decl.decorators);
      } else if (t.isExpression(decl)) {
        originalExpr = decl;
      } else {
        return;
      }

      // 既に `defineIsland(...)` 呼び出し済かを判定して二重 wrap 防止。
      // identifier 名で判定するので、alias 経由は判別できない (= 稀な edge case)。
      if (
        t.isCallExpression(originalExpr) &&
        t.isIdentifier(originalExpr.callee) &&
        originalExpr.callee.name === "defineIsland"
      ) {
        return;
      }

      const wrapped = t.callExpression(t.identifier("__hibana_defineIsland"), [
        originalExpr,
        t.stringLiteral(islandName),
      ]);
      path.node.declaration = wrapped;
      transformed = true;
      path.stop();
    },
  });

  if (!transformed) return null;

  const importDecl = t.importDeclaration(
    [t.importSpecifier(t.identifier("__hibana_defineIsland"), t.identifier("defineIsland"))],
    t.stringLiteral("@vidro/hibana/internal"),
  );
  ast.program.body.unshift(importDecl);

  const result = generate(ast, { retainLines: true, sourceMaps: true }, code);
  return { code: result.code, map: result.map };
}

/**
 * ADR 0079: page module の `export const metadata` を default export に attach する transform。
 *
 * 入力例:
 *   export const metadata: Metadata = { title: "Posts" };
 *   export default function PostListPage(props) { ... }
 *
 * 出力例:
 *   export const metadata: Metadata = { title: "Posts" };
 *   const __hibana_default = function PostListPage(props) { ... };
 *   __hibana_default.metadata = metadata;
 *   export default __hibana_default;
 *
 * 機構:
 *   - `hibana()` middleware の renderer が `(Component as { metadata }).metadata` を読むため、
 *     default export function に `.metadata` プロパティを attach する必要がある
 *   - FunctionDeclaration / ClassDeclaration / Expression (= Identifier / Arrow / Call 等) を
 *     `const __hibana_default = <expr>` に正規化、その後 `__hibana_default.metadata = metadata;`
 *     を挿入、`export default __hibana_default;` に書き換える
 *
 * 適用条件:
 *   - module に `export const metadata` が存在する (= caller 側で string 判定で事前 skip)
 *   - default export が存在する (= 無ければ warn 後 skip、silent failure 防止)
 *   - default export が既に `.metadata` を持っている (= 二重 attach skip、ユーザが手で書いた場合)
 *
 * warn 条件 (= code-review 第 19 周目で追加):
 *   - `export const metadata` あるが default export 無い (= named export only)
 *   - `export const metadata` あるが default export が re-export 形式 (= `export { default } from "..."`)
 *
 * いずれも runtime で `.metadata` 取得経路が機能しないため、user に明示する。
 */
function transformMetadata(code: string, id: string) {
  const ast = parse(code, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  });

  // `export const metadata = ...` の存在を AST level で再確認 (= string 判定の偽陽性除去、
  // 例: コメント中の `// export const metadata` 等)。
  let hasMetadataExport = false;
  for (const node of ast.program.body) {
    if (
      t.isExportNamedDeclaration(node) &&
      node.declaration &&
      t.isVariableDeclaration(node.declaration)
    ) {
      for (const decl of node.declaration.declarations) {
        if (t.isIdentifier(decl.id) && decl.id.name === "metadata") {
          hasMetadataExport = true;
          break;
        }
      }
    }
    if (hasMetadataExport) break;
  }
  if (!hasMetadataExport) return null;

  // default export を探し、正規化して `__hibana_default` 経由に書き換える。
  let defaultExportPath: NodePath<t.ExportDefaultDeclaration> | null = null;
  let hasReExportDefault = false;
  traverse(ast, {
    ExportDefaultDeclaration(path: NodePath<t.ExportDefaultDeclaration>) {
      defaultExportPath = path;
      path.stop();
    },
    // `export { default } from "..."` (= re-export) は ExportNamedDeclaration として現れる。
    // metadata は attach できないので warn のため検出だけする。
    ExportNamedDeclaration(path: NodePath<t.ExportNamedDeclaration>) {
      if (path.node.source) {
        for (const specifier of path.node.specifiers) {
          if (
            t.isExportSpecifier(specifier) &&
            t.isIdentifier(specifier.exported) &&
            specifier.exported.name === "default"
          ) {
            hasReExportDefault = true;
          }
        }
      }
    },
  });

  if (!defaultExportPath) {
    // metadata はあるが attach 対象が無い = silent failure を防ぐため warn。
    const reason = hasReExportDefault
      ? 'default export が re-export 形式 (`export { default } from "..."`) のため attach できない'
      : "default export が無い (= named export のみ)";
    console.warn(
      `[hibana:vite] ${id} に \`export const metadata\` があるが ${reason}。\n` +
        `  解決策: page module を \`export default function ...\` 形式にする (= ADR 0079)。`,
    );
    return null;
  }
  // narrow を維持するため as cast (= ESLint 的に冗長だが TS 推論限界の回避)。
  const exportPath = defaultExportPath as NodePath<t.ExportDefaultDeclaration>;
  const decl = exportPath.node.declaration;

  let originalExpr: t.Expression;
  if (t.isFunctionDeclaration(decl)) {
    originalExpr = t.functionExpression(
      decl.id,
      decl.params,
      decl.body,
      decl.generator,
      decl.async,
    );
  } else if (t.isClassDeclaration(decl)) {
    originalExpr = t.classExpression(decl.id, decl.superClass, decl.body, decl.decorators);
  } else if (t.isExpression(decl)) {
    originalExpr = decl;
  } else {
    return null;
  }

  // 既に `__hibana_default` 経由に書き換え済なら skip (= 二重適用防止、HMR re-transform 対策)。
  if (t.isIdentifier(originalExpr) && originalExpr.name === "__hibana_default") {
    return null;
  }

  // 構築物:
  //   const __hibana_default = <originalExpr>;
  //   __hibana_default.metadata = metadata;
  //   export default __hibana_default;
  const constDecl = t.variableDeclaration("const", [
    t.variableDeclarator(t.identifier("__hibana_default"), originalExpr),
  ]);
  const attachStmt = t.expressionStatement(
    t.assignmentExpression(
      "=",
      t.memberExpression(t.identifier("__hibana_default"), t.identifier("metadata")),
      t.identifier("metadata"),
    ),
  );
  const newExport = t.exportDefaultDeclaration(t.identifier("__hibana_default"));

  exportPath.replaceWithMultiple([constDecl, attachStmt, newExport]);

  const result = generate(ast, { retainLines: true, sourceMaps: true }, code);
  return { code: result.code, map: result.map };
}
