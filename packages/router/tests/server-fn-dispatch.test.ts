// ADR 0073: server runtime dispatch の単体 test。
//
// 2 ペアを独立に test:
//   1. matchServerFnUrl — URL template と pathname の match + dyn segment 抽出
//      (= 結果は `{ paramName: value }` object 形、ADR 0073 採用 form)
//   2. dispatchServerFn — 実 request を受けて handler 呼出 + JSON wire
//      (= body は `{ params?, data? }` JSON object、handler は `(input, c)` 受け)
//
// Phase 2c は server entry が `.vidro/server-fn-manifest.ts` 経由で entries を
// 渡す経路、本 test では entries を手で組んで dispatch 経路だけ検証する。
//
// ADR 0073 wire 仕様:
//   - body = JSON object `{ params?, data? }` (旧: positional JSON array)
//   - URL の dyn segment 値が `params` slot に object として merge (= URL 優先)
//   - handler signature = `(input: { params, data }, c) => Promise<R>` (旧: `(...args, c)`)
//   - 旧 c.var.body 経路は **削除** (validator slot に統合)

import { describe, expect, it } from "vitest";
import {
  type Context,
  type ServerFnRuntimeEntry,
  dispatchServerFn,
  matchServerFnUrl,
  serverFn,
} from "../src/server-fn";

// --- matchServerFnUrl ---

