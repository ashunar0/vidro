// @vitest-environment node
// ADR 0053: loader が `request: Request` を受ける経路の test。LoaderArgs と
// ActionArgs の shape 対称化により、loader 内で `new URL(request.url).searchParams`
// 等で URL 由来 server-side state を読める。
//
// 検証点:
//   1. /__loader?path=... endpoint で、loader が受ける request.url は **route 自身の
//      URL** (例: "/notes?q=Vidro&page=2") に偽装される (Open Question 2)
//   2. navigation 経路 (HTML response) でも loader が request.url から query を読める
//   3. POST 後 loader 自動 revalidate でも loader が request.url から query を読める
import { describe, expect, test } from "vite-plus/test";
import { createServerHandler } from "../src/server";
import type { RouteRecord } from "../src/route-tree";

const noopRoute = () => Promise.resolve({ default: () => null });

describe("createServerHandler — loader が request を受ける (ADR 0053)", () => {
  test("/__loader endpoint: loader.request.url は route URL に偽装される (path + query 込み)", async () => {
    let receivedUrl: string | null = null;
    const manifest: RouteRecord = {
      "/routes/notes/index.tsx": noopRoute,
      "/routes/notes/server.ts": () =>
        Promise.resolve({
          loader: async ({ request }: { request: Request }) => {
            receivedUrl = request.url;
            const url = new URL(request.url);
            return {
              page: Number(url.searchParams.get("page") ?? "1"),
              q: url.searchParams.get("q"),
            };
          },
        }),
    };
    const handler = createServerHandler({ manifest });

    // dev `/__loader?path=...` 経由でも、loader からは「自分の URL に直接 GET された」
    // ように見える。`/__loader?...` の文字列は user の loader に晒されない。
    const res = await handler(
      new Request("http://localhost/__loader?path=" + encodeURIComponent("/notes?q=Vidro&page=2")),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      params: Record<string, string>;
      layers: Array<{ data?: { page: number; q: string | null } }>;
    };
    expect(body.layers.at(-1)?.data).toEqual({ page: 2, q: "Vidro" });
    // 偽装後の URL は origin + path + search (= /notes?q=Vidro&page=2)
    expect(receivedUrl).toBe("http://localhost/notes?q=Vidro&page=2");
  });

  test("/__loader endpoint: headers (cookie / accept-language 等) は original request から forward される", async () => {
    let receivedHeaders: Record<string, string> = {};
    const manifest: RouteRecord = {
      "/routes/notes/index.tsx": noopRoute,
      "/routes/notes/server.ts": () =>
        Promise.resolve({
          loader: async ({ request }: { request: Request }) => {
            receivedHeaders = Object.fromEntries(request.headers);
            return {};
          },
        }),
    };
    const handler = createServerHandler({ manifest });

    await handler(
      new Request("http://localhost/__loader?path=/notes", {
        headers: { cookie: "sid=abc", "accept-language": "ja" },
      }),
    );

    expect(receivedHeaders.cookie).toBe("sid=abc");
    expect(receivedHeaders["accept-language"]).toBe("ja");
  });

  test("POST → loader 自動 revalidate: loader.request.url は POST 先 URL を保つ", async () => {
    let receivedUrl: string | null = null;
    const manifest: RouteRecord = {
      "/routes/notes/index.tsx": noopRoute,
      "/routes/notes/server.ts": () =>
        Promise.resolve({
          loader: async ({ request }: { request: Request }) => {
            receivedUrl = request.url;
            const url = new URL(request.url);
            return { q: url.searchParams.get("q") };
          },
          action: async () => ({ ok: true }),
        }),
    };
    const handler = createServerHandler({ manifest });

    // POST `/notes?q=Vidro` → action 完了後 loader 自動 revalidate でも
    // 同 URL (search 含む) で loader を呼ぶ
    const res = await handler(
      new Request("http://localhost/notes?q=Vidro", {
        method: "POST",
        body: new FormData(),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      actionResult: { ok: boolean };
      loaderData: { layers: Array<{ data?: { q: string | null } }> };
    };
    expect(body.actionResult).toEqual({ ok: true });
    expect(body.loaderData.layers.at(-1)?.data).toEqual({ q: "Vidro" });
    expect(receivedUrl).toBe("http://localhost/notes?q=Vidro");
  });

  test("path に non-http scheme (= javascript:, data: 等) が来たら 400 で弾く", async () => {
    // reviewer Issue (a): `new URL("javascript:...", base)` は base を無視して
    // non-http URL を返すので、そのまま new Request に渡すと TypeError throw +
    // unhandled 500 になる。clean な 400 を返すのが筋。
    const manifest: RouteRecord = {
      "/routes/notes/index.tsx": noopRoute,
      "/routes/notes/server.ts": () =>
        Promise.resolve({
          loader: async () => ({ ok: true }),
        }),
    };
    const handler = createServerHandler({ manifest });
    const res = await handler(
      new Request("http://localhost/__loader?path=" + encodeURIComponent("javascript:alert(1)")),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("scheme");
  });

  test("引数を取らない loader (`async () => ({...})`) も互換 (関数 contravariance)", async () => {
    // 既存 fixture が `loader: async () => (...)` 形式で書かれていても、
    // ADR 0053 の signature 拡張で破綻しないことを compile + runtime で確認。
    const manifest: RouteRecord = {
      "/routes/notes/index.tsx": noopRoute,
      "/routes/notes/server.ts": () =>
        Promise.resolve({
          loader: async () => ({ count: 42 }),
        }),
    };
    const handler = createServerHandler({ manifest });
    const res = await handler(new Request("http://localhost/__loader?path=/notes"));
    const body = (await res.json()) as { layers: Array<{ data?: { count: number } }> };
    expect(body.layers.at(-1)?.data).toEqual({ count: 42 });
  });
});
