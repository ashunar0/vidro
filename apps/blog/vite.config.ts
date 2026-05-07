import { defineConfig } from "vite-plus";
import { cloudflare } from "@cloudflare/vite-plugin";
import { vidro } from "@vidro/plugin";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  build: {
    outDir: ".vidro/build",
  },
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    vidro({ router: true }),
    tailwindcss(),
  ],
});
