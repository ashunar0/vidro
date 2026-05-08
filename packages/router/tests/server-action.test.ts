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
            const raw = fd.get("title");
            // typeof narrow で no-base-to-string を回避。test では title=string 前提
            return { ok: true, title: typeof raw === "string" ? raw : "" };
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

  test("ADR 0059: action が throw new Response → そのまま return (validation error 422 等)", async () => {
    const manifest: RouteRecord = {
      "/routes/signup/index.tsx": noopRoute,
      "/routes/signup/server.ts": () =>
        Promise.resolve({
          action: async () => {
            throw new Response(JSON.stringify({ fields: { email: "Invalid" } }), {
              status: 422,
              headers: { "Content-Type": "application/json" },
            });
          },
        }),
    };
    const handler = createServerHandler({ manifest });

    const res = await handler(
      new Request("http://localhost/signup", { method: "POST", body: new FormData() }),
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as { fields: { email: string } };
    expect(body.fields.email).toBe("Invalid");
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
    expect(body.error.message).toContain("no action");
  });

  // ---- ADR 0042: nested action (layout.server.ts に action を export) ----

  test("ADR 0042: leaf に server.ts なし、layout.server.ts に action あり → layout action が呼ばれる", async () => {
    const manifest: RouteRecord = {
      "/routes/users/index.tsx": noopRoute,
      "/routes/users/layout.tsx": noopRoute,
      "/routes/users/layout.server.ts": () =>
        Promise.resolve({
          loader: async () => ({ users: ["a", "b"] }),
          action: async () => ({ ok: "from-layout" }),
        }),
    };
    const handler = createServerHandler({ manifest });

    const res = await handler(
      new Request("http://localhost/users", { method: "POST", body: new FormData() }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      actionResult: { ok: string };
      loaderData: { layers: Array<{ data?: unknown }> };
    };
    expect(body.actionResult).toEqual({ ok: "from-layout" });
    // loader 自動 revalidate も layout の loader を回している
    expect(body.loaderData.layers[0]?.data).toEqual({ users: ["a", "b"] });
  });

  test("ADR 0042: leaf 優先 — leaf と layout の両方に action がある場合は leaf が呼ばれる", async () => {
    const manifest: RouteRecord = {
      "/routes/users/index.tsx": noopRoute,
      "/routes/users/layout.tsx": noopRoute,
      "/routes/users/layout.server.ts": () =>
        Promise.resolve({
          action: async () => ({ from: "layout" }),
        }),
      "/routes/users/server.ts": () =>
        Promise.resolve({
          action: async () => ({ from: "leaf" }),
        }),
    };
    const handler = createServerHandler({ manifest });

    const res = await handler(
      new Request("http://localhost/users", { method: "POST", body: new FormData() }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { actionResult: { from: string } };
    expect(body.actionResult.from).toBe("leaf");
  });

  test("ADR 0042: deepest-first fallback はしない — 親 layout の action は呼ばれない", async () => {
    // /users/[id] へ POST。leaf (server.ts) なし、/users/[id] に layout もなし
    // (= 同 path layout なし)、/users layout には action ありだが、これは異なる
    // pathPrefix なので **呼ばれない**。
    const manifest: RouteRecord = {
      "/routes/users/[id]/index.tsx": noopRoute,
      "/routes/users/layout.tsx": noopRoute,
      "/routes/users/layout.server.ts": () =>
        Promise.resolve({
          action: async () => ({ from: "parent-layout" }),
        }),
    };
    const handler = createServerHandler({ manifest });

    const res = await handler(
      new Request("http://localhost/users/123", { method: "POST", body: new FormData() }),
    );

    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: { name: string; message: string } };
    expect(body.error.name).toBe("NoActionError");
  });

  test("ADR 0042: 動的 segment の layout (例: /users/[id]/layout.server.ts) も完全一致でマッチする", async () => {
    // /users/[id]/layout.server.ts に action を置き、/users/123 への POST で
    // 当該 layout action にフォールバックすることを確認。pathPrefix は "/users/:id"
    // で格納されるため、文字列 strict-equal だと永久に 405 になる回帰を防ぐ。
    const manifest: RouteRecord = {
      "/routes/users/[id]/index.tsx": noopRoute,
      "/routes/users/[id]/layout.tsx": noopRoute,
      "/routes/users/[id]/layout.server.ts": () =>
        Promise.resolve({
          action: async ({ params }: { params: { id: string } }) => ({
            ok: "from-id-layout",
            id: params.id,
          }),
        }),
    };
    const handler = createServerHandler({ manifest });

    const res = await handler(
      new Request("http://localhost/users/123", { method: "POST", body: new FormData() }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { actionResult: { ok: string; id: string } };
    expect(body.actionResult).toEqual({ ok: "from-id-layout", id: "123" });
  });

  test("ADR 0042: root layout (pathPrefix '') の action は POST '/' 時のみ呼ばれる", async () => {
    const manifest: RouteRecord = {
      "/routes/index.tsx": noopRoute,
      "/routes/layout.tsx": noopRoute,
      "/routes/layout.server.ts": () =>
        Promise.resolve({
          action: async () => ({ ok: "from-root-layout" }),
        }),
      "/routes/users/index.tsx": noopRoute,
    };
    const handler = createServerHandler({ manifest });

    // POST `/` → root layout action が呼ばれる
    const resRoot = await handler(
      new Request("http://localhost/", { method: "POST", body: new FormData() }),
    );
    expect(resRoot.status).toBe(200);
    const bodyRoot = (await resRoot.json()) as { actionResult: { ok: string } };
    expect(bodyRoot.actionResult.ok).toBe("from-root-layout");

    // POST `/users` → root layout の action は完全一致しないので 405
    // (= 子 path に root layout の action が leak しないことの保証)
    const resUsers = await handler(
      new Request("http://localhost/users", { method: "POST", body: new FormData() }),
    );
    expect(resUsers.status).toBe(405);
  });

  test("ADR 0042: layout.server.ts が action 不在 (loader のみ) なら 405", async () => {
    const manifest: RouteRecord = {
      "/routes/users/layout.tsx": noopRoute,
      "/routes/users/layout.server.ts": () =>
        Promise.resolve({
          loader: async () => ({ users: [] }),
          // action 不在
        }),
    };
    const handler = createServerHandler({ manifest });

    const res = await handler(
      new Request("http://localhost/users", { method: "POST", body: new FormData() }),
    );

    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: { name: string; message: string } };
    expect(body.error.name).toBe("NoActionError");
  });

  // ---- ADR 0068: index.server.tsx の action export + resource route ----

  test("ADR 0068: index.server.tsx に action export → leaf として拾われる", async () => {
    // server.ts 不在、`.server.tsx` が default (component) と action 両方を export。
    // page と action の co-location 完全形 (痛み点 2 解消)。
    const manifest: RouteRecord = {
      "/routes/posts/new/index.server.tsx": () =>
        Promise.resolve({
          default: () => null,
          action: async ({ request }: { request: Request }) => {
            const fd = await request.formData();
            const raw = fd.get("title");
            return { ok: true, title: typeof raw === "string" ? raw : "" };
          },
        }),
    };
    const handler = createServerHandler({ manifest });

    const fd = new FormData();
    fd.append("title", "From server.tsx");
    const res = await handler(
      new Request("http://localhost/posts/new", { method: "POST", body: fd }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { actionResult: { ok: boolean; title: string } };
    expect(body.actionResult).toEqual({ ok: true, title: "From server.tsx" });
  });

  test("ADR 0068: server.ts 優先 — server.ts と index.server.tsx の両方に action がある場合は server.ts が呼ばれる", async () => {
    // 既存 user 互換: `server.ts` を意図的に置いてる user の action を shadow しない。
    const manifest: RouteRecord = {
      "/routes/posts/new/index.server.tsx": () =>
        Promise.resolve({
          default: () => null,
          action: async () => ({ from: "server.tsx" }),
        }),
      "/routes/posts/new/server.ts": () =>
        Promise.resolve({
          action: async () => ({ from: "server.ts" }),
        }),
    };
    const handler = createServerHandler({ manifest });

    const res = await handler(
      new Request("http://localhost/posts/new", { method: "POST", body: new FormData() }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { actionResult: { from: string } };
    expect(body.actionResult.from).toBe("server.ts");
  });

  test("ADR 0068: index.server.tsx に action 不在なら fallback chain に流れる", async () => {
    // `.server.tsx` は default 出力のみで action 持たず、layout.server.ts の action に
    // fallback する経路。`.server.tsx` の load() が成功するが action 不在で次候補へ。
    const manifest: RouteRecord = {
      "/routes/posts/index.server.tsx": () =>
        Promise.resolve({
          default: () => null,
          // action 不在
        }),
      "/routes/posts/layout.tsx": noopRoute,
      "/routes/posts/layout.server.ts": () =>
        Promise.resolve({
          action: async () => ({ from: "layout" }),
        }),
    };
    const handler = createServerHandler({ manifest });

    const res = await handler(
      new Request("http://localhost/posts", { method: "POST", body: new FormData() }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { actionResult: { from: string } };
    expect(body.actionResult.from).toBe("layout");
  });

  test("ADR 0068: resource route — server.ts 単独 directory (page なし) で POST が action に届く", async () => {
    // /posts/[slug]/delete/server.ts を resource route として登録。同 directory に
    // index.tsx も index.server.tsx も無い (= page を持たない action-only route)。
    // 痛み点 6 解消、REST 自然に path を切れる。
    const manifest: RouteRecord = {
      "/routes/posts/[slug]/index.tsx": noopRoute,
      "/routes/posts/[slug]/delete/server.ts": () =>
        Promise.resolve({
          action: async ({ params }: { params: { slug: string } }) => ({
            deleted: params.slug,
          }),
        }),
    };
    const handler = createServerHandler({ manifest });

    const res = await handler(
      new Request("http://localhost/posts/foo/delete", {
        method: "POST",
        body: new FormData(),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { actionResult: { deleted: string } };
    expect(body.actionResult).toEqual({ deleted: "foo" });
  });

  test("ADR 0068: resource route GET は 404 (= 既存 not-found fallback、本 ADR で挙動変えない)", async () => {
    const manifest: RouteRecord = {
      "/routes/posts/[slug]/delete/server.ts": () =>
        Promise.resolve({
          action: async () => ({ ok: true }),
        }),
    };
    const handler = createServerHandler({ manifest });

    // GET resource route → 既存 path で route 不在として 404
    const res = await handler(
      new Request("http://localhost/posts/foo/delete", {
        method: "GET",
        headers: { accept: "*/*" },
      }),
    );

    expect(res.status).toBe(404);
  });

  test("ADR 0068: resource route で action 不在なら 405 (resource server.ts に loader のみ)", async () => {
    const manifest: RouteRecord = {
      "/routes/posts/[slug]/delete/server.ts": () =>
        Promise.resolve({
          loader: async () => ({}),
          // action 不在
        }),
    };
    const handler = createServerHandler({ manifest });

    const res = await handler(
      new Request("http://localhost/posts/foo/delete", {
        method: "POST",
        body: new FormData(),
      }),
    );

    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: { name: string; message: string } };
    expect(body.error.name).toBe("NoActionError");
  });
});
