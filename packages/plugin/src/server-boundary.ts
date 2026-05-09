import { readFile } from "node:fs/promises";
import type { Plugin } from "vite";
import { transformServerFnSourceForClient } from "./server-fn-transform";

// Vidro の server boundary plugin。役割は **client bundle に server-only code を
// 漏らさない security boundary** の 1 点 (ADR 0043 で簡素化)。
//
// 旧実装は dev 用 `/__loader` middleware と prod 用 `closeBundle` 2nd-pass ssr
// build を兼ねていたが、ADR 0043 で `@cloudflare/vite-plugin` に統合し、両機能を
// CF plugin に委譲した：
//   - dev: workerd が in-process で起動し、navigation / loader request を全て
//     server entry (`createServerHandler`) で受ける。Vite middleware は不要。
//   - build: CF plugin が client bundle と worker bundle を統合管理する。Vidro
//     側で 2nd-pass build を起こす必要が無くなった。
//
// 残った責務は `load` hook：client bundle pass で `.server.{ts,js,jsx}` /
// `layout.server.ts` / `server.ts` を制御する。これは設計書の `.server.ts`
// 拡張子規約 (server-only code) を強制する layer なので CF plugin に委ねず
// Vidro 側で持ち続ける。
//
// ADR 0070 Phase 2b: `server.ts` のみ追加責務として、内部の `serverFn(...)`
// named export を client 用 fetch stub に置換した virtual module を返す。それ
// 以外の `.server.{ts,js,jsx}` は従来通り空 stub `export {}` (= Pages mode の
// `loader` / `action` を含む server-only logic、client から触らない前提)。
// `*.server.tsx` は引き続き serverComponent plugin が処理 (= 本 plugin では除外)。

export type ServerBoundaryOptions = {
  /**
   * server function URL 生成と config 一致のため。Phase 2b の transform で
   * 必要、未指定なら `vite` の `config.root` を使う (= configResolved hook
   * 経由)。test override 用。
   */
  projectRoot?: string;
  /** src directory 名 (= server-fn-registry の srcDir) */
  srcDir?: string;
  /** routes directory 名 */
  routesDir?: string;
};

export function serverBoundary(options: ServerBoundaryOptions = {}): Plugin {
  // configResolved で project root を確定 (= options 優先、未指定なら config.root)
  let resolvedProjectRoot = options.projectRoot;

  return {
    name: "vidro-server-boundary",
    // vite 内蔵 loader や他 plugin が `.server.ts` の実ファイルを先に返してしまう
    // ことがあるため、pre で先取りしてから stub に差し替える。
    enforce: "pre",
    configResolved(config) {
      if (!resolvedProjectRoot) {
        resolvedProjectRoot = config.root;
      }
    },
    async load(id, opts) {
      // 新 vite environment API: this.environment.name === "client" の時のみ stub。
      // CF plugin が立てる SSR / worker environment (name="ssr" 等) では実体を通す。
      // 旧 API fallback として opts.ssr === true も「実体通す」サインとして併用する。
      const envName = this.environment?.name;
      const isClientPass = envName ? envName === "client" : !opts?.ssr;
      if (!isClientPass) return null;
      if (!isServerOnlyId(id)) return null;

      const clean = id.split("?")[0] ?? id;
      const name = clean.replace(/^.*[\\/]/, "");

      // ADR 0070 Phase 2b: `server.ts` のみ AppRouter mode 用 transform を試行。
      // serverFn-wrapped export がなければ何もせず空 stub fallback (= Pages mode
      // の `loader` / `action` だけの場合に server-only な実装が client に
      // 漏れる事を防ぐ)。
      //
      // projectRoot 配下にない `server.ts` (= node_modules 内のライブラリ等) は
      // 即 empty stub。transform を試みても urlForServerFn が `outside src/`
      // で throw して warn ノイズが出るだけなので先に弾く。
      if (
        name === "server.ts" &&
        resolvedProjectRoot &&
        isUnderProjectRoot(clean, resolvedProjectRoot)
      ) {
        try {
          const source = await readFile(clean, "utf-8");
          const result = transformServerFnSourceForClient({
            source,
            filePath: clean,
            projectRoot: resolvedProjectRoot,
            srcDir: options.srcDir,
            routesDir: options.routesDir,
          });
          // transform が serverFn-wrapped を 1 件以上 stub 化した場合のみ
          // virtual module 化、それ以外は従来通り empty stub に倒す。
          const hasStubbed = result.entries.some((e) => e.kind === "serverFn-wrapped");
          if (hasStubbed) return result.code;
        } catch (err) {
          // parse 失敗等で transform に転んだ場合は安全側 (= empty stub) に倒す。
          // user に気付かせるため warn は console.error で残す (vite log も拾う)。
          console.warn(
            `[vidro/server-boundary] Failed to transform ${clean} for client bundle, ` +
              `falling back to empty stub. ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      return "export {}";
    },
  };
}

// projectRoot 配下かどうかの軽量判定。posix / Windows 両対応 (= `\` も `/` も
// separator として扱う)、抜け出し (`../`) は normalize せず先頭 prefix の単純
// 比較。bundler が渡してくる id は通常 normalized absolute なのでこれで十分。
function isUnderProjectRoot(filePath: string, projectRoot: string): boolean {
  // 末尾 separator を揃えて prefix match
  const normalizedRoot =
    projectRoot.endsWith("/") || projectRoot.endsWith("\\") ? projectRoot : `${projectRoot}/`;
  const normalizedFile = filePath.replace(/\\/g, "/");
  const normalizedRootSlash = normalizedRoot.replace(/\\/g, "/");
  return normalizedFile.startsWith(normalizedRootSlash);
}

// client 側で stub に差し替える id 判定。query string (`?import` / `?url` 等) を
// 剥がしてから basename を見る。Vidro の routes 下では:
//   - leaf route loader / action / server function: `server.ts`
//   - layout loader: `layout.server.ts`
// route 規約 (route-types.ts ROUTE_FILE_KIND) は現状 `.ts` のみ。
//
// **`.server.tsx` (component file) は serverComponent plugin (ADR 0060) が
// stub virtual module 化を担当するので本 plugin では除外**。logic file
// (= `.server.{ts,js,jsx}`) のみ責務とする。
function isServerOnlyId(id: string): boolean {
  const clean = id.split("?")[0] ?? id;
  const name = clean.replace(/^.*[\\/]/, "");
  // .server.tsx は serverComponent plugin (ADR 0060) が担当
  if (clean.endsWith(".server.tsx")) return false;
  if (name === "server.ts") return true;
  if (name === "layout.server.ts") return true;
  // 設計書の拡張子規約: .server.{ts,js,jsx} は logic file として空 stub 化
  return /\.server\.(ts|js|jsx)$/.test(clean);
}
