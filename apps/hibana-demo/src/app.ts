// Hibana demo app entry。各 domain の routes を集約して Hono app を default export する。
// 起動は @hono/vite-dev-server (dev) + 後続 Step で別 prod entry (= TODO Step 6) が担当。
//
// 設計書の例構造に倣う:
//   src/domains/<feature>/routes.ts → app.route("/<feature>", routes)

import { Hono } from "hono";
import { hibana, hibanaLayout } from "@vidro/hibana";
import { AppLayout } from "./layouts/AppLayout.tsx";
import { postsRoutes } from "./domains/posts/routes.ts";

// chain 形式で書く (= Hono の型 inference 要件、routes.ts と同じ理由)。
// 順番にも意味があり、Hono の middleware execution order (= 登録順) に従う:
//   1. `hibana(...)` を最初に置く: c.setRenderer + shell HTML の枠組みを準備
//   2. `hibanaLayout(AppLayout)` で全 route に AppLayout を push (= stack の親側)
//   3. handler / route mount 以降は子 router (= posts) が独自 layout を push する
//
// shell HTML 内に client bundle の <script type="module" src="..."></script> を inject:
//   dev (NODE_ENV !== "production"): vite plugin 提供の virtual entry を直接読みに行く
//   prod (NODE_ENV === "production"): /static/client.js を serveStatic で配信 (= Step 6 で整備)
const app = new Hono()
  .use("*", hibana({ title: "Hibana Demo" }))
  .use("*", hibanaLayout(AppLayout))
  .get("/", (c) => c.text("Hibana demo — try /posts"))
  .route("/posts", postsRoutes);

export default app;
