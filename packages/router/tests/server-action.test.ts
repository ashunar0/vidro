// @vitest-environment node
// ADR 0037 Phase 3 R-min: createServerHandler の POST handler (handleAction) の
// 5 分岐をカバー:
//   1. plain value → 200 + {actionResult, loaderData}
//   2. Response 戻り値 → そのまま (= redirect 等)
//   3. action throw → 500 + SerializedError
//   4. server module に action export 不在 → 405
//   5. route match に server module 不在 → 405
import { describe, expect, test } from "vite-plus/test";
import { createServerHandler } from "../src/server";
import type { RouteRecord } from "../src/route-tree";

const noopRoute = () => Promise.resolve({ default: () => null });

describe("createServerHandler — POST handler (ADR 0037 Phase 3 R-min)", () => {
  test("plain value 戻り値: 200 + {actionResult, loaderData} JSON", async () => {
    const manifest: RouteRecord = {
      "/routes/notes/index.tsx": noopRoute,
      "/routes/notes/server.ts": () =>
        Promise.resolve({
          loader: async () => ({ count: 42 }),
          action: async ({ request }: { request: Request }) => {
            const fd = await request.formData();
            return { ok: true, title: String(fd.get("title")) };
          },
        }),
    };
    const handler = createServerHandler({ manifest });

    const fd = new FormData();
    fd.append("title", "Hello");
    const res = await handler(new Request("http://localhost/notes", { method: "POST", body: fd }));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      actionResult: { ok: boolean; title: string };
      loaderData: { params: Record<string, string>; layers: Array<{ data?: unknown }> };
    };
    expect(body.actionResult).toEqual({ ok: true, title: "Hello" });
    // loader 自動 revalidate: 同 path の loader が再実行されて layers に乗る
    expect(body.loaderData.layers.at(-1)?.data).toEqual({ count: 42 });
  });

  test("Response 戻り値はそのまま return (redirect 等の制御を server side で完結)", async () => {
    const manifest: RouteRecord = {
      "/routes/notes/index.tsx": noopRoute,
      "/routes/notes/server.ts": () =>
        Promise.resolve({
          action: async () => new Response(null, { status: 303, headers: { location: "/done" } }),
        }),
    };
    const handler = createServerHandler({ manifest });

    const res = await handler(
      new Request("http://localhost/notes", { method: "POST", body: new FormData() }),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/done");
  });

  test("action throw → 500 + SerializedError JSON", async () => {
    const manifest: RouteRecord = {
      "/routes/notes/index.tsx": noopRoute,
      "/routes/notes/server.ts": () =>
        Promise.resolve({
          action: async () => {
            throw new Error("title is required");
          },
        }),
    };
    const handler = createServerHandler({ manifest });

    const res = await handler(
      new Request("http://localhost/notes", { method: "POST", body: new FormData() }),
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { name: string; message: string } };
    expect(body.error.message).toBe("title is required");
    expect(body.error.name).toBe("Error");
  });

  test("action 不在 (server.ts に export なし) → 405 NoActionError", async () => {
    const manifest: RouteRecord = {
      "/routes/notes/index.tsx": noopRoute,
      "/routes/notes/server.ts": () =>
        Promise.resolve({
          loader: async () => ({}),
          // action 不在
        }),
    };
    const handler = createServerHandler({ manifest });

    const res = await handler(
      new Request("http://localhost/notes", { method: "POST", body: new FormData() }),
    );

    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: { name: string; message: string } };
    expect(body.error.name).toBe("NoActionError");
    expect(body.error.message).toContain("no action");
  });

  test("server module 不在 (server.ts 自体無い route) → 405 NoActionError", async () => {
    const manifest: RouteRecord = {
      "/routes/static/index.tsx": noopRoute,
      // server.ts 不在
    };
    const handler = createServerHandler({ manifest });

    const res = await handler(
      new Request("http://localhost/static", { method: "POST", body: new FormData() }),
    );

    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: { name: string; message: string } };
    expect(body.error.name).toBe("NoActionError");
    expect(body.error.message).toContain("no server module");
  });
});
