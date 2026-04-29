import { defineConfig } from "vite-plus";
import { cloudflare } from "@cloudflare/vite-plugin";
import { jsxTransform, routeTypes, serverBoundary } from "@vidro/plugin";

// @cloudflare/vite-plugin: vp dev 中に workerd を in-process で起動し、
// wrangler.toml の main (.vidro/server-entry.ts) を SSR worker として動かす。
// viteEnvironment.name = "ssr" で vite の SSR environment と紐付け、
// client + server の HMR を統合 (CF docs の full-stack framework 推奨設定)。
export default defineConfig({
  // esbuild の JSX automatic runtime を @vidro/core に向ける。tsconfig の
  // jsxImportSource は tsc 用で、vite (esbuild) の dep scan には届かないため
  // transform phase 用に明示する必要がある。
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "@vidro/core",
  },
  // dep scan phase (起動時 pre-bundling) は vite-plus 0.1.x で esbuild → Rolldown
  // 移行中で、`optimizeDeps.esbuildOptions` は deprecated。dep scanner が JSX を
  // 見て `react/jsx-runtime` を自動 import 解決しに行くのを止めるため、resolve
  // alias で `@vidro/core/jsx-runtime` に向け直す (tooling 中立な fix)。
  resolve: {
    alias: {
      "react/jsx-runtime": "@vidro/core/jsx-runtime",
      "react/jsx-dev-runtime": "@vidro/core/jsx-dev-runtime",
    },
  },
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    jsxTransform(),
    routeTypes(),
    serverBoundary(),
  ],
});
