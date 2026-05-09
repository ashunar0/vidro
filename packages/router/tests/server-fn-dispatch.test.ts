// ADR 0070 Phase 2c + ADR 0072: server runtime dispatch の単体 test。
//
// 2 ペアを独立に test:
//   1. matchServerFnUrl — URL template と pathname の match + dyn segment 抽出
//   2. dispatchServerFn — 実 request を受けて handler 呼出 + JSON wire
//
// Phase 2c は server entry が `.vidro/server-fn-manifest.ts` 経由で entries を
// 渡す経路、本 test では entries を手で組んで dispatch 経路だけ検証する。
//
// ADR 0072 に伴う変更: handler は `(...args, c)` で呼ばれる (= c 末尾)。test 内
// fixture handler は user code 風の `(input, _c?: Context) => R` または raw
// `(...args: unknown[]) => R` のどちらでも受けられる。dyn segment + body の後、
// 最後の args が c になる。

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

describe("dispatchServerFn (Phase 2c + ADR 0072)", () => {
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

  it("calls matching handler with body args spread + c at tail (ADR 0072)", async () => {
    const entries: ServerFnRuntimeEntry[] = [
      {
        url: "/posts/new/createPost",
        handler: async (...args: unknown[]) => {
          // ADR 0072: 末尾の args が c (Context)、それ以前が dyn segment + body。
          // 本 entry は dyn segment 0 個、body 1 個、c で args.length === 2。
          expect(args.length).toBe(2);
          expect(args[0]).toEqual({ title: "hello" });
          expect(args[1]).toBeDefined(); // c (Context)
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

  it("spreads dyn segment values before body args, c at tail", async () => {
    const entries: ServerFnRuntimeEntry[] = [
      {
        url: "/posts/[slug]/edit/updatePost",
        handler: async (...args: unknown[]) => {
          // args[0] = slug (dyn), args[1] = body input, args[2] = c (末尾)
          expect(args.length).toBe(3);
          expect(args[0]).toBe("abc");
          expect(args[1]).toEqual({ title: "new" });
          expect(args[2]).toBeDefined(); // c
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
    // 経路を確認)。middleware が next を呼ばずに Response を返す形で組む。
    const fn = serverFn(
      async (_c, _next) =>
        new Response(JSON.stringify({ unauthorized: true }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      async () => ({ should: "not-reach" }),
    );
    // serverFn の戻り値は public form (= ServerFn<P, R> = (...args) + .run)、
    // ServerFnRuntimeEntry["handler"] は internal form (= (...args, c)) なので
    // .run 経由で internal form を取り出して entry に積む経路。`as unknown as`
    // は plugin auto-gen 側 (= .vidro/server-fn-manifest.ts) と同形 — TS の
    // tuple-length contravariance で固定 length tuple → readonly unknown[] への
    // 直接 assign が通らないため、registry 統一型に合わせて cast で逃がす。
    const entries: ServerFnRuntimeEntry[] = [
      { url: "/x/run", handler: fn.run as unknown as ServerFnRuntimeEntry["handler"] },
    ];
    const req = new Request("https://x/x/run", { method: "POST", body: "[]" });
    const res = await dispatchServerFn(req, entries);
    expect(res!.status).toBe(401);
    expect(await res!.json()).toEqual({ unauthorized: true });
  });

  it("propagates env via createContext (= ALS との両立、c は末尾引数)", async () => {
    const captured: { env: unknown }[] = [];
    const entries: ServerFnRuntimeEntry[] = [
      {
        url: "/x/run",
        // dyn / body 0 個 + c 1 個、handler signature `(c: Context) => R`
        handler: async (...args: unknown[]) => {
          const c = args[args.length - 1] as Context;
          captured.push({ env: c.env });
          return { ok: true };
        },
      },
    ];
    const req = new Request("https://x/x/run", { method: "POST", body: "[]" });
    await dispatchServerFn(req, entries, { env: { D1: "binding-stub" } });
    expect(captured[0]?.env).toEqual({ D1: "binding-stub" });
  });

  it("places body in c.var.body for validator middleware (= ADR 0072 論点 5-A)", async () => {
    // dispatch は bodyArgs を c.var.body に詰める経路を持つ (= validator
    // middleware が schema parse 用に参照する)。bodyArgs.length === 1 なら raw
    // を入れる。
    const captured: unknown[] = [];
    const entries: ServerFnRuntimeEntry[] = [
      {
        url: "/x/run",
        handler: async (...args: unknown[]) => {
          const c = args[args.length - 1] as Context;
          captured.push(c.var.body);
          return { ok: true };
        },
      },
    ];
    const req = new Request("https://x/x/run", {
      method: "POST",
      body: JSON.stringify([{ title: "from-body" }]),
    });
    await dispatchServerFn(req, entries);
    expect(captured[0]).toEqual({ title: "from-body" });
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
