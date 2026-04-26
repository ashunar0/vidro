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
 * **attribute 位置** の `{expr}` (`<div class={expr}>` 等) は `_reactive(() => expr)` に
 * 包む。runtime の `wrapComponentProps` Proxy / `applyProp` が marker property
 * (`__vidroReactive = true`) を見て展開する (ADR 0007)。
 *
 * **child 位置** (`<div>...</div>` の中身) は SSR hydration (Step B-3a) に対応するため、
 * post-order な call 順を保証する形に書き換える (ADR 0019):
 *   - JSXText (`<div>hi</div>` の "hi") → `_$text("hi")`
 *   - JSXExpressionContainer (`<div>{expr}</div>`) → `_$dynamicChild(() => expr)`
 * これらの helper は `h()` の引数として **先に** 評価され、内部で `createText` を呼ぶ。
 * runtime の `appendChild` ヘルパーで「h の後に primitive から createText」する経路を
 * 通らないので、HydrationRenderer の cursor (post-order) と合致する。
 *
 * wrap しないケース:
 *   - `on*` 属性 (event handler はそのまま関数として渡す)
 *   - 関数リテラル (`() => ...`、`function () { ... }`) — ユーザーが意図的に書いた
 *     callback は marker 無しにしておく
 *   - 空の `{}` (JSXEmptyExpression)
 *   - JSX element / fragment (既に Node のまま使う)
 *   - whitespace のみの JSXText (改行 + インデント) — Babel が parse 時点で生成する
 *     formatting noise なので skip
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

      const needed = new Set<HelperName>();

      traverse(ast, {
        JSXExpressionContainer(path) {
          const parent = path.parent;

          // attribute 位置: on* は素通し、それ以外は _reactive で wrap (既存挙動)
          if (t.isJSXAttribute(parent)) {
            if (
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
            needed.add("_reactive");
            return;
          }

          // child 位置 (JSXElement / JSXFragment の中): _$dynamicChild で wrap して
          // h() より先に「peek + createText / Node 判定 + effect」を実行させる
          if (t.isJSXElement(parent) || t.isJSXFragment(parent)) {
            const expr = path.node.expression;
            if (t.isJSXEmptyExpression(expr)) return;
            if (t.isJSXElement(expr) || t.isJSXFragment(expr)) return;
            path.node.expression = t.callExpression(t.identifier("_$dynamicChild"), [
              t.arrowFunctionExpression([], expr),
            ]);
            needed.add("_$dynamicChild");
          }
        },

        JSXText(path) {
          const parent = path.parent;
          if (!t.isJSXElement(parent) && !t.isJSXFragment(parent)) return;
          const value = path.node.value;
          // 改行 + indent のみは JSX formatting で出る noise なので捨てる
          if (value.trim() === "") return;
          // JSX で 1 個の text として扱われるよう、JSXExpressionContainer に置換して
          // `_$text("...")` の call にする
          const replacement = t.jsxExpressionContainer(
            t.callExpression(t.identifier("_$text"), [t.stringLiteral(value)]),
          );
          path.replaceWith(replacement);
          needed.add("_$text");
        },
      });

      if (needed.size > 0) ensureCoreImports(ast, needed);

      const result = generate(ast, { retainLines: true, sourceMaps: true }, code);
      return { code: result.code, map: result.map };
    },
  };
}

type HelperName = "_reactive" | "_$text" | "_$dynamicChild";

// 必要な helper を `@vidro/core` から import する。既存の import 文があれば specifier
// を追加、無ければ新規 import を unshift する。
function ensureCoreImports(ast: ReturnType<typeof parse>, names: Set<HelperName>): void {
  for (const node of ast.program.body) {
    if (!t.isImportDeclaration(node)) continue;
    if (node.source.value !== "@vidro/core") continue;
    const have = new Set(
      node.specifiers
        .filter((s): s is t.ImportSpecifier => t.isImportSpecifier(s) && t.isIdentifier(s.imported))
        .map((s) => (s.imported as t.Identifier).name),
    );
    for (const name of names) {
      if (have.has(name)) continue;
      node.specifiers.push(t.importSpecifier(t.identifier(name), t.identifier(name)));
    }
    return;
  }
  ast.program.body.unshift(
    t.importDeclaration(
      Array.from(names).map((n) => t.importSpecifier(t.identifier(n), t.identifier(n))),
      t.stringLiteral("@vidro/core"),
    ),
  );
}
