// apps/hibana-demo の browser bundle entry。
// esbuild で bundle され、Hono の serveStatic 経由で /static/client.js として配信される。
//
// 役割: 各 .island.tsx の component を import して、@vidro/hibana/client の
// setupIslandHydration に islandMap として渡す。これで server が emit した marker queue が
// drain されて、各 island が hydrate される。
//
// Step 3 で Vite plugin を導入したら、本 file の手書き import 列は plugin が生成する
// virtual module に置き換わる予定。

import { setupIslandHydration } from "@vidro/hibana/client";
import Counter from "./domains/posts/components/Counter.island.tsx";

setupIslandHydration({ Counter });
