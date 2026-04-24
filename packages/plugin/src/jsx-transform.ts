import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import _generate from "@babel/generator";
import * as t from "@babel/types";
import type { Plugin } from "vite-plus";

// @babel/traverse / @babel/generator は ESM 互換性のために default.default を持つことがある
const traverse = (_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse;
const generate = (_generate as unknown as { default?: typeof _generate }).default ?? _generate;

/**
 * Vidro の A 方式 JSX transform を行う vite plugin。
 *
 * JSX 内の `{expr}` を `_reactive(() => expr)` に包み、`_reactive` の import を必要に
 * 応じて追加する。runtime 側 (`@vidro/core` の `_reactive`) で marker property
 * (`__vidroReactive = true`) がセットされ、h() 内の Proxy が展開対象と識別する
 * (ADR 0007)。
 *
 * wrap しないケース:
 *   - `on*` 属性 (event handler はそのまま関数として渡す)
 *   - 関数リテラル (`() => ...`、`function () { ... }`) — ユーザーが意図的に書いた
 *     callback は marker 無しにしておく
 *   - 空の `{}` (JSXEmptyExpression)
 *   - JSX element / fragment (既に Node のまま使う)
 *
 * plugin order は `enforce: "pre"` で、vite の他の transform より前に走らせる。
 */
export function jsxTransform(): Plugin {
  return {
    name: "vidro-jsx-transform",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith(".tsx")) return null;
      if (id.includes("node_modules")) return null;

      const ast = parse(code, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
      });

      let touched = false;

      traverse(ast, {
        JSXExpressionContainer(path) {
          const parent = path.parent;
          if (
            t.isJSXAttribute(parent) &&
            t.isJSXIdentifier(parent.name) &&
            parent.name.name.startsWith("on") &&
            parent.name.name.length > 2
          ) {
            return;
          }

          const expr = path.node.expression;
          if (t.isJSXEmptyExpression(expr)) return;
          if (t.isArrowFunctionExpression(expr) || t.isFunctionExpression(expr)) return;
          if (t.isJSXElement(expr) || t.isJSXFragment(expr)) return;

          path.node.expression = t.callExpression(t.identifier("_reactive"), [
            t.arrowFunctionExpression([], expr),
          ]);
          touched = true;
        },
      });

      if (touched) ensureReactiveImport(ast);

      const result = generate(ast, { retainLines: true, sourceMaps: true }, code);
      return { code: result.code, map: result.map };
    },
  };
}

// ファイルの import 文に `_reactive` を追加する (既に import 済みなら何もしない)。
// @vidro/core の import 文がすでにあれば specifier を追加、なければ新規 import を差し込む。
function ensureReactiveImport(ast: ReturnType<typeof parse>): void {
  for (const node of ast.program.body) {
    if (!t.isImportDeclaration(node)) continue;
    if (node.source.value !== "@vidro/core") continue;
    const alreadyImported = node.specifiers.some(
      (s) =>
        t.isImportSpecifier(s) && t.isIdentifier(s.imported) && s.imported.name === "_reactive",
    );
    if (alreadyImported) return;
    node.specifiers.push(t.importSpecifier(t.identifier("_reactive"), t.identifier("_reactive")));
    return;
  }
  ast.program.body.unshift(
    t.importDeclaration(
      [t.importSpecifier(t.identifier("_reactive"), t.identifier("_reactive"))],
      t.stringLiteral("@vidro/core"),
    ),
  );
}
