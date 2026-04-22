import { defineConfig } from "vite-plus/pack";

export default defineConfig({
  entry: ["./src/index.ts", "./src/jsx-runtime.ts", "./src/jsx-dev-runtime.ts"],
  dts: {
    tsgo: true,
  },
  exports: true,
});
