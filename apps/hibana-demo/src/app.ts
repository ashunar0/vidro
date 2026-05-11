// Hibana demo app entry。各 domain の routes を集約して @hono/node-server で起動する。
// 設計書の例構造に倣う:
//   src/domains/<feature>/routes.ts → app.route("/<feature>", routes)

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { hibana } from "@vidro/hibana";
import { postsRoutes } from "./domains/posts/routes.ts";

const app = new Hono();

app.use("*", hibana());

app.get("/", (c) => c.text("Hibana demo — try /posts"));
app.route("/posts", postsRoutes);

const port = 3000;
serve({ fetch: app.fetch, port });
console.log(`[hibana-demo] http://localhost:${port}`);
