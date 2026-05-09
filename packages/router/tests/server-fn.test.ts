// ADR 0070 Phase 1 + ADR 0072 unit test: serverFn() factory + Hono c subset context.
//
// internal form (= context を末尾必須で受ける、ADR 0072 論点 3-A) を test する。
// Phase 2 で bundler が wrap して位置引数のみの public form になるが、本 test は
// core 機構 (= middleware chain / context API / 位置引数 / 早期 return / next()
// override) を確認する。

import { describe, expect, it } from "vitest";
import {
  type Context,
  createContext,
  type ExecutionContext,
  type Middleware,
  serverFn,
} from "../src/server-fn";
import { runWithRequestEnv } from "../src/request-env-scope";

describe("serverFn (ADR 0070 Phase 1 + ADR 0072)", () => {
  describe("基本動作", () => {
    it("middleware なしで handler を呼べる", async () => {
      const fn = serverFn(async (name: string) => `hello ${name}`);
      const c = createContext({ request: new Request("https://example.com/") });
      const result = await fn.run("world", c);
      expect(result).toBe("hello world");
    });

    it("位置引数を複数渡せる (= ADR 0070 論点 7 dynamic param + body)", async () => {
      const fn = serverFn(async (slug: string, input: { title: string }) => ({
        slug,
        title: input.title,
      }));
      const c = createContext({ request: new Request("https://example.com/") });
      const result = await fn.run("abc", { title: "T" }, c);
      expect(result).toEqual({ slug: "abc", title: "T" });
    });

    it("handler 戻り値が serverFn の戻り値になる", async () => {
      const fn = serverFn(async () => 42);
      const c = createContext({ request: new Request("https://example.com/") });
      expect(await fn.run(c)).toBe(42);
    });

    it("sync handler でも動く (= async でなくても OK)", async () => {
      const fn = serverFn(() => "sync");
      const c = createContext({ request: new Request("https://example.com/") });
      expect(await fn.run(c)).toBe("sync");
    });
  });

  describe("middleware chain (= onion model)", () => {
    it("middleware → handler の順で実行される", async () => {
      const order: string[] = [];
      const mw: Middleware = async (_c, next) => {
        order.push("mw before");
        await next();
        order.push("mw after");
      };
      const fn = serverFn(mw, async () => {
        order.push("handler");
        return "ok";
      });
      const c = createContext({ request: new Request("https://example.com/") });
      const result = await fn.run(c);
      expect(result).toBe("ok");
      expect(order).toEqual(["mw before", "handler", "mw after"]);
    });

    it("複数 middleware を chain できる (= onion model)", async () => {
      const order: string[] = [];
      const mw1: Middleware = async (_c, next) => {
        order.push("mw1 before");
        await next();
        order.push("mw1 after");
      };
      const mw2: Middleware = async (_c, next) => {
        order.push("mw2 before");
        await next();
        order.push("mw2 after");
      };
      const fn = serverFn(mw1, mw2, async () => {
        order.push("handler");
      });
      const c = createContext({ request: new Request("https://example.com/") });
      await fn.run(c);
      expect(order).toEqual(["mw1 before", "mw2 before", "handler", "mw2 after", "mw1 after"]);
    });

    it("middleware が c.set した値を後段で c.get できる", async () => {
      const auth: Middleware = async (c, next) => {
        c.set("user", { id: "u1" });
        await next();
      };
      const fn = serverFn(auth, async (c: Context) => c.get<{ id: string }>("user")?.id);
      const c = createContext({ request: new Request("https://example.com/") });
      expect(await fn.run(c)).toBe("u1");
    });

    it("c.var でも middleware set 値が引ける (= Hono と同形)", async () => {
      const auth: Middleware = async (c, next) => {
        c.set("flag", true);
        await next();
      };
      const fn = serverFn(auth, async (c: Context) => c.var.flag);
      const c = createContext({ request: new Request("https://example.com/") });
      expect(await fn.run(c)).toBe(true);
    });

    it("middleware が次段で c.set した値を after で読める (= 両方向値伝播)", async () => {
      const order: string[] = [];
      const recorder: Middleware = async (c, next) => {
        await next();
        order.push(`after: ${String(c.get("trace"))}`);
      };
      const setter: Middleware = async (c, next) => {
        c.set("trace", "from setter");
        await next();
      };
      const fn = serverFn(recorder, setter, async () => "ok");
      const c = createContext({ request: new Request("https://example.com/") });
      await fn.run(c);
      expect(order).toEqual(["after: from setter"]);
    });
  });

  describe("早期 return (= auth fail / 422 等)", () => {
    it("middleware が next() を呼ばずに Response 返すと throw される", async () => {
      const denyAll: Middleware = async () => new Response("forbidden", { status: 403 });
      const fn = serverFn(denyAll, async () => "should not reach");
      const c = createContext({ request: new Request("https://example.com/") });
      await expect(fn.run(c)).rejects.toBeInstanceOf(Response);
    });

    it("早期 return された Response の status を確認できる", async () => {
      const denyAll: Middleware = async () => new Response("forbidden", { status: 403 });
      const fn = serverFn(denyAll, async () => "x");
      const c = createContext({ request: new Request("https://example.com/") });
      try {
        await fn.run(c);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(Response);
        expect((err as Response).status).toBe(403);
      }
    });

    it("middleware が next() も Response も返さないと error", async () => {
      // biome-ignore lint/suspicious/useAwait: 意図的に next を呼ばない broken middleware
      const broken: Middleware = async () => {
        // do nothing — 設計違反、明示的 error メッセージで通知
      };
      const fn = serverFn(broken, async () => "x");
      const c = createContext({ request: new Request("https://example.com/") });
      await expect(fn.run(c)).rejects.toThrow(/did not call next/);
    });

    it("middleware が next() を 2 回呼ぶと error", async () => {
      const buggy: Middleware = async (_c, next) => {
        await next();
        await next();
      };
      const fn = serverFn(buggy, async () => "x");
      const c = createContext({ request: new Request("https://example.com/") });
      await expect(fn.run(c)).rejects.toThrow(/multiple times/);
    });

    it("途中の middleware で短絡すると後続 handler は呼ばれない", async () => {
      let handlerCalled = false;
      const auth: Middleware = async () => new Response("nope", { status: 401 });
      const fn = serverFn(auth, async () => {
        handlerCalled = true;
        return "x";
      });
      const c = createContext({ request: new Request("https://example.com/") });
      await expect(fn.run(c)).rejects.toBeInstanceOf(Response);
      expect(handlerCalled).toBe(false);
    });

    it("middleware が next() 後に Response 返しても handler 戻り値を優先 (= Hono 同形)", async () => {
      // next() 呼んだ後の Response 戻り値は無視する (= chain semantics 維持)。
      // 早期 return は next() を呼ばないことで明示する設計。
      const wrap: Middleware = async (_c, next) => {
        await next();
        return new Response("ignored", { status: 200 });
      };
      const fn = serverFn(wrap, async () => "handler-result");
      const c = createContext({ request: new Request("https://example.com/") });
      expect(await fn.run(c)).toBe("handler-result");
    });
  });

  describe("context (= Hono c subset、handler が c を末尾必須で受ける case)", () => {
    it("c.req.url と c.req.headers が引ける", async () => {
      const fn = serverFn(async (c: Context) => ({
        url: c.req.url,
        accept: c.req.headers.get("accept"),
      }));
      const c = createContext({
        request: new Request("https://example.com/foo", {
          headers: { accept: "application/json" },
        }),
      });
      const result = await fn.run(c);
      expect(result.url).toBe("https://example.com/foo");
      expect(result.accept).toBe("application/json");
    });

    it("c.req.query で URL query 取得", async () => {
      const fn = serverFn(async (c: Context) => c.req.query("q"));
      const c = createContext({
        request: new Request("https://example.com/?q=hello"),
      });
      expect(await fn.run(c)).toBe("hello");
    });

    it("c.req.query 未指定 key は undefined", async () => {
      const fn = serverFn(async (c: Context) => c.req.query("missing"));
      const c = createContext({ request: new Request("https://example.com/") });
      expect(await fn.run(c)).toBeUndefined();
    });

    it("c.env が引数で渡された env と一致する", async () => {
      type MyEnv = { DB: string; API_KEY: string };
      const fn = serverFn(async (c: Context) => c.env as MyEnv);
      const env: MyEnv = { DB: "fake-d1", API_KEY: "secret" };
      const c = createContext({
        request: new Request("https://example.com/"),
        env,
      });
      expect(await fn.run(c)).toEqual(env);
    });

    it("env 未指定 + ALS scope 外なら c.env は undefined", async () => {
      const fn = serverFn(async (c: Context) => c.env);
      const c = createContext({ request: new Request("https://example.com/") });
      expect(await fn.run(c)).toBeUndefined();
    });

    it("c.executionCtx.waitUntil() が動く", async () => {
      const calls: Promise<unknown>[] = [];
      const ctx: ExecutionContext = {
        waitUntil(p) {
          calls.push(p);
        },
        passThroughOnException() {
          // noop for test
        },
      };
      const fn = serverFn(async (c: Context) => {
        c.executionCtx?.waitUntil(Promise.resolve("bg-task"));
      });
      const c = createContext({
        request: new Request("https://example.com/"),
        executionCtx: ctx,
      });
      await fn.run(c);
      expect(calls.length).toBe(1);
    });
  });

  describe("ALS scope と統合 (= getRequestEnv 互換)", () => {
    it("ALS scope active なら c.env は ALS env になる", async () => {
      type MyEnv = { source: "als" };
      const fn = serverFn(async (c: Context) => c.env as MyEnv);
      await runWithRequestEnv({ source: "als" } satisfies MyEnv, async () => {
        const c = createContext({ request: new Request("https://example.com/") });
        const result = await fn.run(c);
        expect(result).toEqual({ source: "als" });
      });
    });

    it("引数 env が ALS scope より優先される", async () => {
      const fn = serverFn(async (c: Context) => c.env);
      await runWithRequestEnv({ source: "als" }, async () => {
        const c = createContext({
          request: new Request("https://example.com/"),
          env: { source: "explicit" },
        });
        const result = await fn.run(c);
        expect(result).toEqual({ source: "explicit" });
      });
    });

    it("ALS scope 内で middleware も ALS env を c.env で読める (= async 越し)", async () => {
      type MyEnv = { foo: string };
      const inspectMw: Middleware = async (c, next) => {
        c.set("envFoo", (c.env as MyEnv).foo);
        await next();
      };
      const fn = serverFn(inspectMw, async (c: Context) => c.get<string>("envFoo"));
      await runWithRequestEnv({ foo: "bar" } satisfies MyEnv, async () => {
        const c = createContext({ request: new Request("https://example.com/") });
        expect(await fn.run(c)).toBe("bar");
      });
    });
  });

  describe("typed signature (= ADR 0070 論点 7 + ADR 0072 論点 1-C)", () => {
    it("handler の引数型が serverFn の戻り value 関数で推論される", async () => {
      // 型 check 用 (= compile time)、runtime も問題ないことを確認
      const fn = serverFn(async (slug: string, input: { title: string }) => ({
        slug,
        ok: input.title.length > 0,
      }));
      const c = createContext({ request: new Request("https://example.com/") });
      const result = await fn.run("post-1", { title: "Hello" }, c);
      // result は推論で `{ slug: string; ok: boolean }`
      expect(result.slug).toBe("post-1");
      expect(result.ok).toBe(true);
    });

    it("middleware を rest で渡しても handler 型が末尾で取れる", async () => {
      const noopMw: Middleware = async (_c, next) => {
        await next();
      };
      const fn = serverFn(noopMw, noopMw, async (n: number) => n * 2);
      const c = createContext({ request: new Request("https://example.com/") });
      expect(await fn.run(21, c)).toBe(42);
    });

    it("handler が c を末尾 optional で受け取れる (= edge case 経路)", async () => {
      const fn = serverFn(async (n: number, c: Context) => `${n}-${c.req.url}`);
      const c = createContext({ request: new Request("https://example.com/foo") });
      expect(await fn.run(7, c)).toBe("7-https://example.com/foo");
    });
  });

  describe("next() override (= ADR 0072 論点 5-A、validator middleware が typed input を渡す経路)", () => {
    it("middleware が next([newInput]) で次段の args を override できる", async () => {
      // validator middleware の simulation: c.var.body から取って parse、handler に
      // typed input として渡す。
      const validate: Middleware = async (c, next) => {
        const body = c.var.body as { title?: string } | undefined;
        if (!body || typeof body.title !== "string") {
          throw new Error("validation failed");
        }
        const parsed = { title: body.title.trim() };
        await next([parsed]);
      };
      const fn = serverFn(validate, async (input: { title: string }) => `got: ${input.title}`);
      const c = createContext({ request: new Request("https://example.com/") });
      c.set("body", { title: "  hello  " });
      // validator が next([parsed]) で input override する経路の test。型上は input
      // 必須 (= EnsureTrailingContext で `(input, c) => R`) なので形式的に dummy 渡し、
      // 実際に handler に届くのは validator の override 値 (= "hello" trim 済)。
      expect(await fn.run({ title: "ignored" }, c)).toBe("got: hello");
    });

    it("middleware が next() を引数なしで呼ぶと前段の args が継承される", async () => {
      const noop: Middleware = async (_c, next) => {
        await next();
      };
      const fn = serverFn(noop, async (input: { x: number }) => input.x * 2);
      const c = createContext({ request: new Request("https://example.com/") });
      expect(await fn.run({ x: 21 }, c)).toBe(42);
    });

    it("複数 middleware の override が連鎖する (= validator → enrich → handler)", async () => {
      const validate: Middleware = async (_c, next) => {
        // 元 args に typed value を inject
        await next([{ value: 100 }]);
      };
      const enrich: Middleware = async (_c, next) => {
        // 前段の override をさらに変形
        await next([{ value: 200 }]);
      };
      const fn = serverFn(validate, enrich, async (input: { value: number }) => input.value);
      const c = createContext({ request: new Request("https://example.com/") });
      // 元 args は { value: 1 } だが validate → enrich で override されて 200
      expect(await fn.run({ value: 1 }, c)).toBe(200);
    });
  });
});
