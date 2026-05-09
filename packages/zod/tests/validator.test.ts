// ADR 0071 + ADR 0072 unit test: validator(schema) middleware。
//
// 4 観点で確認:
//   1. parsed.data が handler input として override 渡る (= ADR 0072 論点 5-A)
//   2. validation 失敗時に 422 + {fields} Response throw
//   3. body undefined (= 引数なし fn 想定外) も 422 で弾く
//   4. fieldsFromZodError と整合する shape

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createContext, serverFn } from "@vidro/router";
import { validator } from "../src/validator";

describe("validator (ADR 0071 + ADR 0072)", () => {
  const schema = z.object({
    title: z.string().min(1, "title is required"),
    body: z.string().min(1, "body is required"),
  });

  it("success: parsed.data が handler input として渡る", async () => {
    const fn = serverFn(validator(schema), async (input: z.infer<typeof schema>) => {
      return input;
    });
    const c = createContext({ request: new Request("https://example.com/") });
    c.set("body", { title: "hello", body: "world" });
    // dispatch 経由なら fn.run({...}, c) で raw を渡す、validator が next([parsed]) で
    // override するので handler には parsed.data が届く。raw input は ignored、
    // 形式的に渡す (= EnsureTrailingContext で fn.run signature が `(input, c)`)。
    const result = await fn.run({ title: "raw", body: "raw" }, c);
    expect(result).toEqual({ title: "hello", body: "world" });
  });

  it("failure: 422 + {fields} Response throw、handler に到達しない", async () => {
    let handlerCalled = false;
    // handler signature に input 引数を残す (= validator の Out 型と整合させて
    // fn.run の internal form を `(input, c)` の 2 引数にするため、TS variadic
    // tuple 推論が handler signature から Args を取る経路)。実際 handler は
    // 422 throw で到達しないので _input は unused。
    const fn = serverFn(validator(schema), async (_input: z.infer<typeof schema>) => {
      handlerCalled = true;
      return "should not reach";
    });
    const c = createContext({ request: new Request("https://example.com/") });
    // zod 4.x の type error と区別するため空文字列を入れて min(1) check に落とす
    // (= user min message が出るのは string であることが先に通った場合のみ)。
    c.set("body", { title: "", body: "" });
    try {
      await fn.run({ title: "", body: "" }, c);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Response);
      const res = err as Response;
      expect(res.status).toBe(422);
      expect(res.headers.get("content-type")).toContain("application/json");
      const data = (await res.json()) as { fields: Record<string, string> };
      expect(data.fields).toMatchObject({
        title: "title is required",
        body: "body is required",
      });
    }
    expect(handlerCalled).toBe(false);
  });

  it("body undefined (= 引数なし fn 想定外) も 422 で弾く", async () => {
    // ADR 0072 review 60th session: validator は input ある fn 専用前提。
    // bodyArgs.length === 0 で c.var.body が undefined になる経路では
    // schema.safeParse(undefined) が 422 を返す = user に「validator は input
    // ある fn 専用」と明示する error。
    const fn = serverFn(validator(schema), async () => "should not reach");
    const c = createContext({ request: new Request("https://example.com/") });
    // c.var.body 未設定
    try {
      await fn.run(c);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Response);
      expect((err as Response).status).toBe(422);
    }
  });

  it("validator の next([parsed.data]) override 経路 (= 型貫通)", async () => {
    // raw input を fn.run に渡しても、validator が next([parsed]) で override する
    // ので handler が受け取るのは validator の parsed.data。
    const fn = serverFn(validator(schema), async (input: z.infer<typeof schema>) => {
      return `${input.title}-${input.body}`;
    });
    const c = createContext({ request: new Request("https://example.com/") });
    c.set("body", { title: "x", body: "y" });
    // raw は ignored、parsed.data が届く
    expect(await fn.run({ title: "raw", body: "raw" }, c)).toBe("x-y");
  });
});
