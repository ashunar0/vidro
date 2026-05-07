// @vitest-environment node
// `getRequestEnv<T>()` の test。`createServerHandler` が ctx.env で受け取った値を
// per-request scope に立てて、loader / action / 等の handler 内 (= 同じ async tree)
// から `getRequestEnv()` で型付きで取れることを検証する。
//
// 検証点:
//   1. loader 内から getRequestEnv() で env を取得できる (sync 経路)
//   2. async loader (= await を跨いだ continuation) でも同じ env が引ける (= ALS 経由)
//   3. ctx.env 未指定の場合 getRequestEnv は throw する (fail-fast、scope 外 protect)
//   4. handler の外で呼ぶと throw する

import { describe, expect, test } from "vite-plus/test";
import { createServerHandler, getRequestEnv } from "../src/server";
import type { RouteRecord } from "../src/route-tree";

const noopRoute = () => Promise.resolve({ default: () => null });

describe("getRequestEnv (Vidro env helper)", () => {
  test("loader 内から getRequestEnv() で env が取れる (sync 経路)", async () => {
    let received: unknown = null;
    const manifest: RouteRecord = {
      "/routes/index.tsx": noopRoute,
      "/routes/server.ts": () =>
        Promise.resolve({
          loader: async () => {
            received = getRequestEnv<{ DB: string }>();
            return {};
          },
        }),
    };
    const handler = createServerHandler({ manifest });
    const env = { DB: "fake-d1" };
    await handler(new Request("http://localhost/__loader?path=/"), { env });
    expect(received).toEqual({ DB: "fake-d1" });
  });

  test("async loader: await を跨いだ continuation でも同じ env が引ける (= ALS 経由)", async () => {
    let envBeforeAwait: unknown = null;
    let envAfterAwait: unknown = null;
    const manifest: RouteRecord = {
      "/routes/index.tsx": noopRoute,
      "/routes/server.ts": () =>
        Promise.resolve({
          loader: async () => {
            envBeforeAwait = getRequestEnv<{ DB: string }>();
            await Promise.resolve();
            // ADR 0065 で scope-context が ALS 化済なので continuation でも引ける
            envAfterAwait = getRequestEnv<{ DB: string }>();
            return {};
          },
        }),
    };
    const handler = createServerHandler({ manifest });
    const env = { DB: "fake-d1" };
    await handler(new Request("http://localhost/__loader?path=/"), { env });
    expect(envBeforeAwait).toEqual({ DB: "fake-d1" });
    expect(envAfterAwait).toEqual({ DB: "fake-d1" });
  });

  test("ctx.env 未指定で loader 内 getRequestEnv() を呼ぶと throw する", async () => {
    let caught: unknown = null;
    const manifest: RouteRecord = {
      "/routes/index.tsx": noopRoute,
      "/routes/server.ts": () =>
        Promise.resolve({
          loader: async () => {
            try {
              getRequestEnv();
            } catch (err) {
              caught = err;
            }
            return {};
          },
        }),
    };
    const handler = createServerHandler({ manifest });
    // ctx.env を渡さない (= server entry が `env` を passing し忘れた状況の simulate)
    await handler(new Request("http://localhost/__loader?path=/"));
    expect(caught).not.toBeNull();
    expect((caught as Error).message).toContain("outside of request scope");
  });

  test("handler の外で getRequestEnv() を呼ぶと throw する", () => {
    expect(() => getRequestEnv()).toThrow(/outside of request scope/);
  });
});
