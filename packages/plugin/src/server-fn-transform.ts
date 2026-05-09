// ADR 0070 Phase 2b: server function source の client 用 transform。
//
// 入力 = server.ts (or *.server.tsx) の生 source、出力 = client bundle 用に
// 改変した source。**responsibilities は AST transform のみ**:
//
//   1. `serverFn(...)` 戻り値の named export を `__vidroServerFnStub("/url")`
//      呼び出しに置換 (= ADR 0070 論点 3-A 自動 fetch stub)
//   2. helper import を頭に注入 (`import { __vidroServerFnStub as $$stub }
//      from "@vidro/router/client"`)
//   3. 置換後に未参照になった import を AST 上で削除 (= server-only deps を
//      Vite resolver にも見せない、tree-shake 待ちより安全)
//
// scope:
//   - serverFn-wrapped exports のみ stub 化 (= async-function は Phase 2b では
//     触らない、Pages mode の `loader` / `action` 互換維持のため)
//   - schema / type / 同期 helper 等の data export は as-is で保持
//   - `*.server.tsx` の default export (= page component) は **本 file では
//     扱わない** (= serverComponent plugin が別途処理する設計)
//
// 設計判断:
//   - babel @parser + @traverse + @generator + @types を使用 (= 既存
//     jsx-transform / scan-imports と同じ stack)
//   - 未使用 import 削除は最小限の reference 解析で実装、Babel 標準の
//     `path.scope.getBinding` を使う方が堅実だがここは self-contained
//     簡易版 (= top-level Identifier 参照を Set 化、import の specifier と照合)
//
// 関連: server-fn-registry.ts (= scan + URL 生成)、server-boundary.ts (= 本
// transform の呼出元 plugin)、server-fn.ts (= runtime serverFn factory)、
// client.ts (= __vidroServerFnStub 実体)。

import { parse } from "@babel/parser";
import _traverse, { type NodePath } from "@babel/traverse";
import _generate from "@babel/generator";
import * as t from "@babel/types";
import { scanServerFnExports, urlForServerFn, type ServerFnEntry } from "./server-fn-registry";

