import { defineConfig } from "vite-plus";
import { cloudflare } from "@cloudflare/vite-plugin";
import { vidro } from "@vidro/plugin";

// @cloudflare/vite-plugin: vp dev 中に workerd を in-process で起動し、
// wrangler.toml の main (.vidro/server-entry.ts) を SSR worker として動かす。
// viteEnvironment.name = "ssr" で vite の SSR environment と紐付け、
// client + server の HMR を統合 (CF docs の full-stack framework 推奨設定)。
export default defineConfig({
  // build artifact を `.vidro/build/{client,ssr}/` に集約する (Next.js `.next/`
  // 流の 1 親 dir 集約)。`.vidro/` は routeTypes() の auto-gen source も置く dir
  // なので、`build/` 階層を切って vite の `emptyOutDir` (build 前 wipe) の影響
  // 範囲を build 出力のみに限定する (ADR 0043)。
  build: {
    outDir: ".vidro/build",
  },
  plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), ...vidro({ router: true })],
});
