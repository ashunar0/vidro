// @vidro/hibana/vite — Hibana の Vite plugin。Phase 1 Step 3-b で導入。
//
// 役割: `.island.tsx` を glob で自動発見し、virtual module `virtual:hibana/islands` 経由で
// islandMap (= name → component default export の lookup table) を提供する。これにより
// apps 側の client.ts が手書き import を持たなくて済む:
//
//   旧:
//     import Counter from "./domains/posts/components/Counter.island.tsx";
//     setupIslandHydration({ Counter });
//   新:
//     import { islandMap } from "virtual:hibana/islands";
//     setupIslandHydration(islandMap);
//
// 設計書「Vite plugin で .island.tsx 自動発見、AST 解析不要 (= glob で十分)」と整合
// (= docs/roadmap-hibana.md Step 3-b)。HMR は vite の `import.meta.glob` 機構が file 追加/削除を
// 自動検知するため、本 plugin 側で server.watcher を触る必要はない。
//
// 命名 convention (Phase A 段階):
//   - filename が `<Name>.island.tsx` の default export が `<Name>` として登録される
//   - user は `defineIsland(Counter, "Counter")` の第 2 引数 (= name) を filename と一致させる
//     必要がある (= 機構が見ているのは filename だけ、defineIsland の第 2 引数は SSR marker 用)
//   - Phase B でこの制約は機械化される予定 (= plugin が defineIsland の auto-wrap + filename 自動付与)

import type { Plugin } from "vite";

const VIRTUAL_ID = "virtual:hibana/islands";
// vite の慣習: virtual module の resolved id は `\0` prefix を付けて他 plugin の処理対象外にする。
const RESOLVED_VIRTUAL_ID = "\0" + VIRTUAL_ID;

export type HibanaViteOptions = {
  /**
   * `.island.tsx` の glob pattern。vite の root からの絶対パス (= `/` 始まり) で書く。
   * default: `/src/**\/*.island.tsx`
   *
   * 例: monorepo の app が src/ 配下に集約されている前提。深い nest (例: `src/domains/posts/components/Counter.island.tsx`) も
   * `**` で再帰的に拾える。
   */
  islandGlob?: string;
};

/**
 * Hibana の `.island.tsx` 自動発見 + virtual module 提供 plugin。
 *
 * vite.config.ts:
 *   plugins: [hibanaVite(), jsxTransform()]
 *
 * jsxTransform との順序: `enforce: "pre"` を持つ jsxTransform が先に走るように
 * vite の plugin order に従う。本 plugin は通常 plugin (= 中位) で問題ない。
 */
export function hibanaVite(options: HibanaViteOptions = {}): Plugin {
  const glob = options.islandGlob ?? "/src/**/*.island.tsx";

  return {
    name: "vidro-hibana-islands",

    resolveId(id: string) {
      if (id === VIRTUAL_ID) return RESOLVED_VIRTUAL_ID;
      return null;
    },

    load(id: string) {
      if (id !== RESOLVED_VIRTUAL_ID) return null;

      // 返すコード内の `import.meta.glob` は vite が build-time / dev-time に静的展開する。
      // `eager: true` で実 import を実行して default export を取れる形にする。
      // 各 path から `<Name>.island.tsx` の `<Name>` 部分を抽出し、islandMap の key に使う。
      //
      // filename match に失敗した場合 (= 通常起きないが) はフルパスを fallback key にする。
      // 重複 (= 同名 island.tsx が複数 folder にある) は Object.fromEntries の後勝ち動作で
      // 上書きされる: Phase A では検出だけで warn しない、Phase B で build error 化検討。
      return `
const modules = import.meta.glob(${JSON.stringify(glob)}, { eager: true });
export const islandMap = Object.fromEntries(
  Object.entries(modules).map(([path, mod]) => {
    const match = path.match(/([^/]+)\\.island\\.tsx$/);
    return [match ? match[1] : path, mod.default];
  })
);
`;
    },
  };
}
