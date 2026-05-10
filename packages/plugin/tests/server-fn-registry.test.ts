// ADR 0070 Phase 2a + ADR 0073: server function registry の単体 test。
//
// 3 つの関数を独立に test:
//   1. scanServerFnExports — AST scan、export 抽出
//   2. urlForServerFn — file path + export name → URL
//   3. discoverServerFns — project root walk + collision 検出
//
// fs walk は VirtualFs override で in-memory tree を組んで test する (= 実 fs
// に手を入れない、CI 環境差異も避ける)。
//
// ADR 0073 採用後の fixture: serverFn は object slot config 1 個渡し
// (`serverFn({ middleware?, validator?, handler })`)、handler は
// `({ params, data, ctx })` で受ける。scanner は callee.name のみ見るので
// 内部 args 形には透過、本 fixture は user 側 syntax を新形式に揃えた表現。

import { describe, expect, it } from "vitest";
import {
  discoverServerFns,
  scanServerFnExports,
  urlForServerFn,
  type VirtualFs,
} from "../src/server-fn-registry";

// --- scanServerFnExports ---

describe("scanServerFnExports", () => {
  it("picks up serverFn-wrapped const export", () => {
    const source = `
      import { serverFn } from "@vidro/router";
      export const createPost = serverFn({
        handler: async ({ data }) => ({ id: 1, ...data }),
      });
    `;
    const exports = scanServerFnExports(source, "/proj/src/routes/posts/server.ts");
    expect(exports).toEqual([{ exportName: "createPost", kind: "serverFn-wrapped" }]);
  });

  it("picks up serverFn with middleware + validator config", () => {
    const source = `
      import { serverFn } from "@vidro/router";
      export const createPost = serverFn({
        middleware: [authMw],
        validator: { data: dataSchema },
        handler: async ({ data, ctx }) => ({ ...data, by: ctx.user }),
      });
    `;
    const exports = scanServerFnExports(source, "/proj/src/routes/posts/server.ts");
    expect(exports).toEqual([{ exportName: "createPost", kind: "serverFn-wrapped" }]);
  });

  it("picks up async function declaration export", () => {
    const source = `
      export async function getPost(slug: string) {
        return { id: slug };
      }
    `;
    const exports = scanServerFnExports(source, "/proj/src/routes/posts/server.ts");
    expect(exports).toEqual([{ exportName: "getPost", kind: "async-function" }]);
  });

  it("picks up async arrow function export", () => {
    const source = `
      export const fetchAll = async () => {
        return [];
      };
    `;
    const exports = scanServerFnExports(source, "/proj/src/routes/posts/server.ts");
    expect(exports).toEqual([{ exportName: "fetchAll", kind: "async-function" }]);
  });

  it("picks up multiple exports from one file", () => {
    const source = `
      import { serverFn } from "@vidro/router";
      export const createPost = serverFn({ handler: async ({ data }) => data });
      export const deletePost = serverFn({ handler: async ({ params }) => params.slug });
      export async function getPost(slug: string) { return slug; }
    `;
    const exports = scanServerFnExports(source, "/proj/src/routes/posts/server.ts");
    expect(exports).toEqual([
      { exportName: "createPost", kind: "serverFn-wrapped" },
      { exportName: "deletePost", kind: "serverFn-wrapped" },
      { exportName: "getPost", kind: "async-function" },
    ]);
  });

  it("ignores non-server-function const exports (= schema, constants)", () => {
    const source = `
      import { z } from "zod";
      export const schema = z.object({ title: z.string() });
      export const FOO = "bar";
      export const arr = [1, 2, 3];
    `;
    const exports = scanServerFnExports(source, "/proj/src/routes/posts/server.ts");
    expect(exports).toEqual([]);
  });

  it("ignores non-async function exports", () => {
    const source = `
      export function helper() { return 42; }
      export const sync = () => 1;
    `;
    const exports = scanServerFnExports(source, "/proj/src/routes/posts/server.ts");
    expect(exports).toEqual([]);
  });

  it("ignores default export (= page component in *.server.tsx)", () => {
    const source = `
      import { serverFn } from "@vidro/router";
      export const createPost = serverFn({ handler: async ({ data }) => data });
      export default async function NewPost() {
        return null;
      }
    `;
    const exports = scanServerFnExports(source, "/proj/src/routes/posts/new/index.server.tsx");
    expect(exports).toEqual([{ exportName: "createPost", kind: "serverFn-wrapped" }]);
  });

  it("ignores type / interface exports", () => {
    const source = `
      export type CreatePostInput = { title: string };
      export interface Post { id: number }
    `;
    const exports = scanServerFnExports(source, "/proj/src/routes/posts/server.ts");
    expect(exports).toEqual([]);
  });

  // 現状制約: aliased import (`import { serverFn as sf } from "@vidro/router"`)
  // 経由の call は拾えない (= Phase 2d で build error 化候補、本 test は意図確認)。
  it("does NOT pick up aliased serverFn call (= current limitation)", () => {
    const source = `
      import { serverFn as sf } from "@vidro/router";
      export const createPost = sf({ handler: async ({ data }) => data });
    `;
    const exports = scanServerFnExports(source, "/proj/src/routes/posts/server.ts");
    // sf(...) は CallExpression だが callee.name === "sf" なので serverFn-wrapped
    // としては認識されない。alias は user code でほぼ使われない想定、Phase 2d
    // で alias 検出 + build error or alias call 認識のどちらかを決める。
    expect(exports).toEqual([]);
  });

  it("handles JSX in *.server.tsx alongside server function exports", () => {
    const source = `
      import { serverFn } from "@vidro/router";
      export const createPost = serverFn({ handler: async ({ data }) => data });
      export default async function NewPost() {
        return <div>hello</div>;
      }
    `;
    const exports = scanServerFnExports(source, "/proj/src/routes/posts/new/index.server.tsx");
    expect(exports).toEqual([{ exportName: "createPost", kind: "serverFn-wrapped" }]);
  });
});

