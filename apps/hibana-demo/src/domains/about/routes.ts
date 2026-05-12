// /about domain の Hono sub-router。app.ts から `.route("/about", aboutRoutes)` で mount。
// Step 5 (ADR 0080) dogfood 用、PostsLayout と別 layout (= AboutLayout) を試すための minimum 構成。

import { Hono } from "hono";
import { hibanaLayout } from "@vidro/hibana";
import AboutPage from "./pages/AboutPage.tsx";
import { AboutLayout } from "./layouts/AboutLayout.tsx";

export const aboutRoutes = new Hono()
  .use("*", hibanaLayout(AboutLayout))
  .get("/", (c) => c.render(AboutPage));
