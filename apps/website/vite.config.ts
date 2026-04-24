import { defineConfig } from "vite-plus";
import tailwindcss from "@tailwindcss/vite";
import { jsxTransform } from "@vidro/plugin";

export default defineConfig({
  plugins: [jsxTransform(), tailwindcss()],
});
