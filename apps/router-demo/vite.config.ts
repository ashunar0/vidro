import { defineConfig } from "vite-plus";
import { jsxTransform, routeTypes, serverBoundary } from "@vidro/plugin";

export default defineConfig({
  plugins: [jsxTransform(), routeTypes(), serverBoundary()],
});
