import { defineConfig, type Plugin } from "vite-plus";
import tailwindcss from "@tailwindcss/vite";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import _generate from "@babel/generator";
import * as t from "@babel/types";

// @babel/traverse / @babel/generator は ESM 互換性のために default.default を持つことがある
const traverse = (_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse;
const generate = (_generate as unknown as { default?: typeof _generate }).default ?? _generate;

// JSX 内の `{expr}` を `() => expr` に包む Vidro の A 方式 compile transform。
// on* 属性 / 関数リテラル / 空 expression は変換しない (runtime で正しく扱えなくなるため)。
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

      traverse(ast, {
        JSXExpressionContainer(path) {
          const parent = path.parent;
          // on* 属性の値は event listener として関数を受けるので wrap してはいけない
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
          // 単一 JSX 要素は静的な Node として渡したいので wrap しない
          // (例: <Show fallback={<Todo />}>... や <div>{<Foo />}</div>)
          if (t.isJSXElement(expr) || t.isJSXFragment(expr)) return;

          path.node.expression = t.arrowFunctionExpression([], expr);
        },
      });

      const result = generate(ast, { retainLines: true, sourceMaps: true }, code);
      return { code: result.code, map: result.map };
    },
  };
}

export default defineConfig({
  plugins: [vidroJsxTransform(), tailwindcss()],
});
