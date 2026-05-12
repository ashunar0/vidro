// @vidro/hibana/vite-client — Hibana の Vite plugin が提供する virtual module の TS 型定義。
//
// 使い方 (app 側):
//   1. `apps/<app>/src/vite-env.d.ts` の先頭に下記の triple-slash directive を書く
//        /// <reference types="@vidro/hibana/vite-client" />
//   2. これで `import { islandMap } from "virtual:hibana/islands"` が型解決される
//
// vite/client.d.ts と同じ pattern (= ambient module 宣言を package 越しに reference)。
// 単独で使う場合は user の tsconfig.json の types に追加してもよいが、vite-env.d.ts 経由が
// vite ecosystem の慣習と整合する。

declare module "virtual:hibana/islands" {
  // (props: any) => Node は @vidro/hibana/client の IslandComponent と同じ shape。
  // function parameter contravariance を避けるため props は any で受ける (= 内部で
  // 動的 props を渡す前提、setupIslandHydration の boundary で 1 度だけ cast される)。
  // 戻り値は DOM Node (= vite-client.d.ts は DOM 環境前提、vite/client.d.ts と同じ立場)。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const islandMap: Record<string, (props: any) => Node>;
}

declare module "virtual:hibana/fs-routes" {
  // filesystem-based routing 用の route 配列。Vite plugin (= @vidro/hibana/vite) が
  // /app/routes/**/*.tsx を glob 発見して entry を組み立てる。`createFsApp(fsRoutes, options)`
  // に渡して Hono app を build する用途。詳細は @vidro/hibana/fs の FsRouteEntry を参照。
  import type { FsRouteEntry } from "@vidro/hibana/fs";
  export const fsRoutes: FsRouteEntry[];
}