// @babel/traverse / @babel/generator は ESM 互換 (= scan-imports.ts / jsx-transform.ts と同形)
const traverse = (_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse;
const generate = (_generate as unknown as { default?: typeof _generate }).default ?? _generate;

/**
 * stub helper module の default specifier。test override 可能、本番では
 * `@vidro/router/client` 固定。
 */
export const DEFAULT_STUB_HELPER_MODULE = "@vidro/router/client";
const STUB_HELPER_NAME = "__vidroServerFnStub";
const STUB_LOCAL_NAME = "$$_vidro_serverFn_stub";

export type TransformServerFnSourceOptions = {
  source: string;
  filePath: string;
  projectRoot: string;
  srcDir?: string;
  routesDir?: string;
  /** stub helper の import 元、test override 用 */
  helperModuleId?: string;
};

export type TransformServerFnSourceResult = {
  /** transform 適用後の source。何も transform 対象がなければ source と同等 */
  code: string;
  /** transform 結果に含まれた entries (= URL / kind 含む)、長さ 0 なら no-op */
  entries: ServerFnEntry[];
};

/**
 * server.ts source を client bundle 用に transform する。
 *
 * - `export const fn = serverFn(...)` の `serverFn(...)` 部分を
 *   `__vidroServerFnStub("/url")` に置換 (= URL は urlForServerFn で生成)
 * - stub helper の import を頭に注入 (= 重複防止のため既存 import がなければ
 *   1 行追加)
 * - 置換後に未参照になった import を削除 (= server-only deps を Vite resolver
 *   にも触らせない)
 *
 * `entries` は scan で見つかった server function の全 list。stub 化したのは
 * `kind === "serverFn-wrapped"` のみ、`async-function` は kind 識別だけして
 * 触らない (= Phase 2b スコープ外、Pages mode `loader` / `action` 互換維持)。
 */
export function transformServerFnSourceForClient(
  options: TransformServerFnSourceOptions,
): TransformServerFnSourceResult {
  const helperModuleId = options.helperModuleId ?? DEFAULT_STUB_HELPER_MODULE;
  const exports = scanServerFnExports(options.source, options.filePath);

  // serverFn-wrapped の exportName → URL の map を先に作って AST 走査で参照
  const wrappedUrlByExport = new Map<string, ServerFnEntry>();
  const entries: ServerFnEntry[] = [];
  for (const exp of exports) {
    const url = urlForServerFn({
      filePath: options.filePath,
      exportName: exp.exportName,
      projectRoot: options.projectRoot,
      srcDir: options.srcDir,
      routesDir: options.routesDir,
    });
    const entry: ServerFnEntry = { ...exp, filePath: options.filePath, url };
    entries.push(entry);
    if (exp.kind === "serverFn-wrapped") {
      wrappedUrlByExport.set(exp.exportName, entry);
    }
  }

  // 1 件も serverFn-wrapped なし → transform 不要 (= source そのまま返す)
  // 呼出元 (= plugin) が別経路 (= empty stub fallback) を選ぶのに使う
  if (wrappedUrlByExport.size === 0) {
    return { code: options.source, entries };
  }

  const ast = parse(options.source, {
    sourceType: "module",
    plugins: ["jsx", "typescript"],
  });

  // 1. serverFn(...) call を $$stub("/url") に置換
  traverse(ast, {
    ExportNamedDeclaration(path) {
      const decl = path.node.declaration;
      if (!decl || decl.type !== "VariableDeclaration") return;
      for (const declarator of decl.declarations) {
        if (declarator.id.type !== "Identifier") continue;
        const exportName = declarator.id.name;
        const entry = wrappedUrlByExport.get(exportName);
        if (!entry) continue;
        if (!declarator.init) continue;
        if (
          declarator.init.type !== "CallExpression" ||
          declarator.init.callee.type !== "Identifier" ||
          declarator.init.callee.name !== "serverFn"
        ) {
          continue;
        }
        // serverFn(...) 全体を $$stub("/url") に差し替える
        declarator.init = t.callExpression(t.identifier(STUB_LOCAL_NAME), [
          t.stringLiteral(entry.url),
        ]);
      }
    },
  });

  // 2. 未使用 import を削除。先に全 referenced Identifier を集める。
  //    binding 元の import specifier 自身は除外したいので isReferencedIdentifier
  //    を使う (= identifier が参照位置にあれば true、宣言位置なら false)。
  const referencedNames = new Set<string>();
  traverse(ast, {
    Identifier(path: NodePath<t.Identifier>) {
      if (path.isReferencedIdentifier()) {
        referencedNames.add(path.node.name);
      }
    },
    JSXIdentifier(path: NodePath<t.JSXIdentifier>) {
      // JSX tag 名 (`<Foo />`) は ReferencedIdentifier にはならないので別途拾う。
      // .server.tsx 想定外でも、universal `.tsx` や Phase 2b 後の対応で安全側に倒す。
      if (path.node.name && path.node.name[0] === path.node.name[0]?.toUpperCase()) {
        referencedNames.add(path.node.name);
      }
    },
  });

  // import を walk、referenced されていない specifier は drop。
  // bare import (`import "./side-effect"`) と全 specifier が参照されている import
  // はそのまま、全 specifier が drop された場合は import 文自体も削除。
  traverse(ast, {
    ImportDeclaration(path) {
      const node = path.node;
      // type-only import 全体は不要 (= verbatimModuleSyntax 環境下で client bundle
      // にも漏らさない、tsdown も同等に扱う)
      if (node.importKind === "type") {
        path.remove();
        return;
      }
      // bare import (= side-effect) は触らない
      if (node.specifiers.length === 0) return;

      const remaining = node.specifiers.filter((spec) => {
        // type-only specifier は drop
        if ((spec as { importKind?: string }).importKind === "type") return false;
        return referencedNames.has(spec.local.name);
      });

      if (remaining.length === 0) {
        path.remove();
      } else if (remaining.length !== node.specifiers.length) {
        node.specifiers = remaining;
      }
    },
  });

  // 3. stub helper import を **重複させずに** 注入する。
  //
  //    重要な順序制約:
  //      step 1 (= serverFn(...) → $$stub(...) 置換) で AST に
  //      `STUB_LOCAL_NAME` identifier が現れる。step 2 は referenced 集合
  //      化、step 3 は import drop、ここまで本 helper import は AST に存在
  //      しない。本 step 4 (= unshift / merge) は **drop 走査の後** に
  //      置くこと。順序を入れ替えると helperImport の specifier が drop
  //      対象になるリスクがある。
  //
  //    重複対策:
  //      user file が既に `helperModuleId` から何かを import している場合、
  //      新規 import 行を unshift せず既存 ImportDeclaration の specifiers
  //      に `STUB_HELPER_NAME` を merge する。重複 import 行は downstream
  //      bundler で dedup されるかもしれないが、SSR pass / workerd 等で
  //      二重評価リスクが残るので AST レベルで一本化しておく。
  const stubSpecifier = t.importSpecifier(
    t.identifier(STUB_LOCAL_NAME),
    t.identifier(STUB_HELPER_NAME),
  );
  const existingHelperImport = ast.program.body.find(
    (node): node is t.ImportDeclaration =>
      node.type === "ImportDeclaration" && node.source.value === helperModuleId,
  );
  if (existingHelperImport) {
    existingHelperImport.specifiers.push(stubSpecifier);
  } else {
    ast.program.body.unshift(t.importDeclaration([stubSpecifier], t.stringLiteral(helperModuleId)));
  }

  // 4. 出力。既存 jsx-transform.ts の pattern に合わせて { code } を取り出す。
  const { code } = generate(ast, { retainLines: false, compact: false });
  return { code, entries };
}
