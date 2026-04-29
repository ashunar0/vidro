import { parse } from "@babel/parser";
import _traverse, { type NodePath } from "@babel/traverse";
import _generate from "@babel/generator";
import * as t from "@babel/types";
import type { Plugin } from "vite";

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
 * **child 位置** の transform は **親が intrinsic か component か** で振り分ける
 * (ADR 0019 + ADR 0025):
 *
 * - **intrinsic 親** (`<div>` 等、lowercase tag):
 *   - JSXText `hi` → `_$text("hi")`
 *   - JSXExpressionContainer `{x}` → `_$dynamicChild(() => x)`
 *   - 目的は SSR hydration の post-order cursor との整合 (h() 引数として **先に**
 *     評価されることで、`createText` が `createElement(parent)` より前に呼ばれる)
 *
 * - **component 親** (`<Foo>` PascalCase / `<Foo.Bar>` JSXMemberExpression):
 *   - JSXText `hi` → `() => _$text("hi")`
 *   - JSXExpressionContainer `{x}` → `() => x`
 *   - JSXElement / JSXFragment → `() => <X />` (= `() => h(X)`)
 *   - ArrowFunction / FunctionExpression → 素通し (`<For>{(item) => ...}</For>`、
 *     `<ErrorBoundary>{() => <Child />}</ErrorBoundary>` 等)
 *   - 目的は children の遅延評価。Show / Switch / For の inactive children /
 *     fallback の eager 評価問題を解消し、foldRouteTree の inside-out fold 順序
 *     問題も解決する (ADR 0025 = B-4)
 *
 * **attribute 位置で JSXElement / JSXFragment が来た場合** (`fallback={<X />}` 等):
 * 親 JSXElement が component なら `() => <X />` に thunk 化、intrinsic なら素通し。
 * primitive の `fallback: () => Node` 規約と整合させる。
 *
 * wrap しないケース (attribute 位置):
 *   - `on*` 属性 (event handler はそのまま関数として渡す)
 *   - 関数リテラル (`() => ...`、`function () { ... }`)
 *   - 空の `{}` (JSXEmptyExpression)
 *   - intrinsic attribute の JSXElement / JSXFragment (今まで通り素通し)
 *
 * 親判定が **JSXElement のみ** で、JSXFragment (`<>...</>`) は intrinsic 扱い
 * (Fragment 自体には children を遅延評価する必要が無い、DOM fragment として展開)。
 *
 * plugin order は `enforce: "pre"` で、vite の他の transform より前に走らせる。
 */
export function jsxTransform(): Plugin {
  return {
    name: "vidro-jsx-transform",
    enforce: "pre",
    // user の vite.config.ts に jsx 設定を書かせないため、plugin の config() hook
    // で必要な設定を一括で push する。React/Solid plugin と同じ流儀 (user は
    // plugin 1 個書くだけで済む)。
    //
    // vite-plus は OXC ベースに移行済 (vite-plus 0.1.x で `esbuild` option は
    // deprecated)。@vitejs/plugin-react と同じ `oxc.jsx.{runtime, importSource}` を
    // 設定し、JSX 自動 import の解決先を Vidro の jsx-runtime に向ける。
    config() {
      return {
        oxc: {
          jsx: {
            runtime: "automatic" as const,
            importSource: "@vidro/core",
          },
        },
      };
    },
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

          // attribute 位置: on* は素通し、それ以外は親 JSX が component かどうかで分岐
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

            // attribute 位置の JSXElement / JSXFragment は親 JSXElement が component
            // なら thunk 化、intrinsic なら素通し (今まで通り)。`fallback={<X />}` 等
            // primitive の `() => Node` 規約に揃える。
            if (t.isJSXElement(expr) || t.isJSXFragment(expr)) {
              const owner = findOwningJSXElement(path);
              if (owner && isComponentJSXElement(owner)) {
                path.node.expression = t.arrowFunctionExpression([], expr);
              }
              return;
            }

            path.node.expression = t.callExpression(t.identifier("_reactive"), [
              t.arrowFunctionExpression([], expr),
            ]);
            needed.add("_reactive");
            return;
          }

          // child 位置 (JSXElement / JSXFragment の中)
          if (t.isJSXElement(parent) || t.isJSXFragment(parent)) {
            const expr = path.node.expression;
            if (t.isJSXEmptyExpression(expr)) return;

            // ArrowFunction / FunctionExpression は素通し (component 親でも intrinsic
            // 親でも同じ — ユーザーが書いた callback はそのまま値として渡す)
            if (t.isArrowFunctionExpression(expr) || t.isFunctionExpression(expr)) return;

            const isComponentParent = t.isJSXElement(parent) && isComponentJSXElement(parent);

            if (isComponentParent) {
              // component child: getter 化 (eager 評価せず、primitive 側で必要時呼ぶ)
              if (t.isJSXElement(expr) || t.isJSXFragment(expr)) {
                path.node.expression = t.arrowFunctionExpression([], expr);
                return;
              }
              // {x} → () => x
              path.node.expression = t.arrowFunctionExpression([], expr);
              return;
            }

            // intrinsic 親: 既存挙動 (post-order を保つため _$dynamicChild で先評価)
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

          const isComponentParent = t.isJSXElement(parent) && isComponentJSXElement(parent);

          if (isComponentParent) {
            // component child の text: () => _$text("...") で getter 化。children() を
            // 呼んだ primitive 側に Node が渡るよう、_$text で Text Node を返す形に統一
            const replacement = t.jsxExpressionContainer(
              t.arrowFunctionExpression(
                [],
                t.callExpression(t.identifier("_$text"), [t.stringLiteral(value)]),
              ),
            );
            path.replaceWith(replacement);
            needed.add("_$text");
            return;
          }

          // intrinsic 親: 既存挙動 (_$text を h() 引数として直接渡す)
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

// JSXElement の openingElement 名で component か intrinsic かを判別 (ADR 0025 論点 2-a)。
//   - JSXIdentifier で先頭が大文字 → component (`<Foo>`)
//   - JSXMemberExpression → component (`<Foo.Bar>`)
//   - JSXNamespacedName → intrinsic 扱い (`<svg:rect>` 等、SVG namespace 用)
//   - JSXIdentifier で先頭が小文字 → intrinsic (`<div>` / custom element)
function isComponentJSXElement(node: t.JSXElement): boolean {
  const name = node.openingElement.name;
  if (t.isJSXMemberExpression(name)) return true;
  if (t.isJSXIdentifier(name)) {
    const first = name.name[0];
    return first !== undefined && first >= "A" && first <= "Z";
  }
  return false;
}

// 直近の親 JSXElement (= attribute / child の所有者) を辿る。`fallback={<X />}` で
// JSXExpressionContainer 内の JSXElement の親 JSX が component かどうかを判定したい時に使う。
function findOwningJSXElement(path: NodePath): t.JSXElement | null {
  const found = path.findParent((p) => t.isJSXElement(p.node));
  return found ? (found.node as t.JSXElement) : null;
}

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
