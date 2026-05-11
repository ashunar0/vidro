// apps/hibana-demo の browser bundle entry。vite で bundle され、shell HTML の
// <script type="module"> から読まれる (= dev では /src/client.ts、prod では /static/client.js)。
//
// Phase 1 Step 3-b 以降:
//   - `.island.tsx` の手書き import は撲滅 (= 旧: `import Counter from "./domains/posts/components/Counter.island.tsx"`)
//   - 代わりに `@vidro/hibana/vite` plugin が virtual module `virtual:hibana/islands` 経由で
//     islandMap (= name → component default export) を提供する
//   - user は新しい island を `**/*.island.tsx` に追加するだけで自動発見される
//
// 型解決: src/vite-env.d.ts の `/// <reference types="@vidro/hibana/vite-client" />` で virtual
// module 宣言が読まれる。

import { setupIslandHydration } from "@vidro/hibana/client";
import { islandMap } from "virtual:hibana/islands";

setupIslandHydration(islandMap);
