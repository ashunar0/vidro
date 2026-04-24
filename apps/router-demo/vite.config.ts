import { defineConfig, type Plugin } from "vite-plus";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import _generate from "@babel/generator";
import * as t from "@babel/types";

// @babel/traverse / @babel/generator は ESM 互換性のために default.default を持つことがある
const traverse = (_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse;
const generate = (_generate as unknown as { default?: typeof _generate }).default ?? _generate;

// JSX 内の `{expr}` を `_reactive(() => expr)` に包む Vidro の A 方式 compile transform。
// website/vite.config.ts と同じ実装 (将来は tools/ 配下へ共通化予定)。
function vidroJsxTransform(): Plugin {
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

export default defineConfig({
  plugins: [vidroJsxTransform()],
});
