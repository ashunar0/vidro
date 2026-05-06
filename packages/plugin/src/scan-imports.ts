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

export type IslandImport = { name: string; path: string };

// island 候補の判定: 相対 path (./ or ../) で、.ts / .css / .json 等の non-island 拡張子で
// 終わってないもの。拡張子省略 OK (Vite resolver に任せる)、明示 .tsx も拾う。
// non-relative import (= 'react' / '@vidro/core' 等) はライブラリなので island ではない。
function isIslandImportPath(source: string): boolean {
  if (!source.startsWith("./") && !source.startsWith("../")) return false;
  if (source.endsWith(".tsx")) return true;
  // 既知 non-island 拡張子は除外
  if (/\.(ts|css|json|js|mjs|cjs|svg|png|jpg|jpeg|webp|gif|woff2?)$/.test(source)) return false;
  // 拡張子省略 (= ./counter) は island 候補。後で Vite が .tsx 以外に解決したら build error で気付く
  return !/\.[a-z0-9]+$/i.test(source);
}

// .server.tsx を AST scan して、内部から import している .tsx (= island candidate) を named で抽出。
// 結果が stub virtual module の `__islands` named map (= ADR 0060 C-α / M-1) になる。
export function scanIslandImports(source: string): IslandImport[] {
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
      if (!isIslandImportPath(importPath)) return;

      for (const spec of node.specifiers) {
        // import { type X } from "..." の type-only specifier も skip
        if ((spec as { importKind?: string }).importKind === "type") continue;

        if (spec.type === "ImportSpecifier") {
          islands.push({ name: spec.local.name, path: importPath });
        } else if (spec.type === "ImportDefaultSpecifier") {
          islands.push({ name: spec.local.name, path: importPath });
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
