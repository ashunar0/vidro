// GET /about の handler (filesystem-based 規約)。route file 側に metadata + handler。
//
// 解 a (= 第 21 周目): route file 側 `export const metadata` を c.render 時に attach。
// 機構は @vidro/hibana/fs の createFsApp の wrapper が c.var.hibanaRouteMetadata に積み、
// hibana() middleware の renderer が読む (= ADR 0079 Component.metadata より優先)。

import type { Metadata } from "@vidro/hibana";
import { createRoute } from "@vidro/hibana/fs";
import { AboutPage } from "../../pages/AboutPage.tsx";

export const metadata: Metadata = {
  title: "About — Hibana Demo (fs)",
  description: "About page (filesystem-based 版) で layout 切り替え navigation を試す",
};

export default createRoute((c) => c.render(AboutPage));
