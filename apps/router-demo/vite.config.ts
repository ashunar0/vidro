import { defineConfig } from "vite-plus";
import { jsxTransform, routeTypes } from "@vidro/plugin";

export default defineConfig({
  plugins: [jsxTransform(), routeTypes()],
});
