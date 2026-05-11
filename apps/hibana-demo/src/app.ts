// Hibana demo app entry。各 domain の routes を集約して @hono/node-server で起動する。
// 設計書の例構造に倣う:
//   src/domains/<feature>/routes.ts → app.route("/<feature>", routes)

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { hibana } from "@vidro/hibana";
import { postsRoutes } from "./domains/posts/routes.ts";

const app = new Hono();

// /static/* で client bundle を配信。esbuild が dist/client/client.js に build した内容を
// serve する (= apps/hibana-demo/package.json の build:client script 参照)。
app.use(
  "/static/*",
  serveStatic({ root: "./dist/client", rewriteRequestPath: (p) => p.replace(/^\/static\//, "/") }),
);

// shell HTML 内に <script type="module" src="/static/client.js"></script> を inject。
// client.js は browser で setupIslandHydration を呼んで marker queue を drain する。
app.use("*", hibana({ title: "Hibana Demo", clientScript: "/static/client.js" }));

app.get("/", (c) => c.text("Hibana demo — try /posts"));
app.route("/posts", postsRoutes);

const port = 3000;
serve({ fetch: app.fetch, port });
console.log(`[hibana-demo] http://localhost:${port}`);
