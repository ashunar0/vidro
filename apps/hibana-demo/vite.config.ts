// apps/hibana-demo の vite.config.ts。Phase 1 Step 2/3 merge で導入。
//
// 役割:
//   1. @hono/vite-dev-server で Hono app を vite middleware として起動 (= dev は port 5173)
//   2. @vidro/plugin の jsxTransform を server/client 両方に適用 (= cursor-based hydrate に必須、
//      memory project_jsx_transform_mandatory_for_hydrate 参照)
//   3. mode 分岐で client bundle と server bundle を別 build 出力
//
// dev での client 配信は vite が `/src/client.ts` を on-demand transform して返す。
// 手書きの esbuild ステップは Step 3 で廃止 (= 旧 package.json の build:client script は消した)。

import { defineConfig } from "vite";
import devServer from "@hono/vite-dev-server";
import { jsxTransform } from "@vidro/plugin";

export default defineConfig(({ mode }) => {
  if (mode === "client") {
    // client mode: browser bundle を生成 (= src/client.ts を entry に静的に bundle)。
    // prod 配信時に serveStatic 経由で /static/client.js として返す前提。
    return {
      plugins: [jsxTransform()],
      build: {
        rollupOptions: {
          input: "./src/client.ts",
          output: {
            dir: "./dist/static",
            entryFileNames: "client.js",
          },
        },
        emptyOutDir: true,
        copyPublicDir: false,
      },
    };
  }

  // default mode: server (= Hono app) を dev / build。
  // dev では devServer plugin が src/app.ts を vite SSR で実行、client は /src/client.ts を
  // vite が transform して返す (= shell HTML の script tag が dev では /src/client.ts、
  // prod では /static/client.js を指す)。
  return {
    plugins: [
      jsxTransform(),
      devServer({
        entry: "./src/app.ts",
      }),
    ],
    build: {
      ssr: "./src/app.ts",
      rollupOptions: {
        output: {
          entryFileNames: "server.js",
        },
      },
    },
  };
});
