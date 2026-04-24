import { defineConfig } from "vite-plus";
import { jsxTransform } from "@vidro/plugin";

export default defineConfig({
  plugins: [jsxTransform()],
});
