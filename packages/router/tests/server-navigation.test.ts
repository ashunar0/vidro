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
    expect(body).toContain("__vidroSetResources");

    // shell html が #app 内に流れる (B-3b の `<!--router-->` + B-3c-1 の error-boundary anchors)
    expect(body).toContain(
      '<div id="app"><div class="root"><h1>Home</h1><!--error-boundary--></div><!--error-boundary--><!--router-->',
    );

    // resources patch script (Suspense / bootstrapKey resource なしなので空 object)
    expect(body).toContain("__vidroSetResources({})");

    // shell suffix: 元 index.html の </div> 以降が維持される
    expect(body).toContain('</div><script type="module" src="/src/main.tsx"></script></body>');
  });
});
