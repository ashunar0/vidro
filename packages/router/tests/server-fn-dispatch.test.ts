// ADR 0070 Phase 2c: server runtime dispatch の単体 test。
//
// 2 ペアを独立に test:
//   1. matchServerFnUrl — URL template と pathname の match + dyn segment 抽出
//   2. dispatchServerFn — 実 request を受けて handler 呼出 + JSON wire
//
// Phase 2c は server entry が `.vidro/server-fn-manifest.ts` 経由で entries を
// 渡す経路、本 test では entries を手で組んで dispatch 経路だけ検証する。

import { describe, expect, it } from "vitest";
import {
  type Context,
  type ServerFnRuntimeEntry,
  dispatchServerFn,
  matchServerFnUrl,
  serverFn,
} from "../src/server-fn";

// --- matchServerFnUrl ---

describe("matchServerFnUrl (Phase 2c)", () => {
  it("static path with no dyn segment matches and returns []", () => {
    expect(matchServerFnUrl("/posts/new/createPost", "/posts/new/createPost")).toEqual([]);
  });

  it("matches with one dyn segment, returns its decoded value", () => {
    expect(
      matchServerFnUrl("/posts/[slug]/edit/updatePost", "/posts/abc-slug/edit/updatePost"),
    ).toEqual(["abc-slug"]);
  });

  it("matches with multiple dyn segments, returns values in order", () => {
    expect(
      matchServerFnUrl(
        "/posts/[slug]/comments/[commentId]/updateComment",
        "/posts/abc/comments/42/updateComment",
      ),
    ).toEqual(["abc", "42"]);
  });

  it("decodes percent-encoded dyn segment values", () => {
    expect(
      matchServerFnUrl("/posts/[slug]/edit/updatePost", "/posts/hello%20world/edit/updatePost"),
    ).toEqual(["hello world"]);
  });

  it("returns null when static segment differs", () => {
    expect(
      matchServerFnUrl("/posts/[slug]/edit/updatePost", "/posts/abc/delete/updatePost"),
    ).toBeNull();
  });

  it("returns null when path length differs", () => {
    expect(matchServerFnUrl("/posts/new/createPost", "/posts/new")).toBeNull();
    expect(matchServerFnUrl("/posts/new", "/posts/new/createPost")).toBeNull();
  });

  it("returns null when function name segment differs (= 末尾までチェック)", () => {
    expect(matchServerFnUrl("/posts/new/createPost", "/posts/new/deletePost")).toBeNull();
  });

  it("does not match partial bracket segment (= [foo]bar 形式は static 扱い)", () => {
    // [slug]bar のような partial bracket は採用しない (= ADR 0070 論点 7 簡素化)
    expect(matchServerFnUrl("/[slug]bar/x", "/abcbar/x")).toBeNull();
  });

  it("treats [] (empty bracket) as static segment (= length < 3)", () => {
    // 空 `[]` は意味のない placeholder、static 扱いで literal `[]` に対してのみ
    // 一致 (= dyn segment として誤認しない)
    expect(matchServerFnUrl("/foo/[]/bar", "/foo/anything/bar")).toBeNull();
    expect(matchServerFnUrl("/foo/[]/bar", "/foo/[]/bar")).toEqual([]);
  });

  it("returns null when dyn segment contains invalid percent encoding", () => {
    // `%GG` 等の invalid percent sequence は decodeURIComponent が URIError を
    // throw するので、match 失敗扱い (= null) に倒す。dispatch は次の entry に
    // 移って最終的に no-match で fall-through、呼出元 (= createServerHandler) が
    // 次の path に流す経路。
    expect(
      matchServerFnUrl("/posts/[slug]/edit/updatePost", "/posts/%GG/edit/updatePost"),
    ).toBeNull();
  });
});

// --- dispatchServerFn ---

