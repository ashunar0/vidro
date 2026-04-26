// @vitest-environment node
// Phase B Step B-2c: createServerHandler の navigation 分岐で renderToString
// した markup が `<div id="app">` の中に inject されることの確認 (ADR 0018)。
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

describe("createServerHandler — navigation HTML (Step B-2c)", () => {
  test('layout + index が SSR されて <div id="app"> 内に inject される', async () => {
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
    // SSR markup が <div id="app"> 内に入ってる (B-3b で `<!--router-->` anchor 同梱)
    expect(body).toContain(
      '<div id="app"><div class="root"><h1>Home</h1></div><!--router--></div>',
    );
    // bootstrap data script は B-3 hydration 用に残ってる
    expect(body).toContain('<script type="application/json" id="__vidro_data">');
    // index.html の他の要素は維持される
    expect(body).toContain('<script type="module" src="/src/main.tsx"></script>');
  });
});
