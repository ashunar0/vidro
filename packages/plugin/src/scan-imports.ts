import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";

// @babel/traverse は ESM 互換性のため default.default を持つことがある (jsx-transform.ts と同じ wrap)
const traverse = (_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse;

// .server.tsx 内で誤用検出する reactive primitive (= ADR 0058 + ADR 0060 F-α)。
// これらは server-only な評価モデルでは動かない (= signal は subscribe → re-render 機構を持つが
// .server.tsx は invoke-once なので意味を成さない)。silent ではなく build error で教える。
const REACTIVE_PRIMITIVES = new Set([
  "signal",
  "computed",
  "effect",
  "onMount",
  "Resource",
  "Suspense",
]);

// name = local binding (= 親の JSX 内で使われる identifier、`<X .../>` の X)
// importedName = import 元の export name (default / named original) — aliased 経路で
//   stub を再現するため必要 (= reviewer M-1)。`import { A as B }` なら local=B / imported=A
export type IslandImport = { name: string; importedName: string; path: string };

// island 候補の判定:
//   - 相対 path (./ or ../) のみ (non-relative はライブラリなので skip)
//   - 明示 `.tsx` extension は即 island 確定
//   - 既知 non-island 拡張子 (.ts / .css / .json 等) は即 skip
//   - 拡張子省略 (= ./counter / ./server) は **隣接 .tsx file が実在するかで判定**
//     これで `from "./server"` (= server.ts logic file) と `from "./counter"` (= counter.tsx
//     island) を file system 上で正しく区別できる。`fromFile` (= 呼び出し元 .server.tsx
//     の absolute path) を基点に dirname + resolve で同階層の `${importPath}.tsx` を check
function isIslandImportPath(source: string, fromFileAbs: string): boolean {
  if (!source.startsWith("./") && !source.startsWith("../")) return false;
  if (source.endsWith(".tsx")) return true;
  // 既知 non-island 拡張子は除外
  if (/\.(ts|css|json|js|mjs|cjs|svg|png|jpg|jpeg|webp|gif|woff2?)$/.test(source)) return false;
  // 拡張子に見える suffix がある (= 想定外 extension) は skip
  if (/\.[a-z0-9]+$/i.test(source)) return false;
  // 拡張子省略 (= ./counter) は隣接 `.tsx` file 実在で判定
  const dir = dirname(fromFileAbs);
  const candidate = resolve(dir, source + ".tsx");
  return existsSync(candidate);
}

// .server.tsx を AST scan して、内部から import している .tsx (= island candidate) を named で抽出。
// 結果が stub virtual module の `__islands` named map (= ADR 0060 C-α / M-1) になる。
//
// fromFileAbs: 呼び出し元 file の absolute path (= 拡張子省略 import の隣接 file 判定用)
export function scanIslandImports(source: string, fromFileAbs: string): IslandImport[] {
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["jsx", "typescript"],
  });

  const islands: IslandImport[] = [];

  traverse(ast, {
    ImportDeclaration(path) {
      const node = path.node;
      // import type { X } from "..." 全体を skip (= reviewer W-3)
      if (node.importKind === "type") return;

      const importPath = node.source.value;
      if (!isIslandImportPath(importPath, fromFileAbs)) return;

      for (const spec of node.specifiers) {
        // import { type X } from "..." の type-only specifier も skip
        if ((spec as { importKind?: string }).importKind === "type") continue;

        if (spec.type === "ImportSpecifier") {
          // imported は Identifier (= 普通) or StringLiteral (= 'foo bar' 等の特殊 named)
          const imported =
            spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;
          islands.push({ name: spec.local.name, importedName: imported, path: importPath });
        } else if (spec.type === "ImportDefaultSpecifier") {
          // default import は import 元での名前として "default" を使う (= ESM 規約)。
          // stub 生成側で `import { default as X }` 形式に展開する。
          islands.push({ name: spec.local.name, importedName: "default", path: importPath });
        }
        // namespace import (* as X) は __islands[name] lookup と相性悪いので skip
      }
    },
  });

  return islands;
}

// .server.tsx 内で reactive primitive を import していたら build error を投げる (= ADR 0060 F-α)。
// 関数 call の動的検出は scope 外 (= import 文ベース粗版)、re-export 経由は検出漏れする trade-off。
export function assertNoReactivePrimitive(source: string, id: string): void {
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["jsx", "typescript"],
  });

  traverse(ast, {
    ImportDeclaration(path) {
      const node = path.node;
      if (node.importKind === "type") return;

      const importPath = node.source.value;
      if (importPath !== "@vidro/core") return;

      for (const spec of node.specifiers) {
        if ((spec as { importKind?: string }).importKind === "type") continue;
        if (spec.type !== "ImportSpecifier") continue;

        const imported =
          spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;

        if (REACTIVE_PRIMITIVES.has(imported)) {
          throw new Error(
            `[vidro] Cannot use reactive primitive '${imported}' in ${id}\n` +
              `  .server.tsx is server-only — signal / computed / effect / onMount / Resource / Suspense don't work here.\n` +
              `  Move reactive logic to a Client Component (.tsx file) and import it.`,
          );
        }
      }
    },
  });
}
