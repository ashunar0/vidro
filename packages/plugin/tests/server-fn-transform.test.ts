// ADR 0070 Phase 2b + ADR 0072: server function source の client 用 transform の単体 test。
//
// AST in/out で 4 観点を確認:
//   1. serverFn(...) call が __vidroServerFnStub("/url") に置換される
//   2. data export (= schema, 同期 helper, type 等) は as-is で残る
//   3. 未参照になった import (= server-only deps) が drop される
//   4. helper import が頭に注入される
//
// transformServerFnSourceForClient は文字列 in / 文字列 out なので、output 文字列
// に対して **「ある substring を含む / 含まない」** の assertion で stable に判定。
// AST 構造比較は generator output の空白に依存するので避ける。
//
// ADR 0072 採用後の fixture: handler signature は pure service form
// (`async (input) => R`) を default、c が要る case のみ末尾で受ける。

import { describe, expect, it } from "vitest";
import { transformServerFnSourceForClient } from "../src/server-fn-transform";

describe("transformServerFnSourceForClient", () => {
  const projectRoot = "/proj";

  it("replaces serverFn(...) with __vidroServerFnStub('/url') call", () => {
    const source = `
      import { serverFn } from "@vidro/router";
      export const createPost = serverFn(async (input) => input);
    `;
    const { code, entries } = transformServerFnSourceForClient({
      source,
      filePath: "/proj/src/routes/posts/new/server.ts",
      projectRoot,
    });
    expect(entries).toEqual([
      {
        filePath: "/proj/src/routes/posts/new/server.ts",
        exportName: "createPost",
        kind: "serverFn-wrapped",
        url: "/posts/new/createPost",
      },
    ]);
    // import + stub call が出ていること
    expect(code).toContain('from "@vidro/router/client"');
    expect(code).toContain("__vidroServerFnStub");
    expect(code).toContain('"/posts/new/createPost"');
    // 元の serverFn(...) call と handler 本体が消えていること
    expect(code).not.toMatch(/serverFn\s*\(/);
    expect(code).not.toContain("async (input) => input");
  });

  it("preserves data exports (= schema)", () => {
    const source = `
      import { z } from "zod";
      import { serverFn } from "@vidro/router";
      export const createPostSchema = z.object({ title: z.string() });
      export const createPost = serverFn(async (input) => input);
    `;
    const { code } = transformServerFnSourceForClient({
      source,
      filePath: "/proj/src/routes/posts/new/server.ts",
      projectRoot,
    });
    // schema export はそのまま残る (= name + z.object call が残る)
    expect(code).toContain("createPostSchema");
    expect(code).toContain("z.object");
    expect(code).toContain('from "zod"');
  });

  it("removes unused imports after replacement (= server-only deps)", () => {
    const source = `
      import { db } from "@/data/posts";
      import { serverFn } from "@vidro/router";
      export const createPost = serverFn(async (input) => {
        return db.insert(input);
      });
    `;
    const { code } = transformServerFnSourceForClient({
      source,
      filePath: "/proj/src/routes/posts/new/server.ts",
      projectRoot,
    });
    // db は serverFn(...) handler 内のみで参照、stub 化後は誰も参照しない → import drop
    expect(code).not.toContain('"@/data/posts"');
    // serverFn import も使われなくなる → drop
    expect(code).not.toMatch(/import\s+{\s*serverFn\s*}\s+from\s+"@vidro\/router"/);
    // helper import は残る
    expect(code).toContain('from "@vidro/router/client"');
  });

  it("keeps imports whose bindings remain referenced", () => {
    const source = `
      import { z } from "zod";
      import { CONST } from "./shared";
      import { serverFn } from "@vidro/router";
      export const schema = z.object({ x: z.string().default(CONST) });
      export const fn = serverFn(async (input) => input);
    `;
    const { code } = transformServerFnSourceForClient({
      source,
      filePath: "/proj/src/features/x/server.ts",
      projectRoot,
    });
    // z は schema 内で参照されてる → import 残る
    expect(code).toContain('from "zod"');
    // CONST も参照されてる → import 残る
    expect(code).toContain('from "./shared"');
  });

  it("returns source as-is when no serverFn-wrapped exports found", () => {
    const source = `
      import { db } from "@/data/posts";
      export async function action({ request }) {
        const fd = await request.formData();
        return db.insert(fd);
      }
    `;
    const result = transformServerFnSourceForClient({
      source,
      filePath: "/proj/src/routes/posts/server.ts",
      projectRoot,
    });
    // serverFn-wrapped 0 件 → transform 不要、code は source と同等
    expect(result.code).toBe(source);
    // entries は async-function を含むが kind が serverFn-wrapped でないので
    // stub 化されてない (= 呼出元 plugin で empty stub fallback されるべき信号)
    expect(result.entries).toEqual([
      {
        filePath: "/proj/src/routes/posts/server.ts",
        exportName: "action",
        kind: "async-function",
        url: "/posts/action",
      },
    ]);
  });

  it("handles multiple serverFn exports with dynamic param URL", () => {
    const source = `
      import { db } from "@/data/posts";
      import { serverFn } from "@vidro/router";
      export const updatePost = serverFn(async (slug, input) => db.update(slug, input));
      export const deletePost = serverFn(async (slug) => db.delete(slug));
    `;
    const { code, entries } = transformServerFnSourceForClient({
      source,
      filePath: "/proj/src/routes/posts/[slug]/edit/server.ts",
      projectRoot,
    });
    expect(entries.map((e) => e.url).sort()).toEqual([
      "/posts/[slug]/edit/deletePost",
      "/posts/[slug]/edit/updatePost",
    ]);
    expect(code).toContain('"/posts/[slug]/edit/updatePost"');
    expect(code).toContain('"/posts/[slug]/edit/deletePost"');
    // db 参照は両方とも消えるので import drop
    expect(code).not.toContain('"@/data/posts"');
  });

  it("removes type-only imports", () => {
    const source = `
      import type { Post } from "@/data/posts";
      import { serverFn } from "@vidro/router";
      export const createPost = serverFn(async (input: Post) => input);
    `;
    const { code } = transformServerFnSourceForClient({
      source,
      filePath: "/proj/src/routes/posts/new/server.ts",
      projectRoot,
    });
    // type-only import は client bundle で即 drop (= verbatimModuleSyntax 安全側)
    expect(code).not.toContain('"@/data/posts"');
  });

  it("preserves bare side-effect imports", () => {
    const source = `
      import "./side-effect";
      import { serverFn } from "@vidro/router";
      export const fn = serverFn(async (input) => input);
    `;
    const { code } = transformServerFnSourceForClient({
      source,
      filePath: "/proj/src/features/x/server.ts",
      projectRoot,
    });
    // bare import (= 0 specifier) は side-effect 用途、削除しない
    expect(code).toContain('"./side-effect"');
  });

  it("supports custom helperModuleId for testing", () => {
    const source = `
      import { serverFn } from "@vidro/router";
      export const fn = serverFn(async (input) => input);
    `;
    const { code } = transformServerFnSourceForClient({
      source,
      filePath: "/proj/src/routes/x/server.ts",
      projectRoot,
      helperModuleId: "/__test/stub-helper",
    });
    expect(code).toContain('from "/__test/stub-helper"');
  });

  it("does not stub aliased serverFn call (= current limitation)", () => {
    const source = `
      import { serverFn as sf } from "@vidro/router";
      import { db } from "@/data";
      export const fn = sf(async (input) => db.x(input));
    `;
    const { code, entries } = transformServerFnSourceForClient({
      source,
      filePath: "/proj/src/routes/x/server.ts",
      projectRoot,
    });
    // alias は scanServerFnExports が拾わない → stub 化対象なし
    expect(entries).toEqual([]);
    expect(code).toBe(source);
  });

  it("does not stub re-export form (= current limitation, silent fail)", () => {
    // `export { _fn as createPost }` 形式は scanServerFnExports が拾わない (=
    // Phase 2a / 2b scope 外)、Phase 2d で build error 化候補。本 test は意図確認
    // (= silent に通り抜けて empty stub fallback、client 側で undefined になる
    // pattern を documented にする)。
    const source = `
      import { serverFn } from "@vidro/router";
      const _fn = serverFn(async (input) => input);
      export { _fn as createPost };
    `;
    const { code, entries } = transformServerFnSourceForClient({
      source,
      filePath: "/proj/src/routes/posts/server.ts",
      projectRoot,
    });
    // entries 0 件 → 呼出元 plugin で empty stub fallback、client 側で
    // `import { createPost } from "./server"` は undefined になる (= Phase 2d で
    // build error 化候補)。
    expect(entries).toEqual([]);
    expect(code).toBe(source);
  });

  it("merges helper import into existing import from @vidro/router/client (= no duplicate)", () => {
    // user file が既に `@vidro/router/client` から何かを import してたケースで
    // duplicate import 行を生やさないこと。Phase 2c / SSR pass / workerd 等で
    // 二重評価リスクを避ける。
    const source = `
      import { boot } from "@vidro/router/client";
      import { serverFn } from "@vidro/router";
      export const fn = serverFn(async (input) => input);
      export const _kept = boot;
    `;
    const { code } = transformServerFnSourceForClient({
      source,
      filePath: "/proj/src/routes/x/server.ts",
      projectRoot,
    });
    // `from "@vidro/router/client"` の出現が **1 行のみ** であること
    const matches = code.match(/from\s+"@vidro\/router\/client"/g) ?? [];
    expect(matches).toHaveLength(1);
    // 既存 specifier (= boot) と stub helper (= __vidroServerFnStub) が同 import
    // 行に merge されてること
    expect(code).toContain("boot");
    expect(code).toContain("__vidroServerFnStub");
  });
});
