// @vidro/hibana/fs — filesystem-based routing 機構 (Phase 1 Step 4 (3) 並走比較版)。
//
// handler-based 版 (= packages/hibana/src/index.ts) と並走する filesystem-based 版。
// Plan C「2 つの apps で並走比較」のうち、user が `apps/hibana-demo-fs/app/routes/` 配下に
// route file を配置するだけで、Vite plugin (= @vidro/hibana/vite) が自動 register する。
//
// 規約 (= HonoX 流):
//   - app/routes/<segments>/index.tsx       → GET /<segments>
//   - app/routes/<segments>/[id]/index.tsx  → GET /<segments>/:id
//   - app/routes/<segments>/_renderer.tsx   → /<segments>/* 配下に scoped layout
//
// route file の中身 (= 解 a、第 21 周目で確定):
//   - default export = createRoute((c) => ...) で作った Hono Handler
//   - export const metadata = ... (= ADR 0079 と同 export 名、route file 側で書く)
//   - export const handler = createRoute(...) 等の追加 export は今のところサポートしない
//
// ADR 0079 の metadata は handler-based 版では page module 側に書くが、本 fs 版では
// route file 側に書く (= ADR 0080 候補で記述、両 dogfood 比較後に正式決定)。
// 機構的には: Vite plugin が route file の `export const metadata` を import、
// fsRoutes entry に attach、createFsApp の handler wrapper が c.set で c.var に積む、
// hibana() middleware の renderer が c.var.hibanaRouteMetadata を読む。

import type { Handler, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  hibana,
  type HibanaOptions,
  type LayoutComponent,
  type Metadata,
  type MetadataFn,
} from "./index.js";

/**
 * route file の default export を作る helper。現状は Hono Handler を素通しで返すだけ。
 * 将来 type narrowing / runtime guard を入れる余地のため API surface を確保している。
 *
 * 例:
 *   export default createRoute((c) => {
 *     const posts = getPosts();
 *     return c.render(PostListPage, { posts });
 *   });
 */
export const createRoute = (handler: Handler): Handler => handler;

/**
 * filesystem-based 版がサポートする HTTP method。
 *
 * 規約:
 *   - `default export` = GET (= page render)
 *   - `export const POST = ...` 等の named export = method 別 handler
 *
 * HTML form の method 属性が `GET` / `POST` 限定なので Hibana 流 (= "MPA に client 制御を持ち込む") では
 * PUT/DELETE/PATCH を JS 経由 (= island fetch 等) で呼ぶしかないが、Hono Handler 層では同形で扱うので
 * union に並べておく (= dogfood で必要になった機能から自然に届く)。
 */
export type FsHttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

/**
 * 1 つの route entry。Vite plugin の virtual:hibana/fs-routes が export する配列の要素。
 * user が直接触る型ではないが、createFsApp の引数として渡される。
 */
export type FsRouteEntry = {
  /** HTTP method。GET = default export、POST 等 = named export 由来。 */
  method: FsHttpMethod;
  /** Hono の path 形式 (= `/posts/:id` 等)。filename pattern からの変換結果。 */
  path: string;
  /** route file の default export (= GET) or named export (= POST 等)、いずれも createRoute(...) で作った Hono Handler。 */
  handler: Handler;
  /** route file 側の `export const metadata` (= ADR 0079 同名)。GET 経由でのみ意味を持つ (= page render 用)。 */
  metadata?: Metadata | MetadataFn<unknown>;
  /** この route に適用される layout (= 親 → 子 順)。Vite plugin が _renderer.tsx の階層から計算。 */
  layouts: LayoutComponent[];
};

// method → Hono app method 名 の dispatch table。
// switch で書くよりも `Record` 1 個で `app[map[method]](...)` 一発呼び出しに統一できる。
const METHOD_DISPATCH = {
  GET: "get",
  POST: "post",
  PUT: "put",
  DELETE: "delete",
  PATCH: "patch",
} as const satisfies Record<FsHttpMethod, "get" | "post" | "put" | "delete" | "patch">;

// hibanaRouteMetadata の ContextVariableMap augment は index.ts (= core 側) に統合済。
// 理由: `@vidro/hibana` 単独 import でも augment が効く必要がある (= renderer が読む経路)。

/**
 * Vite plugin が virtual module で提供する fsRoutes 配列を受けて、Hono app を組み立てる。
 *
 * 例:
 *   import { fsRoutes } from "virtual:hibana/fs-routes";
 *   import { createFsApp } from "@vidro/hibana/fs";
 *   export default createFsApp(fsRoutes, { title: "Hibana Demo FS" });
 *
 * 機構:
 *   1. hibana() middleware を最初に適用 (= c.render + shell HTML 提供)
 *   2. 各 route ごとに wrapper handler を作り、layout を stack に push + metadata を c.set
 *   3. method + path で Hono に register
 *
 * nested layout は handler-based 版と同じく stack push + reduceRight wrap で動く
 * (= packages/hibana/src/index.ts の renderer がこの stack を読む共通機構)。
 */
export const createFsApp = (routes: FsRouteEntry[], options: HibanaOptions = {}): Hono => {
  const app = new Hono();
  app.use("*", hibana(options));

  for (const route of routes) {
    // route ごとの setup middleware: layout を stack に一発 set + metadata を c.set で積む。
    // 中身は handler-based 版の hibanaLayout middleware の機能 + metadata 経路の合成。
    // 終端の `route.handler` は filesystem-based 版で user が createRoute(...) で作った
    // Hono Handler (= 最終的に c.render(...) を呼ぶ)、Hono の chain で setup → handler の
    // 2 段で実行させると next() の引数問題を回避できる + 慣用的な書き方。
    //
    // layout は route ごとに pre-computed (= Vite plugin が _renderer.tsx 階層から計算済) で
    // 固定なので、c.set で一発 set (= O(N) コピー削減、code-review [3] 反映)。
    // filesystem-based 版は createFsApp で完結するので、handler-based 版の `.use("*", hibanaLayout(...))`
    // と同 c.var を共有する想定は無く、append でなく override で問題ない。
    // layouts は全 method の setupMiddleware で set される (= GET / POST 区別なし)。
    // POST 等 named handler が c.redirect / Response.json を返す想定なら layout は dead weight (= 害なし)、
    // ただし誤って `c.render(Page, ...)` を呼んだ場合は layout に wrap された HTML が返る点に注意。
    const setupMiddleware: MiddlewareHandler = async (c, next) => {
      if (route.layouts.length > 0) {
        c.set("hibanaLayouts", route.layouts);
      }
      if (route.metadata !== undefined) {
        c.set("hibanaRouteMetadata", route.metadata);
      }
      await next();
    };

    const methodFn = METHOD_DISPATCH[route.method];
    app[methodFn](route.path, setupMiddleware, route.handler);
  }

  return app;
};
