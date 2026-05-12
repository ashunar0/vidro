// filesystem-based routing 版 apps の entry。Plan C「2 つの apps で並走比較」の fs 版。
// 全 route と layout は app/routes/ 配下に置いて、Vite plugin が virtual:hibana/fs-routes
// 経由で集めた配列を `createFsApp` に渡すだけ。app.ts は 3 行 (= import 2 + export 1)。
//
// handler-based 版 (= apps/hibana-demo/src/app.ts) と書き心地を比較する目的。

import { createFsApp } from "@vidro/hibana/fs";
import { fsRoutes } from "virtual:hibana/fs-routes";

export default createFsApp(fsRoutes, { title: "Hibana Demo FS" });