// --- urlForServerFn ---

describe("urlForServerFn", () => {
  const projectRoot = "/proj";

  it("strips routes/ for routes-internal server.ts", () => {
    const url = urlForServerFn({
      filePath: "/proj/src/routes/posts/[slug]/edit/server.ts",
      exportName: "updatePost",
      projectRoot,
    });
    expect(url).toBe("/posts/[slug]/edit/updatePost");
  });

  it("strips routes/ and .server.tsx filename for *.server.tsx", () => {
    const url = urlForServerFn({
      filePath: "/proj/src/routes/posts/new/index.server.tsx",
      exportName: "createPost",
      projectRoot,
    });
    expect(url).toBe("/posts/new/createPost");
  });

  it("keeps directory part for routes-external server.ts (= features/)", () => {
    const url = urlForServerFn({
      filePath: "/proj/src/features/posts/server.ts",
      exportName: "createPost",
      projectRoot,
    });
    expect(url).toBe("/features/posts/createPost");
  });

  it("keeps directory part for routes-external server.ts (= api/)", () => {
    const url = urlForServerFn({
      filePath: "/proj/src/api/upload/server.ts",
      exportName: "uploadFile",
      projectRoot,
    });
    expect(url).toBe("/api/upload/uploadFile");
  });

  it("returns /${exportName} for src/routes/server.ts (= empty path)", () => {
    const url = urlForServerFn({
      filePath: "/proj/src/routes/server.ts",
      exportName: "getRoot",
      projectRoot,
    });
    expect(url).toBe("/getRoot");
  });

  it("returns /${exportName} for src/server.ts (= no routes prefix, root)", () => {
    const url = urlForServerFn({
      filePath: "/proj/src/server.ts",
      exportName: "ping",
      projectRoot,
    });
    expect(url).toBe("/ping");
  });

  it("supports custom srcDir / routesDir", () => {
    const url = urlForServerFn({
      filePath: "/proj/app/views/posts/server.ts",
      exportName: "createPost",
      projectRoot,
      srcDir: "app",
      routesDir: "views",
    });
    expect(url).toBe("/posts/createPost");
  });

  it("throws when filePath is outside src/", () => {
    expect(() =>
      urlForServerFn({
        filePath: "/proj/lib/utils/server.ts",
        exportName: "createPost",
        projectRoot,
      }),
    ).toThrow(/outside src\/ directory/);
  });

  it("throws when basename is unrecognized", () => {
    expect(() =>
      urlForServerFn({
        filePath: "/proj/src/routes/posts/random.ts",
        exportName: "createPost",
        projectRoot,
      }),
    ).toThrow(/not a recognized server function file/);
  });
});

