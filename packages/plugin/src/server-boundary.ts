import type { Plugin } from "vite";

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
// 残った責務は `load` hook のみ：client bundle pass で `.server.ts` /
// `layout.server.ts` / `*.server.{ts,tsx,js,jsx}` を空 stub に差し替える。これは
// 設計書の `.server.ts` 拡張子規約 (server-only code) を強制する layer なので
// CF plugin に委ねず Vidro 側で持ち続ける。

export type ServerBoundaryOptions = Record<string, never>;

export function serverBoundary(_options: ServerBoundaryOptions = {}): Plugin {
  return {
    name: "vidro-server-boundary",
    // vite 内蔵 loader や他 plugin が `.server.ts` の実ファイルを先に返してしまう
    // ことがあるため、pre で先取りしてから stub に差し替える。
    enforce: "pre",
    load(id, opts) {
      // 新 vite environment API: this.environment.name === "client" の時のみ stub。
      // CF plugin が立てる SSR / worker environment (name="ssr" 等) では実体を通す。
      // 旧 API fallback として opts.ssr === true も「実体通す」サインとして併用する。
      const envName = this.environment?.name;
      const isClientPass = envName ? envName === "client" : !opts?.ssr;
      if (!isClientPass) return null;
      if (!isServerOnlyId(id)) return null;
      return "export {}";
    },
  };
}

// client 側で stub に差し替える id 判定。query string (`?import` / `?url` 等) を
// 剥がしてから basename を見る。Vidro の routes 下では:
//   - leaf route loader: `server.ts`
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
