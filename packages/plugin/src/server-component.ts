import { readFile } from "node:fs/promises";
import type { Plugin } from "vite";
import { assertNoReactivePrimitive, type IslandImport, scanIslandImports } from "./scan-imports";

// .server.tsx は ADR 0058 で server-only component file として意味論定義済。
// ADR 0060 で「client bundle 内では本体ロジックを消し、内部 island (.tsx import) の
// named map だけ残した stub virtual module に置換」する。
//
// 既存 serverBoundary は .server.{ts,js,jsx} (logic file) を空 stub `"export {}"` に
// 差し替える。本 plugin は .server.tsx (component file) を island 参照付き stub に
// 置換する責務分担 (= ADR 0060 Approach C)。
//
// 実装フロー (Approach A — ADR 0060):
//   1. client build pass のみ介入 (= server build / dev SSR では実体を通す)
//   2. AST scan で reactive primitive 誤用を検出 → build error
//   3. AST scan で .tsx import を named で抽出 → island candidates
//   4. import 文 + __islands named map を含む virtual module を return
//
// stub の中の `import { Counter } from "./counter"` を Vite が辿ることで、
// 「孤立 island」(= .server.tsx 経由でしか reach されない .tsx) も自然に
// client bundle に乗る。

export type ServerComponentOptions = Record<string, never>;

export function serverComponent(_options: ServerComponentOptions = {}): Plugin {
  return {
    name: "vidro-server-component",
    // serverBoundary より先に走らせて .server.tsx を stub virtual module 化する。
    // serverBoundary 側は .server.tsx を除外するよう修正済 (= 二重処理防止)。
    enforce: "pre",
    async load(id, opts) {
      // Vite 6 multi-environment API で client build / dev SSR を判定 (= reviewer M-3)。
      // CF plugin が立てる SSR / worker environment (name="ssr" 等) では実体を通して
      // server で .server.tsx 本体を実行できるようにする。
      const envName = this.environment?.name;
      const isClientPass = envName ? envName === "client" : !opts?.ssr;
      if (!isClientPass) return null;

      const clean = id.split("?")[0] ?? id;
      if (!clean.endsWith(".server.tsx")) return null;

      const source = await readFile(clean, "utf-8");
      assertNoReactivePrimitive(source, clean);
      const islands = scanIslandImports(source);

      return generateStub(islands);
    },
  };
}

function generateStub(islands: IslandImport[]): string {
  // import 文を出して Vite に「これらの .tsx は client bundle に必要」と教える。
  // bundler が import tree を辿って自然に bundle 入りする (= ADR 0060 stub 化)。
  const importLines = islands
    .map(({ name, path }) => `import { ${name} } from ${JSON.stringify(path)};`)
    .join("\n");

  // named map で stub から取り出せるようにする (= ADR 0060 C-α / M-1)。
  // 同 component を複数回 JSX 内で使うケースで lookup が安定する。
  const islandEntries = islands.map(({ name }) => `  ${name},`).join("\n");

  return `${importLines}

// stub: .server.tsx の本体は server build / dev SSR でのみ実行される。
// client bundle にはこの shell + island 参照しか入らない (ADR 0060 / Approach A)。
export const __islands: Record<string, unknown> = {
${islandEntries}
};

// Router が runtime import した時の no-op default。実際の navigation では server
// から HTML が返ってきて hydrate されるので、このダミー関数は呼ばれない想定。
export default function () {
  return null;
}
`;
}
