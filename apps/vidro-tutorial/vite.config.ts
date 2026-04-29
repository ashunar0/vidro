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
  // 明示する必要がある。これがないと CF plugin の SSR env scan が
  // `react/jsx-runtime` を探して失敗する。
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "@vidro/core",
  },
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    jsxTransform(),
    routeTypes(),
    serverBoundary(),
  ],
});
