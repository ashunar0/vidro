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
// Phase 1 Step 3-b Phase B-2 で URL 分岐は内部 auto-detect 化 (= user は書かなくて済む):
//   dev (NODE_ENV !== "production"): vite plugin 提供の virtual entry を直接読みに行く
//   prod (NODE_ENV === "production"): /static/client.js を serveStatic で配信 (= Step 6 で整備)
app.use("*", hibana({ title: "Hibana Demo" }));

app.get("/", (c) => c.text("Hibana demo — try /posts"));
app.route("/posts", postsRoutes);

export default app;
