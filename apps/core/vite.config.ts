import { defineConfig } from "vite-plus";
import { vidro } from "@vidro/plugin";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [vidro(), tailwindcss()],
});
