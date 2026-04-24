import { defineConfig, type Plugin } from "vite-plus";
import tailwindcss from "@tailwindcss/vite";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import _generate from "@babel/generator";
import * as t from "@babel/types";

// @babel/traverse / @babel/generator は ESM 互換性のために default.default を持つことがある
const traverse = (_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse;
const generate = (_generate as unknown as { default?: typeof _generate }).default ?? _generate;

// JSX 内の `{expr}` を `_reactive(() => expr)` に包む Vidro の A 方式 compile transform。
// 生成した関数には component 境界 (h() 内の Proxy) で展開すべきと判定するための
// marker が付く (_reactive 内で `__vidroReactive = true` がセットされる)。
// ユーザーが直接書いた arrow は marker 無しなので、event handler / render callback
// として区別できる。
// on* 属性 / 関数リテラル / 空 / 単一 JSX element は wrap しない。
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

          // `_reactive(() => expr)` に置換。runtime 側 (jsx.ts の _reactive) で
          // marker property がセットされ、Proxy が展開対象と識別できる。
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
// Vidro の JSX transform が生成する `_reactive(() => expr)` 呼び出しと対になる。
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
  // @vidro/core の import が無いファイル (route component 等) は新規追加
  ast.program.body.unshift(
    t.importDeclaration(
      [t.importSpecifier(t.identifier("_reactive"), t.identifier("_reactive"))],
      t.stringLiteral("@vidro/core"),
    ),
  );
}

export default defineConfig({
  plugins: [vidroJsxTransform(), tailwindcss()],
});
