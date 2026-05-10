// ADR 0073 unit test: serverFn() factory (object slot form)。
//
// internal form (= `.run({ params, data }, c)` で末尾必須 c) を test する。
// public form は bundler 経由 stub に置換される経路 (Phase 2/4)、本 test は core
// 機構 (= middleware chain / ctx accumulation / validator slot / 早期 return) を
// 確認する。
//
// 旧 ADR 0070+0072 の test (positional + Hono c subset) を全面 rewrite。
// 主な変更:
//   - handler 引数: `(slug, input, c)` → `({ params, data, ctx })`
//   - middleware 引数: `(c, next)` → `({ c, ctx, next })`
//   - middleware 間値受け渡し: `c.set/c.var` → `next({ ctx })` + `args.ctx`
//   - validator: `next([override])` 経路 → `validator: { params, data }` slot
//   - handler は c を受けない (= ADR 0073 論点 3-i 完全排除)、c subset の test は
//     middleware 経由に書き直し

import { describe, expect, it } from "vitest";
import {
  createContext,
  defineMiddleware,
  type ExecutionContext,
  type Middleware,
  type ValidatorSlot,
  serverFn,
} from "../src/server-fn";
import { runWithRequestEnv } from "../src/request-env-scope";

describe("serverFn (ADR 0073 object slot form)", () => {
  describe("基本動作", () => {
    it("middleware も validator も無しで handler を呼べる", async () => {
      const fn = serverFn({
        handler: async ({ data }: { data: { name: string } }) => `hello ${data.name}`,
      });
      const c = createContext({ request: new Request("https://example.com/") });
      const result = await fn.run({ data: { name: "world" } }, c);
      expect(result).toBe("hello world");
    });

    it("params slot と data slot を同時に渡せる", async () => {
      const fn = serverFn({
        handler: async ({
          params,
          data,
        }: {
          params: { slug: string };
          data: { title: string };
        }) => ({
          slug: params.slug,
          title: data.title,
        }),
      });
      const c = createContext({ request: new Request("https://example.com/") });
      const result = await fn.run({ params: { slug: "abc" }, data: { title: "T" } }, c);
      expect(result).toEqual({ slug: "abc", title: "T" });
    });

    it("handler 戻り値が serverFn の戻り値になる", async () => {
      const fn = serverFn({ handler: async () => 42 });
      const c = createContext({ request: new Request("https://example.com/") });
      expect(await fn.run({}, c)).toBe(42);
    });

    it("sync handler でも動く (= async でなくても OK)", async () => {
      const fn = serverFn({ handler: () => "sync" });
      const c = createContext({ request: new Request("https://example.com/") });
      expect(await fn.run({}, c)).toBe("sync");
    });

    it("handler が空 input ({} 渡し) でも動く (= no params/data の serverFn)", async () => {
      const fn = serverFn({ handler: async () => ({ ok: true }) });
      const c = createContext({ request: new Request("https://example.com/") });
      expect(await fn.run({}, c)).toEqual({ ok: true });
    });
  });

  describe("middleware chain (= onion model)", () => {
    it("middleware → handler の順で実行される", async () => {
      const order: string[] = [];
      const mw: Middleware = async ({ next }) => {
        order.push("mw before");
        await next();
        order.push("mw after");
      };
      const fn = serverFn({
        middleware: [mw],
        handler: async () => {
          order.push("handler");
          return "ok";
        },
      });
      const c = createContext({ request: new Request("https://example.com/") });
      const result = await fn.run({}, c);
      expect(result).toBe("ok");
      expect(order).toEqual(["mw before", "handler", "mw after"]);
    });

    it("複数 middleware を chain できる (= onion model)", async () => {
      const order: string[] = [];
      const mw1: Middleware = async ({ next }) => {
        order.push("mw1 before");
        await next();
        order.push("mw1 after");
      };
      const mw2: Middleware = async ({ next }) => {
        order.push("mw2 before");
        await next();
        order.push("mw2 after");
      };
      const fn = serverFn({
        middleware: [mw1, mw2],
        handler: async () => {
          order.push("handler");
        },
      });
      const c = createContext({ request: new Request("https://example.com/") });
      await fn.run({}, c);
      expect(order).toEqual(["mw1 before", "mw2 before", "handler", "mw2 after", "mw1 after"]);
    });

    it("middleware が next({ ctx }) で inject した値を handler が ctx で読める", async () => {
      const auth = defineMiddleware<{ user: { id: string } }>(async ({ next }) => {
        await next({ ctx: { user: { id: "u1" } } });
      });
      const fn = serverFn({
        middleware: [auth],
        handler: async ({ ctx }) => ctx.user.id,
      });
      const c = createContext({ request: new Request("https://example.com/") });
      expect(await fn.run({}, c)).toBe("u1");
    });

    it("複数 middleware の ctx delta が intersection で accumulate される", async () => {
      const mwA = defineMiddleware<{ user: string }>(async ({ next }) => {
        await next({ ctx: { user: "alice" } });
      });
      const mwB = defineMiddleware<{ requestId: string }>(async ({ next }) => {
        await next({ ctx: { requestId: "req-42" } });
      });
      const fn = serverFn({
        middleware: [mwA, mwB],
        handler: async ({ ctx }) => ({
          user: ctx.user,
          requestId: ctx.requestId,
        }),
      });
      const c = createContext({ request: new Request("https://example.com/") });
      expect(await fn.run({}, c)).toEqual({ user: "alice", requestId: "req-42" });
    });

    it("後段 middleware は前段 ctx を `args.ctx` で読める (= downward 伝播)", async () => {
      const mwA = defineMiddleware<{ user: string }>(async ({ next }) => {
        await next({ ctx: { user: "alice" } });
      });
      // mwB は前段 mwA が inject した user を読んで派生値を作る
      const mwB = defineMiddleware<{ greeting: string }>(async ({ ctx, next }) => {
        const user = (ctx as { user?: string }).user ?? "guest";
        await next({ ctx: { greeting: `hello ${user}` } });
      });
      const fn = serverFn({
        middleware: [mwA, mwB],
        handler: async ({ ctx }) => ctx.greeting,
      });
      const c = createContext({ request: new Request("https://example.com/") });
      expect(await fn.run({}, c)).toBe("hello alice");
    });

    it("ctx delta が後勝ちで merge される (= JS object spread と同 semantics)", async () => {
      const mwA = defineMiddleware<{ user: string }>(async ({ next }) => {
        await next({ ctx: { user: "alice" } });
      });
      const mwB = defineMiddleware<{ user: string }>(async ({ next }) => {
        await next({ ctx: { user: "bob" } });
      });
      const fn = serverFn({
        middleware: [mwA, mwB],
        handler: async ({ ctx }) => ctx.user,
      });
      const c = createContext({ request: new Request("https://example.com/") });
      expect(await fn.run({}, c)).toBe("bob");
    });
  });

  describe("早期 return (= auth fail / 422 等)", () => {
    it("middleware が next() を呼ばずに Response 返すと throw される", async () => {
      const denyAll: Middleware = async () => new Response("forbidden", { status: 403 });
      const fn = serverFn({
        middleware: [denyAll],
        handler: async () => "should not reach",
      });
      const c = createContext({ request: new Request("https://example.com/") });
      await expect(fn.run({}, c)).rejects.toBeInstanceOf(Response);
    });

    it("早期 return された Response の status を確認できる", async () => {
      const denyAll: Middleware = async () => new Response("forbidden", { status: 403 });
      const fn = serverFn({
        middleware: [denyAll],
        handler: async () => "x",
      });
      const c = createContext({ request: new Request("https://example.com/") });
      try {
        await fn.run({}, c);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(Response);
        expect((err as Response).status).toBe(403);
      }
    });

    it("middleware が next() も Response も呼ばない/返さない場合は素通り (= 設計違反だが silent)", async () => {
      // ADR 0073 では runMiddleware が「次段に進まないだけ」で error は出さない。
      // 後段 middleware + handler が呼ばれず、戻り値は handler の return ではなく
      // undefined (= last middleware の return)。本 test は「silent path」を確認する
      // だけで、設計違反 detection は別 lint で行う想定。
      let handlerCalled = false;
      // biome-ignore lint/suspicious/useAwait: 意図的に next を呼ばない broken middleware
      const broken: Middleware = async () => {
        // do nothing
      };
      const fn = serverFn({
        middleware: [broken],
        handler: async () => {
          handlerCalled = true;
          return "x";
        },
      });
      const c = createContext({ request: new Request("https://example.com/") });
      const result = await fn.run({}, c);
      expect(result).toBeUndefined();
      expect(handlerCalled).toBe(false);
    });

    it("middleware が next() を 2 回呼ぶと error", async () => {
      const buggy: Middleware = async ({ next }) => {
        await next();
        await next();
      };
      const fn = serverFn({
        middleware: [buggy],
        handler: async () => "x",
      });
      const c = createContext({ request: new Request("https://example.com/") });
      await expect(fn.run({}, c)).rejects.toThrow(/multiple times/);
    });

    it("途中の middleware で短絡すると後続 handler は呼ばれない", async () => {
      let handlerCalled = false;
      const auth: Middleware = async () => new Response("nope", { status: 401 });
      const fn = serverFn({
        middleware: [auth],
        handler: async () => {
          handlerCalled = true;
          return "x";
        },
      });
      const c = createContext({ request: new Request("https://example.com/") });
      await expect(fn.run({}, c)).rejects.toBeInstanceOf(Response);
      expect(handlerCalled).toBe(false);
    });

    it("inner middleware の早期 return 後も outer middleware の after コードは実行される (= Hono/Koa 同形)", async () => {
      // 設計の意図: outer の `await next()` から制御が戻った後の after コードは
      // inner の早期 return とは独立に走る。earlyResponse は最上層に伝わって
      // throw されるが、各 middleware の after は onion を unwind する経路で
      // 実行される (= Hono/Koa の middleware semantics と同形)。
      const order: string[] = [];
      const outer: Middleware = async ({ next }) => {
        order.push("outer before");
        await next();
        order.push("outer after");
      };
      const inner: Middleware = async () => new Response("forbidden", { status: 403 });
      const fn = serverFn({
        middleware: [outer, inner],
        handler: async () => "should not reach",
      });
      const c = createContext({ request: new Request("https://example.com/") });
      await expect(fn.run({}, c)).rejects.toBeInstanceOf(Response);
      expect(order).toEqual(["outer before", "outer after"]);
    });

    it("middleware が next() 後に Response 返しても handler 戻り値を優先 (= Hono 同形)", async () => {
      // next() 呼んだ後の Response 戻り値は無視する (= chain semantics 維持)。
      // 早期 return は next() を呼ばないことで明示する設計。
      const wrap: Middleware = async ({ next }) => {
        await next();
        return new Response("ignored", { status: 200 });
      };
      const fn = serverFn({
        middleware: [wrap],
        handler: async () => "handler-result",
      });
      const c = createContext({ request: new Request("https://example.com/") });
      expect(await fn.run({}, c)).toBe("handler-result");
    });
  });

  describe("middleware から見る Context (= Hono c subset、handler は c を受けない)", () => {
    it("middleware から c.req.url と c.req.headers が引ける", async () => {
      const captured: { url?: string; accept?: string | null } = {};
      const inspect: Middleware = async ({ c, next }) => {
        captured.url = c.req.url;
        captured.accept = c.req.headers.get("accept");
        await next();
      };
      const fn = serverFn({
        middleware: [inspect],
        handler: async () => "ok",
      });
      const c = createContext({
        request: new Request("https://example.com/foo", {
          headers: { accept: "application/json" },
        }),
      });
      await fn.run({}, c);
      expect(captured.url).toBe("https://example.com/foo");
      expect(captured.accept).toBe("application/json");
    });

    it("middleware から c.req.query で URL query 取得できる", async () => {
      const captured: { q?: string } = {};
      const inspect: Middleware = async ({ c, next }) => {
        captured.q = c.req.query("q");
        await next();
      };
      const fn = serverFn({
        middleware: [inspect],
        handler: async () => "ok",
      });
      const c = createContext({ request: new Request("https://example.com/?q=hello") });
      await fn.run({}, c);
      expect(captured.q).toBe("hello");
    });

    it("c.req.query 未指定 key は undefined", async () => {
      const captured: { v?: string } = {};
      const inspect: Middleware = async ({ c, next }) => {
        captured.v = c.req.query("missing");
        await next();
      };
      const fn = serverFn({
        middleware: [inspect],
        handler: async () => "ok",
      });
      const c = createContext({ request: new Request("https://example.com/") });
      await fn.run({}, c);
      expect(captured.v).toBeUndefined();
    });

    it("middleware から c.env が引数で渡された env と一致する", async () => {
      type MyEnv = { DB: string; API_KEY: string };
      const env: MyEnv = { DB: "fake-d1", API_KEY: "secret" };
      const captured: { env?: MyEnv } = {};
      const inspect: Middleware = async ({ c, next }) => {
        captured.env = c.env as MyEnv;
        await next();
      };
      const fn = serverFn({
        middleware: [inspect],
        handler: async () => "ok",
      });
      const c = createContext({ request: new Request("https://example.com/"), env });
      await fn.run({}, c);
      expect(captured.env).toEqual(env);
    });

    it("env 未指定 + ALS scope 外なら c.env は undefined", async () => {
      const captured: { env?: unknown } = {};
      const inspect: Middleware = async ({ c, next }) => {
        captured.env = c.env;
        await next();
      };
      const fn = serverFn({
        middleware: [inspect],
        handler: async () => "ok",
      });
      const c = createContext({ request: new Request("https://example.com/") });
      await fn.run({}, c);
      expect(captured.env).toBeUndefined();
    });

    it("middleware から c.executionCtx?.waitUntil() が動く", async () => {
      const calls: Promise<unknown>[] = [];
      const ec: ExecutionContext = {
        waitUntil(p) {
          calls.push(p);
        },
        passThroughOnException() {
          // noop for test
        },
      };
      const inspect: Middleware = async ({ c, next }) => {
        c.executionCtx?.waitUntil(Promise.resolve("bg-task"));
        await next();
      };
      const fn = serverFn({
        middleware: [inspect],
        handler: async () => "ok",
      });
      const c = createContext({
        request: new Request("https://example.com/"),
        executionCtx: ec,
      });
      await fn.run({}, c);
      expect(calls.length).toBe(1);
    });
  });

  describe("ALS scope と統合 (= getRequestEnv 互換)", () => {
    it("ALS scope active なら c.env は ALS env になる", async () => {
      type MyEnv = { source: "als" };
      const captured: { env?: MyEnv } = {};
      const inspect: Middleware = async ({ c, next }) => {
        captured.env = c.env as MyEnv;
        await next();
      };
      const fn = serverFn({
        middleware: [inspect],
        handler: async () => "ok",
      });
      await runWithRequestEnv({ source: "als" } satisfies MyEnv, async () => {
        const c = createContext({ request: new Request("https://example.com/") });
        await fn.run({}, c);
      });
      expect(captured.env).toEqual({ source: "als" });
    });

    it("引数 env が ALS scope より優先される", async () => {
      const captured: { env?: unknown } = {};
      const inspect: Middleware = async ({ c, next }) => {
        captured.env = c.env;
        await next();
      };
      const fn = serverFn({
        middleware: [inspect],
        handler: async () => "ok",
      });
      await runWithRequestEnv({ source: "als" }, async () => {
        const c = createContext({
          request: new Request("https://example.com/"),
          env: { source: "explicit" },
        });
        await fn.run({}, c);
      });
      expect(captured.env).toEqual({ source: "explicit" });
    });

    it("middleware が ALS env を ctx に inject、handler から typed で読める", async () => {
      type MyEnv = { foo: string };
      const inject = defineMiddleware<{ envFoo: string }>(async ({ c, next }) => {
        const env = c.env as MyEnv;
        await next({ ctx: { envFoo: env.foo } });
      });
      const fn = serverFn({
        middleware: [inject],
        handler: async ({ ctx }) => ctx.envFoo,
      });
      await runWithRequestEnv({ foo: "bar" } satisfies MyEnv, async () => {
        const c = createContext({ request: new Request("https://example.com/") });
        expect(await fn.run({}, c)).toBe("bar");
      });
    });
  });

  describe("validator slot (= ADR 0073 論点 5、`validator: { params, data }` で schema parse)", () => {
    // 軽量 mock validator (= zod ZodType 互換 duck)。string 型を期待する schema:
    const stringSchema: ValidatorSlot<string> = {
      safeParse(input) {
        return typeof input === "string"
          ? { success: true, data: input }
          : {
              success: false,
              error: { issues: [{ path: [], message: "expected string" }] },
            };
      },
    };

    it("validator.params が input.params を schema parse、handler に typed で渡る", async () => {
      const slugSchema: ValidatorSlot<{ slug: string }> = {
        safeParse(input) {
          if (typeof input === "object" && input !== null && "slug" in input) {
            const slug = (input as { slug: unknown }).slug;
            if (typeof slug === "string") {
              return { success: true, data: { slug } };
            }
          }
          return {
            success: false,
            error: { issues: [{ path: ["slug"], message: "expected string" }] },
          };
        },
      };
      const fn = serverFn({
        validator: { params: slugSchema },
        handler: async ({ params }) => `slug=${params.slug}`,
      });
      const c = createContext({ request: new Request("https://example.com/") });
      expect(await fn.run({ params: { slug: "abc" } }, c)).toBe("slug=abc");
    });

    it("validator.data が input.data を schema parse、handler に typed で渡る", async () => {
      const titleSchema: ValidatorSlot<{ title: string }> = {
        safeParse(input) {
          if (typeof input === "object" && input !== null && "title" in input) {
            const title = (input as { title: unknown }).title;
            if (typeof title === "string") {
              return { success: true, data: { title } };
            }
          }
          return {
            success: false,
            error: { issues: [{ path: ["title"], message: "expected string" }] },
          };
        },
      };
      const fn = serverFn({
        validator: { data: titleSchema },
        handler: async ({ data }) => `title=${data.title}`,
      });
      const c = createContext({ request: new Request("https://example.com/") });
      expect(await fn.run({ data: { title: "T" } }, c)).toBe("title=T");
    });

    it("validator parse 失敗で 422 + slot=params の Response throw", async () => {
      const fn = serverFn({
        validator: { params: stringSchema },
        handler: async () => "should not reach",
      });
      const c = createContext({ request: new Request("https://example.com/") });
      try {
        await fn.run({ params: 123 as unknown as string }, c);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(Response);
        const res = err as Response;
        expect(res.status).toBe(422);
        const body = await res.json();
        expect(body).toMatchObject({ slot: "params" });
      }
    });

    it("validator parse 失敗で 422 + slot=data の Response throw", async () => {
      const fn = serverFn({
        validator: { data: stringSchema },
        handler: async () => "should not reach",
      });
      const c = createContext({ request: new Request("https://example.com/") });
      try {
        await fn.run({ data: 999 as unknown as string }, c);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(Response);
        const res = err as Response;
        expect(res.status).toBe(422);
        const body = await res.json();
        expect(body).toMatchObject({ slot: "data" });
      }
    });

    it("422 body の `fields` に zod 互換 issues path → message map が入る", async () => {
      const dataSchema: ValidatorSlot<{ title: string; body: string }> = {
        safeParse(_input) {
          return {
            success: false,
            error: {
              issues: [
                { path: ["title"], message: "Required" },
                { path: ["body"], message: "Too short" },
              ],
            },
          };
        },
      };
      const fn = serverFn({
        validator: { data: dataSchema },
        handler: async () => "x",
      });
      const c = createContext({ request: new Request("https://example.com/") });
      try {
        await fn.run({ data: {} as unknown as { title: string; body: string } }, c);
        expect.fail("should have thrown");
      } catch (err) {
        const body = await (err as Response).json();
        expect(body.fields).toEqual({ title: "Required", body: "Too short" });
      }
    });

    it("validator 不在 slot は input をそのまま流す (= no-op)", async () => {
      const fn = serverFn({
        // params に validator なし、data に validator
        validator: { data: stringSchema },
        handler: async ({ params, data }: { params: { raw: number }; data: string }) => ({
          rawParam: params.raw,
          parsedData: data,
        }),
      });
      const c = createContext({ request: new Request("https://example.com/") });
      const result = await fn.run({ params: { raw: 42 }, data: "hi" }, c);
      expect(result).toEqual({ rawParam: 42, parsedData: "hi" });
    });

    it("validator success 後、handler は parsed data を受ける (= 元 input ではなく parsed)", async () => {
      // validator が trim 等の transform を行う case を simulation
      const trimSchema: ValidatorSlot<string> = {
        safeParse(input) {
          if (typeof input === "string") {
            return { success: true, data: input.trim() };
          }
          return {
            success: false,
            error: { issues: [{ path: [], message: "expected string" }] },
          };
        },
      };
      const fn = serverFn({
        validator: { data: trimSchema },
        handler: async ({ data }) => `[${data}]`,
      });
      const c = createContext({ request: new Request("https://example.com/") });
      expect(await fn.run({ data: "  hello  " }, c)).toBe("[hello]");
    });

    it("validator + middleware 併用、validator → middleware → handler の順で適用", async () => {
      const order: string[] = [];
      const log: Middleware = async ({ next }) => {
        order.push("mw");
        await next();
      };
      const tracingSchema: ValidatorSlot<string> = {
        safeParse(input) {
          order.push("validator");
          return { success: true, data: String(input) };
        },
      };
      const fn = serverFn({
        middleware: [log],
        validator: { data: tracingSchema },
        handler: async () => {
          order.push("handler");
          return "ok";
        },
      });
      const c = createContext({ request: new Request("https://example.com/") });
      await fn.run({ data: "x" as unknown as string }, c);
      expect(order).toEqual(["validator", "mw", "handler"]);
    });
  });

  describe("typed signature (= ADR 0073 type vertical propagation)", () => {
    it("handler の params/data 型が serverFn 内で推論される", async () => {
      const fn = serverFn({
        handler: async ({
          params,
          data,
        }: {
          params: { slug: string };
          data: { title: string };
        }) => ({
          slug: params.slug,
          ok: data.title.length > 0,
        }),
      });
      const c = createContext({ request: new Request("https://example.com/") });
      const result = await fn.run({ params: { slug: "post-1" }, data: { title: "Hello" } }, c);
      // result は推論で `{ slug: string; ok: boolean }`
      expect(result.slug).toBe("post-1");
      expect(result.ok).toBe(true);
    });

    it("middleware の Out 型が handler の ctx で intersection 推論される", async () => {
      const mwUser = defineMiddleware<{ user: { id: string } }>(async ({ next }) => {
        await next({ ctx: { user: { id: "u-1" } } });
      });
      const mwReq = defineMiddleware<{ requestId: string }>(async ({ next }) => {
        await next({ ctx: { requestId: "req-1" } });
      });
      const fn = serverFn({
        middleware: [mwUser, mwReq],
        handler: async ({ ctx }) => `${ctx.user.id}-${ctx.requestId}`,
      });
      const c = createContext({ request: new Request("https://example.com/") });
      expect(await fn.run({}, c)).toBe("u-1-req-1");
    });

    it("middleware なしの handler は ctx が空 object 型 (= Record<string, never>)", async () => {
      const fn = serverFn({
        handler: async ({ ctx }) => Object.keys(ctx).length,
      });
      const c = createContext({ request: new Request("https://example.com/") });
      expect(await fn.run({}, c)).toBe(0);
    });
  });
});
