import type { Plugin } from "vite";
import { jsxTransform } from "./jsx-transform";
import { routeTypes, type RouteTypesOptions } from "./route-types";
import { serverBoundary, type ServerBoundaryOptions } from "./server-boundary";

// `vidro()` は @vidro/plugin の主役 entry。
// user の vite.config.ts を `plugins: [vidro()]` の 1 行で済ませるための束ね。
//
// React/Solid 流儀の「FW plugin 1 個」を踏襲：
//   - jsxTransform は常に入る (Vidro core を使う以上必須)
//   - router=true で routeTypes + serverBoundary を追加 (opt-in)
//
// CSR-only:        plugins: [vidro()]
// router + SSR:    plugins: [cloudflare({ ... }), vidro({ router: true })]
//
// 型は `vite` から直接 import する (vite-plus 経由ではない)。vite-plus 0.1.x が
// 内部に bundle した vite が複数バージョン同居する pnpm 解決で、`vite-plus.Plugin`
// が path 違いの別型扱いになり、`PluginOption` の recursion check で TS の
// "Excessive stack depth" を起こすため。`@cloudflare/vite-plugin` も `vite.Plugin[]`
// を返している (single source of truth)。vite-plus が stable に入ったら見直し可。

export type VidroOptions = {
  /**
   * `@vidro/router` を使う場合 true。routeTypes + serverBoundary が plugin chain
   * に追加される。advanced 設定が要る場合は object を渡す。
   */
  router?: boolean | (RouteTypesOptions & ServerBoundaryOptions);
};

export function vidro(options: VidroOptions = {}): Plugin[] {
  const plugins: Plugin[] = [jsxTransform()];

  if (options.router) {
    const routerOpts = typeof options.router === "object" ? options.router : {};
    plugins.push(routeTypes(routerOpts));
    plugins.push(serverBoundary(routerOpts));
  }

  return plugins;
}