describe("dispatchServerFn (Phase 2c)", () => {
  it("returns null for non-POST requests (= GET 等は別 path に流す)", async () => {
    const entries: ServerFnRuntimeEntry[] = [
      { url: "/posts/new/createPost", handler: async () => ({ id: 1 }) },
    ];
    const req = new Request("https://x/posts/new/createPost", { method: "GET" });
    expect(await dispatchServerFn(req, entries)).toBeNull();
  });

  it("returns null when no entry URL matches", async () => {
    const entries: ServerFnRuntimeEntry[] = [
      { url: "/posts/new/createPost", handler: async () => ({ id: 1 }) },
    ];
    const req = new Request("https://x/posts/new/somethingElse", {
      method: "POST",
      body: "[]",
    });
    expect(await dispatchServerFn(req, entries)).toBeNull();
  });

  it("calls matching handler with body args spread, returns 200 + JSON", async () => {
    const entries: ServerFnRuntimeEntry[] = [
      {
        url: "/posts/new/createPost",
        handler: async (_c: Context, ...args: unknown[]) => {
          // body args は 1 個 (= input object)
          expect(args).toEqual([{ title: "hello" }]);
          return { id: 42, title: "hello" };
        },
      },
    ];
    const req = new Request("https://x/posts/new/createPost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ title: "hello" }]),
    });
    const res = await dispatchServerFn(req, entries);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toContain("application/json");
    expect(await res!.json()).toEqual({ id: 42, title: "hello" });
  });

  it("spreads dyn segment values before body args", async () => {
    const entries: ServerFnRuntimeEntry[] = [
      {
        url: "/posts/[slug]/edit/updatePost",
        handler: async (_c: Context, ...args: unknown[]) => {
          // args[0] = slug (dyn), args[1] = body input
          expect(args[0]).toBe("abc");
          expect(args[1]).toEqual({ title: "new" });
          return { ok: true };
        },
      },
    ];
    const req = new Request("https://x/posts/abc/edit/updatePost", {
      method: "POST",
      body: JSON.stringify([{ title: "new" }]),
    });
    const res = await dispatchServerFn(req, entries);
    expect(res!.status).toBe(200);
  });

  it("returns 204 when handler returns undefined (= void)", async () => {
    const entries: ServerFnRuntimeEntry[] = [{ url: "/x/run", handler: async () => undefined }];
    const req = new Request("https://x/x/run", {
      method: "POST",
      body: "[]",
    });
    const res = await dispatchServerFn(req, entries);
    expect(res!.status).toBe(204);
    expect(await res!.text()).toBe("");
  });

  it("returns 400 when body is not valid JSON", async () => {
    const entries: ServerFnRuntimeEntry[] = [
      { url: "/x/run", handler: async () => ({ ok: true }) },
    ];
    const req = new Request("https://x/x/run", { method: "POST", body: "{not-json" });
    const res = await dispatchServerFn(req, entries);
    expect(res!.status).toBe(400);
    expect(await res!.json()).toMatchObject({ error: expect.stringContaining("invalid JSON") });
  });

  it("returns 500 + JSON when handler throws Error", async () => {
    const entries: ServerFnRuntimeEntry[] = [
      {
        url: "/x/run",
        handler: async () => {
          throw new Error("boom");
        },
      },
    ];
    const req = new Request("https://x/x/run", { method: "POST", body: "[]" });
    // console.error の noise を test 時抑制 (= dispatchServerFn が出力する経路)
    const orig = console.error;
    console.error = (): void => {};
    try {
      const res = await dispatchServerFn(req, entries);
      expect(res!.status).toBe(500);
      expect(await res!.json()).toEqual({ error: "boom" });
    } finally {
      console.error = orig;
    }
  });

  it("uses Response thrown by middleware as wire (= early return)", async () => {
    // serverFn factory は middleware の早期 return を Response throw として
    // 表現する (= Phase 1 設計、本 test は dispatch 側が catch して wire 化する
    // 経路を確認)。
    const fn = serverFn(
      async (_c: Context, _next): Promise<Response> => {
        // Phase 1 の Middleware signature は (c, next) => void | Response、本 test
        // では middleware が next を呼ばずに Response を返す形を作る。
        return new Response(JSON.stringify({ unauthorized: true }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      },
      async (_c: Context) => ({ should: "not-reach" }),
    );
    const entries: ServerFnRuntimeEntry[] = [{ url: "/x/run", handler: fn }];
    const req = new Request("https://x/x/run", { method: "POST", body: "[]" });
    const res = await dispatchServerFn(req, entries);
    expect(res!.status).toBe(401);
    expect(await res!.json()).toEqual({ unauthorized: true });
  });

  it("propagates env via createContext (= ALS との両立)", async () => {
    const captured: { env: unknown }[] = [];
    const entries: ServerFnRuntimeEntry[] = [
      {
        url: "/x/run",
        handler: async (c: Context) => {
          captured.push({ env: c.env });
          return { ok: true };
        },
      },
    ];
    const req = new Request("https://x/x/run", { method: "POST", body: "[]" });
    await dispatchServerFn(req, entries, { env: { D1: "binding-stub" } });
    expect(captured[0]?.env).toEqual({ D1: "binding-stub" });
  });

  it("matches earliest entry, ignores later entries with same URL", async () => {
    let firstCalled = 0;
    let secondCalled = 0;
    const entries: ServerFnRuntimeEntry[] = [
      {
        url: "/x/run",
        handler: async () => {
          firstCalled++;
          return { which: "first" };
        },
      },
      {
        url: "/x/run",
        handler: async () => {
          secondCalled++;
          return { which: "second" };
        },
      },
    ];
    const req = new Request("https://x/x/run", { method: "POST", body: "[]" });
    const res = await dispatchServerFn(req, entries);
    expect(await res!.json()).toEqual({ which: "first" });
    expect(firstCalled).toBe(1);
    expect(secondCalled).toBe(0);
  });
});
