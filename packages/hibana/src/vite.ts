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

export type HibanaViteOptions = {
  /**
   * `.island.tsx` の glob pattern。vite の root からの絶対パス (= `/` 始まり) で書く。
   * default: `/src/**\/*.island.tsx`
   *
   * 例: monorepo の app が src/ 配下に集約されている前提。深い nest (例:
   * `src/domains/posts/components/Counter.island.tsx`) も `**` で再帰的に拾える。
   */
  islandGlob?: string;
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

  return {
    name: "vidro-hibana-islands",
    // jsxTransform より先に走らせて、素の AST を扱う。jsxTransform は本 plugin の output に
    // 対して child position の `{x}` → `_$dynamicChild(() => x)` 等を後段で適用する。
    enforce: "pre",

    resolveId(id: string) {
      if (id === VIRTUAL_ID) return RESOLVED_VIRTUAL_ID;
      return null;
    },

    load(id: string) {
      if (id !== RESOLVED_VIRTUAL_ID) return null;

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
    },

    transform(code: string, id: string) {
      // `.island.tsx` だけ対象 (= query string `?xxx` が付くケースも吸収)
      const islandMatch = id.match(/([^/]+)\.island\.tsx(?:\?.*)?$/);
      if (!islandMatch) return null;
      if (id.includes("node_modules")) return null;

      const islandName = islandMatch[1]!;

      const ast = parse(code, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
      });

      // default export を探し、Expression として取り出して `defineIsland(expr, name)` で wrap する。
      // FunctionDeclaration (`export default function X() {}`) は FunctionExpression に変換、
      // それ以外の Expression は素通し。既に `defineIsland(...)` 呼び出しなら skip (= 互換)。
      let transformed = false;

      traverse(ast, {
        ExportDefaultDeclaration(path: NodePath<t.ExportDefaultDeclaration>) {
          const decl = path.node.declaration;

          let originalExpr: t.Expression;
          if (t.isFunctionDeclaration(decl)) {
            // `export default function Counter() {}` → FunctionExpression 化
            originalExpr = t.functionExpression(
              decl.id,
              decl.params,
              decl.body,
              decl.generator,
              decl.async,
            );
          } else if (t.isClassDeclaration(decl)) {
            // class component は Hibana では非推奨だが、念のため class expression 化
            originalExpr = t.classExpression(decl.id, decl.superClass, decl.body, decl.decorators);
          } else if (t.isExpression(decl)) {
            originalExpr = decl;
          } else {
            // TSDeclareFunction / etc は実 export ではないので無視
            return;
          }

          // 既に `defineIsland(...)` 呼び出し済かを判定して二重 wrap 防止。
          // identifier 名で判定するので、`import { defineIsland as di } from ...` の alias
          // 経由は判別できない (= 稀な edge case、user は素直に書く前提)。
          if (
            t.isCallExpression(originalExpr) &&
            t.isIdentifier(originalExpr.callee) &&
            originalExpr.callee.name === "defineIsland"
          ) {
            return;
          }

          // `__hibana_defineIsland(<expr>, "<name>")` に置換
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

      // `import { defineIsland as __hibana_defineIsland } from "@vidro/hibana"` を unshift。
      // 既存に同 binding がある可能性は低いが、衝突回避のため `__hibana_defineIsland` という
      // unlikely な local 名で alias 化する。
      const importDecl = t.importDeclaration(
        [t.importSpecifier(t.identifier("__hibana_defineIsland"), t.identifier("defineIsland"))],
        t.stringLiteral("@vidro/hibana"),
      );
      ast.program.body.unshift(importDecl);

      const result = generate(ast, { retainLines: true, sourceMaps: true }, code);
      return { code: result.code, map: result.map };
    },
  };
}