describe("matchServerFnUrl (ADR 0073)", () => {
  it("static path with no dyn segment matches and returns {}", () => {
    expect(matchServerFnUrl("/posts/new/createPost", "/posts/new/createPost")).toEqual({});
  });

  it("matches with one dyn segment, returns { name: decoded }", () => {
    expect(
      matchServerFnUrl("/posts/[slug]/edit/updatePost", "/posts/abc-slug/edit/updatePost"),
    ).toEqual({ slug: "abc-slug" });
  });

  it("matches with multiple dyn segments, returns all by name", () => {
    expect(
      matchServerFnUrl(
        "/posts/[slug]/comments/[commentId]/updateComment",
        "/posts/abc/comments/42/updateComment",
      ),
    ).toEqual({ slug: "abc", commentId: "42" });
  });

  it("decodes percent-encoded dyn segment values", () => {
    expect(
      matchServerFnUrl("/posts/[slug]/edit/updatePost", "/posts/hello%20world/edit/updatePost"),
    ).toEqual({ slug: "hello world" });
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
    expect(matchServerFnUrl("/foo/[]/bar", "/foo/[]/bar")).toEqual({});
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

describe("dispatchServerFn (ADR 0073 wire)", () => {
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
      body: "{}",
    });
    expect(await dispatchServerFn(req, entries)).toBeNull();
  });

  it("calls matching handler with { params, data } input + c at tail", async () => {
    const entries: ServerFnRuntimeEntry[] = [
      {
        url: "/posts/new/createPost",
        handler: async (input, c) => {
          // ADR 0073: handler は input ({ params, data }) と c (Context) の 2 引数
          expect(input.params).toEqual({}); // dyn segment なし
          expect(input.data).toEqual({ title: "hello" });
          expect(c).toBeDefined();
          return { id: 42, title: "hello" };
        },
      },
    ];
    const req = new Request("https://x/posts/new/createPost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: { title: "hello" } }),
    });
    const res = await dispatchServerFn(req, entries);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toContain("application/json");
    expect(await res!.json()).toEqual({ id: 42, title: "hello" });
  });

  it("merges URL dyn segment values into input.params (= URL 優先)", async () => {
    const entries: ServerFnRuntimeEntry[] = [
      {
        url: "/posts/[slug]/edit/updatePost",
        handler: async (input, c) => {
          expect(input.params).toEqual({ slug: "abc" });
          expect(input.data).toEqual({ title: "new" });
          expect(c).toBeDefined();
          return { ok: true };
        },
      },
    ];
    const req = new Request("https://x/posts/abc/edit/updatePost", {
      method: "POST",
      body: JSON.stringify({ data: { title: "new" } }),
    });
    const res = await dispatchServerFn(req, entries);
    expect(res!.status).toBe(200);
  });

  it("URL params が body.params より優先される (= URL = source of truth)", async () => {
    // wire 規約: URL の dyn segment が source of truth、body の params は defensive
    // 用 (= URL に値があれば body 側は無視)。client stub も通常 URL に埋めて body
    // から params 省略。
    const entries: ServerFnRuntimeEntry[] = [
      {
        url: "/posts/[slug]/edit/updatePost",
        handler: async (input) => {
          expect((input.params as { slug: string }).slug).toBe("from-url");
          return { ok: true };
        },
      },
    ];
    const req = new Request("https://x/posts/from-url/edit/updatePost", {
      method: "POST",
      // body の params.slug は無視されるはず
      body: JSON.stringify({ params: { slug: "from-body" }, data: {} }),
    });
    const res = await dispatchServerFn(req, entries);
    expect(res!.status).toBe(200);
  });

  it("URL に dyn segment が無くても body.params は merge される (= no URL params の case)", async () => {
    const entries: ServerFnRuntimeEntry[] = [
      {
        url: "/x/run",
        handler: async (input) => {
          // URL に dyn なし、body.params がそのまま流れる (= URL は空 {})
          expect(input.params).toEqual({ extra: "from-body" });
          return { ok: true };
        },
      },
    ];
    const req = new Request("https://x/x/run", {
      method: "POST",
      body: JSON.stringify({ params: { extra: "from-body" }, data: {} }),
    });
    const res = await dispatchServerFn(req, entries);
    expect(res!.status).toBe(200);
  });

  it("returns 204 when handler returns undefined (= void)", async () => {
    const entries: ServerFnRuntimeEntry[] = [{ url: "/x/run", handler: async () => undefined }];
    const req = new Request("https://x/x/run", {
      method: "POST",
      body: "{}",
    });
    const res = await dispatchServerFn(req, entries);
    expect(res!.status).toBe(204);
    expect(await res!.text()).toBe("");
  });

  it("empty body (= zero length) is treated as {} input", async () => {
    const entries: ServerFnRuntimeEntry[] = [
      {
        url: "/x/run",
        handler: async (input) => {
          expect(input.params).toEqual({});
          expect(input.data).toBeUndefined();
          return { ok: true };
        },
      },
    ];
    const req = new Request("https://x/x/run", { method: "POST", body: "" });
    const res = await dispatchServerFn(req, entries);
    expect(res!.status).toBe(200);
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

  it("returns 400 when body is JSON but not an object (= scalar / array)", async () => {
    const entries: ServerFnRuntimeEntry[] = [
      { url: "/x/run", handler: async () => ({ ok: true }) },
    ];
    // array は ADR 0073 では不採用 (= 旧 wire との明示的 incompat)
    const req = new Request("https://x/x/run", {
      method: "POST",
      body: JSON.stringify([{ title: "x" }]),
    });
    const res = await dispatchServerFn(req, entries);
    expect(res!.status).toBe(400);
    expect(await res!.json()).toMatchObject({
      error: expect.stringContaining("must be a JSON object"),
    });
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
    const req = new Request("https://x/x/run", { method: "POST", body: "{}" });
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
    // 表現する (= ADR 0073 onion model)、本 test は dispatch 側が catch して wire
    // 化する経路を確認する。middleware が next を呼ばずに Response を返す形で組む。
    const fn = serverFn({
      middleware: [
        async () =>
          new Response(JSON.stringify({ unauthorized: true }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
      ],
      handler: async () => ({ should: "not-reach" }),
    });
    // serverFn の戻り値は public form ((input) => Promise<R>) + .run 経由で
    // internal form ((input, c) => Promise<R>) を取り出して entry に積む経路。
    const entries: ServerFnRuntimeEntry[] = [
      { url: "/x/run", handler: fn.run as ServerFnRuntimeEntry["handler"] },
    ];
    const req = new Request("https://x/x/run", { method: "POST", body: "{}" });
    const res = await dispatchServerFn(req, entries);
    expect(res!.status).toBe(401);
    expect(await res!.json()).toEqual({ unauthorized: true });
  });

  it("propagates env via createContext (= ALS との両立、c は handler の末尾引数)", async () => {
    const captured: { env: unknown }[] = [];
    const entries: ServerFnRuntimeEntry[] = [
      {
        url: "/x/run",
        handler: async (_input, c) => {
          captured.push({ env: (c as Context).env });
          return { ok: true };
        },
      },
    ];
    const req = new Request("https://x/x/run", { method: "POST", body: "{}" });
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
    const req = new Request("https://x/x/run", { method: "POST", body: "{}" });
    const res = await dispatchServerFn(req, entries);
    expect(await res!.json()).toEqual({ which: "first" });
    expect(firstCalled).toBe(1);
    expect(secondCalled).toBe(0);
  });
});
