// @vitest-environment jsdom
// Phase B Step B-3d: Router を hydrate 経路で起動した時、SSR で焼かれた既存
// markup を再利用する (DOM Node identity が保たれる) ことの確認 (ADR 0027)。
//
// 流れ:
//   1. document.body に bootstrap script + 空 #app を仕込む
//   2. router module を **dynamic import** で初めて load → readBootstrapData()
//      が module-level state に格納される
//   3. Router を server mode (`ssr` prop) で renderToString → 既存 markup として
//      #app に流す
//   4. eagerModules + 同じ manifest で hydrate → 1 度組んだ DOM Node を再利用
//      しているか identity で確認

import { describe, expect, test } from "vite-plus/test";
import { h, hydrate, _$text, _$dynamicChild } from "@vidro/core";
import { renderToString } from "@vidro/core/server";
import type { RouteRecord } from "../src/route-tree";

describe("Router hydrate (eagerModules + bootstrapData 経路)", () => {
  test("SSR markup を再利用して hydrate される (Node identity 維持)", async () => {
    // plugin transform 経由ではなく vanilla h() で書くため、handwritten で
    // post-order を保つよう `_$text` / `_$dynamicChild` を明示する
    // (HydrationRenderer の cursor 順と整合させるため、ADR 0019)。
    const IndexPage = () => h("h1", null, _$text("Home"));
    const RootLayout = (props: { children: unknown }) =>
      h(
        "div",
        { class: "root" },
        _$dynamicChild(() => props.children),
      );

    const manifest: RouteRecord = {
      "/routes/index.tsx": () => Promise.resolve({ default: IndexPage }),
      "/routes/layout.tsx": () => Promise.resolve({ default: RootLayout }),
    };
    const eagerModules = {
      "/routes/index.tsx": { default: IndexPage },
      "/routes/layout.tsx": { default: RootLayout },
    };

    const pathname = "/";
    const bootstrap = {
      params: {},
      layers: [{ data: undefined }, { data: undefined }],
    };

    // 1. document setup: bootstrap data を埋める。Router module が load された
    //    時点で readBootstrapData() が動くので、この順序が重要。
    history.replaceState(null, "", pathname);
    document.body.innerHTML = `
      <script type="application/json" id="__vidro_data">${JSON.stringify(bootstrap)}</script>
      <div id="app"></div>
    `;

    // 2. router module を初めて load (この瞬間に bootstrapData が読まれる)
    const { Router } = await import("../src/router");
    const { preloadRouteComponents } = await import("../src/server");

    // 3. server-mode で SSR HTML を作って #app に流す
    const resolvedModules = await preloadRouteComponents(manifest, pathname);
    const ssrHtml = renderToString(() =>
      Router({
        routes: manifest,
        ssr: {
          bootstrapData: { pathname, params: {}, layers: bootstrap.layers },
          resolvedModules,
        },
      }),
    );
    const appRoot = document.getElementById("app") as HTMLDivElement;
    appRoot.innerHTML = ssrHtml;

    // hydrate 前の DOM Node を捕まえる (identity 比較用)
    const divBefore = appRoot.firstChild as HTMLElement;
    const h1Before = divBefore.firstChild as HTMLElement;

    // 4. hydrate: eagerModules + bootstrapData で sync fold が走り、cursor が
    //    SSR markup と整合して既存 Node を再利用するはず。
    hydrate(() => Router({ routes: manifest, eagerModules }), appRoot);

    // 同じ Node が再利用されている (mount だと innerHTML が捨てられて新規 Node)
    expect(appRoot.firstChild).toBe(divBefore);
    expect(divBefore.firstChild).toBe(h1Before);
    expect(divBefore.outerHTML).toBe('<div class="root"><h1>Home</h1><!--error-boundary--></div>');
  });
});