// --- discoverServerFns ---

/**
 * In-memory fs を組み立てる helper。tree は absolute path → string の map。
 * 値が "DIR" 文字列なら directory marker、それ以外は file 内容として扱う。
 */
function makeFs(tree: Record<string, string>): VirtualFs {
  return {
    existsSync(path) {
      return tree[path] !== undefined;
    },
    readdirSync(path) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const children = new Set<string>();
      for (const key of Object.keys(tree)) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (!rest) continue;
        const head = rest.split("/")[0];
        if (head) children.add(head);
      }
      return [...children];
    },
    statSync(path) {
      const v = tree[path];
      const isDir = v === "DIR";
      return {
        isDirectory: () => isDir,
        isFile: () => v !== undefined && !isDir,
      };
    },
    readFileSync(path) {
      const v = tree[path];
      if (v === undefined || v === "DIR") {
        throw new Error(`ENOENT: ${path}`);
      }
      return v;
    },
  };
}

describe("discoverServerFns", () => {
  const projectRoot = "/proj";

  it("returns empty for project without src/", () => {
    const fs = makeFs({});
    const entries = discoverServerFns({ projectRoot, fs });
    expect(entries).toEqual([]);
  });

  it("walks src/ and picks up server.ts files", () => {
    const fs = makeFs({
      "/proj/src": "DIR",
      "/proj/src/routes": "DIR",
      "/proj/src/routes/posts": "DIR",
      "/proj/src/routes/posts/server.ts": `
        import { serverFn } from "@vidro/router";
        export const createPost = serverFn({ handler: async ({ data }) => data });
      `,
    });
    const entries = discoverServerFns({ projectRoot, fs });
    expect(entries).toEqual([
      {
        filePath: "/proj/src/routes/posts/server.ts",
        exportName: "createPost",
        kind: "serverFn-wrapped",
        url: "/posts/createPost",
      },
    ]);
  });

  it("picks up *.server.tsx alongside server.ts", () => {
    const fs = makeFs({
      "/proj/src": "DIR",
      "/proj/src/routes": "DIR",
      "/proj/src/routes/posts": "DIR",
      "/proj/src/routes/posts/new": "DIR",
      "/proj/src/routes/posts/new/index.server.tsx": `
        import { serverFn } from "@vidro/router";
        export const createPost = serverFn({ handler: async ({ data }) => data });
        export default async function NewPost() { return null; }
      `,
    });
    const entries = discoverServerFns({ projectRoot, fs });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      exportName: "createPost",
      kind: "serverFn-wrapped",
      url: "/posts/new/createPost",
    });
  });

  it("excludes layout.server.ts (= loader 用途)", () => {
    const fs = makeFs({
      "/proj/src": "DIR",
      "/proj/src/routes": "DIR",
      "/proj/src/routes/layout.server.ts": `
        export const loader = async () => ({});
      `,
    });
    const entries = discoverServerFns({ projectRoot, fs });
    expect(entries).toEqual([]);
  });

  it("skips node_modules / .vidro / dist / dotfiles", () => {
    const fs = makeFs({
      "/proj/src": "DIR",
      "/proj/src/node_modules": "DIR",
      "/proj/src/node_modules/foo": "DIR",
      "/proj/src/node_modules/foo/server.ts":
        "export const fn = serverFn({ handler: async () => {} });",
      "/proj/src/.vidro": "DIR",
      "/proj/src/.vidro/server.ts": "export const fn = serverFn({ handler: async () => {} });",
      "/proj/src/dist": "DIR",
      "/proj/src/dist/server.ts": "export const fn = serverFn({ handler: async () => {} });",
      "/proj/src/.git": "DIR",
      "/proj/src/.git/server.ts": "export const fn = serverFn({ handler: async () => {} });",
    });
    const entries = discoverServerFns({ projectRoot, fs });
    expect(entries).toEqual([]);
  });

  it("walks routes-external directories (= features/, api/)", () => {
    const fs = makeFs({
      "/proj/src": "DIR",
      "/proj/src/features": "DIR",
      "/proj/src/features/posts": "DIR",
      "/proj/src/features/posts/server.ts": `
        import { serverFn } from "@vidro/router";
        export const createPost = serverFn({ handler: async ({ data }) => data });
      `,
      "/proj/src/api": "DIR",
      "/proj/src/api/upload": "DIR",
      "/proj/src/api/upload/server.ts": `
        import { serverFn } from "@vidro/router";
        export const uploadFile = serverFn({ handler: async ({ data }) => data });
      `,
    });
    const entries = discoverServerFns({ projectRoot, fs });
    const urls = entries.map((e) => e.url).sort();
    expect(urls).toEqual(["/api/upload/uploadFile", "/features/posts/createPost"]);
  });

  it("throws on URL collision (= 同 URL に 2 entry)", () => {
    const fs = makeFs({
      "/proj/src": "DIR",
      "/proj/src/routes": "DIR",
      "/proj/src/routes/posts": "DIR",
      "/proj/src/routes/posts/server.ts": `
        import { serverFn } from "@vidro/router";
        export const createPost = serverFn({ handler: async ({ data }) => data });
      `,
      "/proj/src/routes/posts/index.server.tsx": `
        import { serverFn } from "@vidro/router";
        export const createPost = serverFn({ handler: async ({ data }) => data });
        export default function () { return null; }
      `,
    });
    expect(() => discoverServerFns({ projectRoot, fs })).toThrow(/URL collision/);
  });

  it("scans multiple files across mixed locations", () => {
    const fs = makeFs({
      "/proj/src": "DIR",
      "/proj/src/routes": "DIR",
      "/proj/src/routes/posts": "DIR",
      "/proj/src/routes/posts/[slug]": "DIR",
      "/proj/src/routes/posts/[slug]/edit": "DIR",
      "/proj/src/routes/posts/[slug]/edit/server.ts": `
        import { serverFn } from "@vidro/router";
        export const updatePost = serverFn({ handler: async ({ params, data }) => ({ slug: params.slug, input: data }) });
      `,
      "/proj/src/routes/posts/new": "DIR",
      "/proj/src/routes/posts/new/index.server.tsx": `
        import { serverFn } from "@vidro/router";
        export const createPost = serverFn({ handler: async ({ data }) => data });
        export default async function NewPost() { return null; }
      `,
      "/proj/src/api": "DIR",
      "/proj/src/api/upload": "DIR",
      "/proj/src/api/upload/server.ts": `
        export async function uploadFile(file) { return file; }
      `,
    });
    const entries = discoverServerFns({ projectRoot, fs });
    const summary = entries
      .map((e) => ({ url: e.url, kind: e.kind }))
      .sort((a, b) => (a.url < b.url ? -1 : 1));
    expect(summary).toEqual([
      { url: "/api/upload/uploadFile", kind: "async-function" },
      { url: "/posts/[slug]/edit/updatePost", kind: "serverFn-wrapped" },
      { url: "/posts/new/createPost", kind: "serverFn-wrapped" },
    ]);
  });
});
