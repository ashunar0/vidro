// @vitest-environment node
// Phase B-2c → Phase C streaming SSR (ADR 0018, 0031): createServerHandler の
// navigation response が streaming 形式 (shell + tail) で組み立てられることの確認。
//   - shell prefix の <head> に bootstrap script + inline runtime が inject される
//   - shell html (Router render 結果) が #app 内に流れる
//   - resources patch script が boundary fill の前に出る
//   - shell suffix (#app 閉じ + 既存 body 末尾) が維持される
import { describe, expect, test } from "vite-plus/test";
import { h } from "@vidro/core";
import { createServerHandler } from "../src/server";
import type { RouteRecord } from "../src/route-tree";

const indexHTML = `<!doctype html>
<html><head><title>t</title></head>
<body><div id="app"></div><script type="module" src="/src/main.tsx"></script></body>
</html>`;

const fakeAssets = (html: string) => ({
  async fetch() {
    return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  },
});

describe("createServerHandler — navigation HTML (Phase C streaming SSR)", () => {
  test("layout + index が #app 内 shell として streaming response に流れる", async () => {
    const manifest: RouteRecord = {
      "/routes/index.tsx": () => Promise.resolve({ default: () => h("h1", null, "Home") }),
      "/routes/layout.tsx": () =>
        Promise.resolve({
          default: (props: { children: unknown }) => h("div", { class: "root" }, props.children),
        }),
    };

    const handler = createServerHandler({ manifest });
    const res = await handler(
      new Request("http://localhost/", { headers: { accept: "text/html" } }),
      { assets: fakeAssets(indexHTML) },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();

    // bootstrap data script + inline runtime が `</head>` 前に inject されてる
    expect(body).toContain('<script type="application/json" id="__vidro_data">');
    expect(body).toContain("__vidroFill");
    expect(body).toContain("__vidroAddResources");

    // shell html が #app 内に流れる (B-3b の `<!--router-->` + B-3c-1 の error-boundary anchors)
    expect(body).toContain(
      '<div id="app"><div class="root"><h1>Home</h1><!--error-boundary--></div><!--error-boundary--><!--router-->',
    );

    // root pseudo-boundary patch (ADR 0033 論点 9): Suspense / bootstrapKey resource
    // どちらも無いので、ランタイム inline 以外で __vidroAddResources(...) は呼ばれない
    // (空 object の no-op patch は ADR 0033 で省略する仕様)
    expect(body).not.toContain("__vidroAddResources({");

    // shell suffix: 元 index.html の </div> 以降が維持される
    expect(body).toContain('</div><script type="module" src="/src/main.tsx"></script></body>');
  });
});

// ADR 0061: /__partial endpoint (server-only page SPA navigation)
describe("createServerHandler — /__partial endpoint (ADR 0061)", () => {
  test("from が無いと 400 (E-α: from は必須)", async () => {
    const manifest: RouteRecord = {
      "/routes/index.tsx": () => Promise.resolve({ default: () => h("h1", null, "Home") }),
    };
    const handler = createServerHandler({ manifest });
    const res = await handler(new Request("http://localhost/__partial?to=%2F"));
    expect(res.status).toBe(400);
  });

  test("to が無いと 400", async () => {
    const manifest: RouteRecord = {
      "/routes/index.tsx": () => Promise.resolve({ default: () => h("h1", null, "Home") }),
    };
    const handler = createServerHandler({ manifest });
    const res = await handler(new Request("http://localhost/__partial?from=%2F"));
    expect(res.status).toBe(400);
  });

  test("通常 partial 経路で 200 + partial HTML + X-Vidro-Diverge-Index header", async () => {
    // posts/[id]/index.tsx を leaf に持つ manifest で、/posts/1 → /posts/2 を partial で取る
    const manifest: RouteRecord = {
      "/routes/index.tsx": () => Promise.resolve({ default: () => h("h1", null, "Home") }),
      "/routes/posts/[id]/index.tsx": () =>
        Promise.resolve({
          default: (props: { params: Record<string, string> }) =>
            h("article", null, `Post ${props.params.id}`),
        }),
    };
    const handler = createServerHandler({ manifest });
    const res = await handler(
      new Request("http://localhost/__partial?to=%2Fposts%2F2&from=%2Fposts%2F1"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    // /posts/* に layout 無いので共通 prefix 0 → divergeIndex = 0
    expect(res.headers.get("x-vidro-diverge-index")).toBe("0");
    const body = await res.text();
    expect(body).toContain("<article>Post 2</article>");
  });

  test("invalid scheme (javascript:) は 400", async () => {
    const manifest: RouteRecord = {
      "/routes/index.tsx": () => Promise.resolve({ default: () => h("h1", null, "Home") }),
    };
    const handler = createServerHandler({ manifest });
    const res = await handler(
      new Request(
        `http://localhost/__partial?to=${encodeURIComponent("javascript:alert(1)")}&from=%2F`,
      ),
    );
    expect(res.status).toBe(400);
  });
});
