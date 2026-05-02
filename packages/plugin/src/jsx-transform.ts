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

      // ADR 0055: intrinsic 親 (`<div>` 等) の children sequence を scan して、
      // adjacent text/expr 境界に marker を inject する。HTML parser は adjacent
      // text を 1 Text Node に merge するので、`Go to User #{count.value}` を
      // `_$text(...)` + `_$dynamicChild(...)` の 2 Text Node として SSR すると
      // browser parse 後に 1 Node に潰れて hydrate cursor がズレる。
      //
      // 間に `_$marker()` (= empty Comment) を挟むと server / client / browser parse
      // すべてで「Text + Comment + Text」の 3 Node 構造が保たれて post-order が一致する。
      //
      // 走るのは JSXExpressionContainer / JSXText 個別 traversal の **前** に enter
      // でやる。children の構造を書き換えてから個別 transform に渡すと、新規 inject
      // した `_$marker()` の expression を再 transform 対象にしないよう
      // `__vidroMarkerInjected` で skip する。
      traverse(ast, {
        JSXElement: {
          enter(path) {
            if (isComponentJSXElement(path.node)) return;
            injectMarkers(path.node, needed);
          },
        },
      });

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

            // ADR 0055: injectMarkers が intrinsic 親の adjacent text/expr 境界に
            // 挟んだ `_$marker()` call はそのまま素通す。`_$dynamicChild(() => _$marker())`
            // で wrap すると Text Node 化されてしまい marker の意味が変わる。
            //
            // 識別子名で判定すると `import { _$marker as m } from "@vidro/core"` の
            // alias 経由で skip が効かなくなるので、injectMarkers が node 自身に付けた
            // VIDRO_MARKER_TAG flag (symbol-keyed) を見て binding-safe に判別する。
            if (isInjectedMarkerNode(path.node)) return;

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

type HelperName = "_reactive" | "_$text" | "_$dynamicChild" | "_$marker";

// ADR 0055: intrinsic 親の children を scan して、adjacent text/expr 境界に
// `_$marker()` (= empty Comment) を inject する。HTML parser の adjacent text merge
// で hydrate cursor がズレる問題を防ぐ。
//
// 挿入規則 (両側が「実行時に Text Node を生成する可能性がある」場合に挿入):
//   - JSXText × JSXExpressionContainer (with non-Element expr) → 挿入
//   - JSXExpressionContainer × JSXText → 挿入
//   - JSXExpressionContainer × JSXExpressionContainer (両側 non-Element) → 挿入
//   - JSXElement / JSXFragment が片方にあれば → 挿入不要 (Element は別 Node に展開)
//   - whitespace-only JSXText は両側 boundary 判定から除外 (= sequence 上 prev 更新せず skip)
//
// JSXFragment 親は Fragment 自身が DOM fragment に展開されて peer の adjacent merge は
// 問題にならない (= 各 child が parent intrinsic に individually append される)。本 pass
// は JSXElement intrinsic 親のみで動かす。
function injectMarkers(parent: t.JSXElement, needed: Set<HelperName>): void {
  const children = parent.children;
  if (children.length < 2) return;

  const out: t.JSXElement["children"] = [];
  let prev: t.JSXElement["children"][number] | null = null;

  for (const c of children) {
    if (isWhitespaceOnlyJSXText(c)) {
      // whitespace-only text は SSR / runtime ともに emit されない (= JSXText handler
      // で `value.trim() === ""` を捨てる)。boundary 判定からも除外して、prev は更新しない。
      out.push(c);
      continue;
    }
    if (prev !== null && needsMarker(prev, c)) {
      out.push(makeMarkerExpressionContainer());
      needed.add("_$marker");
    }
    out.push(c);
    prev = c;
  }
  parent.children = out;
}

// JSX whitespace rule: oxc / babel cleanJSXElementLiteralChild は **改行を含む
// whitespace-only JSXText** を formatting noise として drop する。一方、改行を
// 含まない whitespace (= `<p>{a} {b}</p>` の " " 等) は preserve され、runtime で
// Text Node として emit される。
//
// 後者を skip 扱いすると prev 更新が止まり「{a} の後ろに marker なしで続く { b}」
// が SSR で `[a] [b]` (Text + Text) → browser が 1 Text に merge → cursor mismatch、
// となる。preserved な whitespace text は textish と扱って boundary 判定に参加させ
// る必要がある。
//
// 本関数は「実際には emit されない (= drop される) whitespace」のみ skip 対象として返す。
function isWhitespaceOnlyJSXText(node: t.JSXElement["children"][number]): boolean {
  if (!t.isJSXText(node)) return false;
  if (node.value.trim() !== "") return false;
  // 改行を含む whitespace は cleanJSX で drop される、preserve_whitespace 側に倒さない
  return /[\n\r]/.test(node.value);
}

function needsMarker(
  prev: t.JSXElement["children"][number],
  next: t.JSXElement["children"][number],
): boolean {
  return isTextish(prev) && isTextish(next);
}

// 「実行時に Text Node を生成する可能性がある」を静的に判定する。安全側に倒し、
// 確実に Element / Fragment になる場合 (= JSXElement / JSXFragment 直書き) のみ false。
function isTextish(node: t.JSXElement["children"][number]): boolean {
  if (t.isJSXText(node)) return true;
  if (t.isJSXExpressionContainer(node)) {
    const expr = node.expression;
    if (t.isJSXEmptyExpression(expr)) return false;
    // expr が JSXElement / JSXFragment 直書きなら Element Node 確定、boundary を作らない。
    // それ以外 (識別子 / call / template literal / 演算 / 配列 / 三項 / 関数式 / Logical 等)
    // は実行時に Text Node 化される可能性があるので marker 必要。
    if (t.isJSXElement(expr) || t.isJSXFragment(expr)) return false;
    return true;
  }
  // JSXElement / JSXFragment / JSXSpreadChild は Element 系、boundary を作らない
  return false;
}

// injectMarkers が生成した JSXExpressionContainer に付ける internal flag。symbol を
// 使うことで user 側 source code から偽装できない (= AST が symbol property を持つことは
// parser からは起きない) + identifier 名 alias の影響も受けない。
const VIDRO_MARKER_TAG = Symbol("vidro:marker");

type MarkedNode = t.JSXExpressionContainer & { [VIDRO_MARKER_TAG]?: true };

function isInjectedMarkerNode(node: t.JSXExpressionContainer): boolean {
  return (node as MarkedNode)[VIDRO_MARKER_TAG] === true;
}

function makeMarkerExpressionContainer(): t.JSXExpressionContainer {
  const node = t.jsxExpressionContainer(
    t.callExpression(t.identifier("_$marker"), []),
  ) as MarkedNode;
  node[VIDRO_MARKER_TAG] = true;
  return node;
}

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
