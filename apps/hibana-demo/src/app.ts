// Hibana demo app entry。各 domain の routes を集約して Hono app を default export する。
// 起動は @hono/vite-dev-server (dev) + 後続 Step で別 prod entry (= TODO Step 6) が担当。
//
// 設計書の例構造に倣う:
//   src/domains/<feature>/routes.ts → app.route("/<feature>", routes)

import { Hono } from "hono";
import { hibana } from "@vidro/hibana";
import { postsRoutes } from "./domains/posts/routes.ts";

const app = new Hono();

// shell HTML 内に client bundle の <script type="module" src="..."></script> を inject。
// dev では vite が `/src/client.ts` を on-demand transform して返す。prod では別途 vite build
// (= `vite build --mode client`) で生成された /static/client.js を serve する想定。
app.use(
  "*",
  hibana({
    title: "Hibana Demo",
    clientScript: import.meta.env.PROD ? "/static/client.js" : "/src/client.ts",
  }),
);

app.get("/", (c) => c.text("Hibana demo — try /posts"));
app.route("/posts", postsRoutes);

export default app;
