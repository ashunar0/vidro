// routes/ 配下のファイルパスを URL パターンに変換し、pathname → route + layouts +
// server (loader) の match を行う。Vite plugin を挟まず app 側で import.meta.glob を
// 書く形のため、受け取るのは `Record<filePath, () => Promise<Module>>` という最小表現。
//
// 拾うファイル:
// - `index.tsx` → RouteEntry (leaf component)
// - `layout.tsx` → LayoutEntry (nested wrap)
// - `server.ts` → ServerEntry (leaf の loader / action)
// - `layout.server.ts` → layout 自身の loader (Phase 3 第 2 弾)。LayoutEntry.serverLoad
//   に紐付けられ、matchRoute 時に layout 用 data を並列 fetch する対象になる。
// - `error.tsx` → ErrorEntry (階層的 error 表示)
// - `not-found.tsx` → 404 fallback (特別扱い)

type RouteModule = { default: (props?: Record<string, unknown>) => Node };
type RouteLoader = () => Promise<RouteModule>;

// router.tsx 側から layout loader 実行に使うので export。
// action は ADR 0037 (Phase 3 R-min) で追加。同 server.ts module 内で loader と
// 共存する形 (Remix と同じ)。引数は { request, params }、戻り値は plain value
// または `Response` (= redirect 用)。throw は SerializedError 形式で client に伝播。
export type ServerModule = {
  // ADR 0053: loader も { request, params } shape (= action と対称、WinterCG 流儀)。
  loader?: (args: { request: Request; params: Record<string, string> }) => Promise<unknown>;
  // action は sync / async 両対応。`Promise<unknown>` は `unknown` に含まれるので
  // redundant union を避けて `unknown` 単独で受ける。
  action?: (args: { request: Request; params: Record<string, string> }) => unknown;
};
export type ServerModuleLoader = () => Promise<ServerModule>;

// Vite の import.meta.glob は `Record<string, () => Promise<unknown>>` を返すので、
// public 型はそちらに合わせて緩く、内部で個別 loader 型としてキャストする。
export type RouteRecord = Record<string, () => Promise<unknown>>;

export type RouteEntry = {
  /** import.meta.glob の key (例: "./routes/users/[id]/index.tsx")。eager glob 経由で
   *  sync lookup するときの参照キー (Step B-3b)。 */
  filePath: string;
  /** URL パターン文字列 (例: "/users/:id") */
  path: string;
  /** マッチ判定用の RegExp */
  pattern: RegExp;
  /** capture group の順序に対応する param 名 */
  paramNames: string[];
  /** lazy load 関数 */
  load: RouteLoader;
};

export type LayoutEntry = {
  /** import.meta.glob の key (eager lookup 用、B-3b) */
  filePath: string;
  /** layout が適用される path prefix (例: "/users", root layout は "") */
  pathPrefix: string;
  /** pathname がこれにマッチしたら apply する RegExp */
  pattern: RegExp;
  /** capture group の順序に対応する param 名 */
  paramNames: string[];
  /** lazy load 関数 (layout component) */
  load: RouteLoader;
  /** 同 dir に layout.server.ts があれば layout 用 loader。なければ null。 */
  serverLoad: ServerModuleLoader | null;
};

export type ServerEntry = {
  /** 紐付く route の URL パターン (例: "/users/:id"、RouteEntry.path と同じ) */
  path: string;
  /** lazy load 関数 (server.ts module) */
  load: ServerModuleLoader;
};

export type ErrorEntry = {
  /** import.meta.glob の key (eager lookup 用、B-3b) */
  filePath: string;
  /** error.tsx が cover する path prefix (例: "/users"、root error は "") */
  pathPrefix: string;
  /** pathname がこれにマッチしたら適用候補になる RegExp */
  pattern: RegExp;
  /** capture group の順序に対応する param 名 */
  paramNames: string[];
  /** lazy load 関数 */
  load: RouteLoader;
};

export type NotFoundEntry = {
  filePath: string;
  load: RouteLoader;
};

export type CompiledRoutes = {
  routes: RouteEntry[];
  layouts: LayoutEntry[];
  servers: ServerEntry[];
  errors: ErrorEntry[];
  notFound?: NotFoundEntry;
};

export type MatchResult = {
  /** マッチした leaf route。なければ null (= notFound 行き) */
  route: RouteEntry | null;
  /** 適用される layout 列。浅い → 深い順で並ぶ */
  layouts: LayoutEntry[];
  /** 同 dir に server.ts があれば対応する ServerEntry、無ければ null */
  server: ServerEntry | null;
  /** pathname に match する error.tsx 候補、**深い → 浅い順**。Router 側で
   *  どの layer の error かに応じて、leaf は errors[0] (最寄り)、layout[i] は
   *  pathPrefix < layouts[i].pathPrefix を満たす最初 (= 最深の外側) を選ぶ。 */
  errors: ErrorEntry[];
  /** route + layouts の paramNames から抽出した値 */
  params: Record<string, string>;
};

/**
 * import.meta.glob の返り値を受け取り、RouteEntry / LayoutEntry / ServerEntry の
 * リストに変換する。
 * - `./routes/index.tsx` → "/"
 * - `./routes/about/index.tsx` → "/about"
 * - `./routes/users/[id]/index.tsx` → "/users/:id"
 * - `./routes/layout.tsx` → root layout (pathPrefix "")
 * - `./routes/users/layout.tsx` → "/users" 配下の layout
 * - `./routes/users/layout.server.ts` → "/users" 配下 layout の loader
 * - `./routes/users/[id]/server.ts` → "/users/:id" の server (loader)
 * - `./routes/not-found.tsx` は 404 fallback として特別扱い
 */
export function compileRoutes(modules: RouteRecord): CompiledRoutes {
  const routes: RouteEntry[] = [];
  const layouts: LayoutEntry[] = [];
  const servers: ServerEntry[] = [];
  const errors: ErrorEntry[] = [];
  // layout.server.ts は layout と 1:1 で紐付くので、pathPrefix -> loader の Map に
  // 一旦貯めて、layouts を組み立て終わってから lookup する (2-pass)。
  const layoutServers = new Map<string, ServerModuleLoader>();
  let notFound: NotFoundEntry | undefined;

  for (const [filePath, rawLoad] of Object.entries(modules)) {
    if (isNotFoundFile(filePath)) {
      notFound = { filePath, load: rawLoad as RouteLoader };
      continue;
    }
    if (filePath.endsWith("/layout.tsx")) {
      const pathPrefix = filePathToLayoutPath(filePath);
      const { pattern, paramNames } = layoutPathToPattern(pathPrefix);
      layouts.push({
        filePath,
        pathPrefix,
        pattern,
        paramNames,
        load: rawLoad as RouteLoader,
        serverLoad: null,
      });
      continue;
    }
    if (filePath.endsWith("/error.tsx")) {
      const pathPrefix = filePathToErrorPath(filePath);
      // error.tsx は layout と同じ prefix-match (sub tree 全体に効く) で挙動が一致。
      const { pattern, paramNames } = layoutPathToPattern(pathPrefix);
      errors.push({ filePath, pathPrefix, pattern, paramNames, load: rawLoad as RouteLoader });
      continue;
    }
    // layout.server.ts は server.ts にも endsWith で match するので先に判定。
    if (filePath.endsWith("/layout.server.ts")) {
      const pathPrefix = filePathToLayoutServerPath(filePath);
      layoutServers.set(pathPrefix, rawLoad as ServerModuleLoader);
      continue;
    }
    if (filePath.endsWith("/server.ts")) {
      const path = filePathToServerPath(filePath);
      servers.push({ path, load: rawLoad as ServerModuleLoader });
      continue;
    }
    if (!filePath.endsWith("/index.tsx")) continue;

    const path = filePathToRoutePath(filePath);
    const { pattern, paramNames } = pathToPattern(path);
    routes.push({ filePath, path, pattern, paramNames, load: rawLoad as RouteLoader });
  }

  // layouts に layout.server.ts を重ね合わせ。pathPrefix が一致する layout の
  // serverLoad に詰める。
  for (const layout of layouts) {
    const ls = layoutServers.get(layout.pathPrefix);
    if (ls) layout.serverLoad = ls;
  }

  // specificity 順で sort: dynamic segment 少ない route を先にマッチさせる。
  // 例: "/users/new" と "/users/:id" が両方あれば前者が優先。最小版では
  // route 数が少ないので paramNames 数での単純比較で十分。
  routes.sort((a, b) => a.paramNames.length - b.paramNames.length);

  return { routes, layouts, servers, errors, notFound };
}

/**
 * pathname を compiled routes と突き合わせ、マッチした route と適用 layouts と
 * 対応する server を返す。route が見つからない (notFound 行き) ケースでも
 * layouts は collect される (= 404 page も root layout で wrap される)。
 * server は route が確定して初めて lookup する (notFound に server は無い前提)。
 */
export function matchRoute(pathname: string, compiled: CompiledRoutes): MatchResult {
  let matchedRoute: RouteEntry | null = null;
  const params: Record<string, string> = {};

  for (const route of compiled.routes) {
    const m = pathname.match(route.pattern);
    if (!m) continue;
    matchedRoute = route;
    for (let i = 0; i < route.paramNames.length; i++) {
      params[route.paramNames[i]!] = m[i + 1]!;
    }
    break;
  }

  // layouts は route とは独立に pathname にマッチさせる。route が見つからなくても
  // root layout は当てたいので、collect 自体は常に行う。
  const matchedLayouts: LayoutEntry[] = [];
  for (const layout of compiled.layouts) {
    if (layout.pattern.test(pathname)) matchedLayouts.push(layout);
  }
  // 浅い (pathPrefix が短い) 順 = 親 → 子の順
  matchedLayouts.sort((a, b) => a.pathPrefix.length - b.pathPrefix.length);

  const server = matchedRoute
    ? (compiled.servers.find((s) => s.path === matchedRoute!.path) ?? null)
    : null;

  // error.tsx は pathname にマッチする**全候補**を深い → 浅い順で返す。Router 側で
  // 「どの layer の error か」に応じて最寄り (leaf) / 外側 (layout) の選び分けを行う。
  const matchedErrors = compiled.errors.filter((e) => e.pattern.test(pathname));
  matchedErrors.sort((a, b) => b.pathPrefix.length - a.pathPrefix.length);

  return {
    route: matchedRoute,
    layouts: matchedLayouts,
    server,
    errors: matchedErrors,
    params,
  };
}

// --- internal helpers ---

function isNotFoundFile(filePath: string): boolean {
  // "./routes/not-found.tsx" もしくは absolute で "/routes/not-found.tsx"
  return filePath.endsWith("/routes/not-found.tsx") || filePath === "./routes/not-found.tsx";
}

// "./routes/users/[id]/index.tsx" → "/users/:id"
function filePathToRoutePath(filePath: string): string {
  // "routes/" 以降を取り出し、"/index.tsx" を落とす
  const afterRoutes = filePath.replace(/^.*?\/routes/, "").replace(/\/index\.tsx$/, "");
  const path = afterRoutes === "" ? "/" : afterRoutes;
  // [name] → :name
  return path.replace(/\[([^\]]+)\]/g, ":$1");
}

// "./routes/users/layout.tsx" → "/users"、"./routes/layout.tsx" → ""
function filePathToLayoutPath(filePath: string): string {
  const afterRoutes = filePath.replace(/^.*?\/routes/, "").replace(/\/layout\.tsx$/, "");
  return afterRoutes.replace(/\[([^\]]+)\]/g, ":$1");
}

// "./routes/users/[id]/server.ts" → "/users/:id"。
// dir が同じ index.tsx と path が一致するように作る (matchRoute の lookup key)。
function filePathToServerPath(filePath: string): string {
  const afterRoutes = filePath.replace(/^.*?\/routes/, "").replace(/\/server\.ts$/, "");
  const path = afterRoutes === "" ? "/" : afterRoutes;
  return path.replace(/\[([^\]]+)\]/g, ":$1");
}

// "./routes/users/error.tsx" → "/users"、"./routes/error.tsx" → "" (root)
function filePathToErrorPath(filePath: string): string {
  const afterRoutes = filePath.replace(/^.*?\/routes/, "").replace(/\/error\.tsx$/, "");
  return afterRoutes.replace(/\[([^\]]+)\]/g, ":$1");
}

// "./routes/users/layout.server.ts" → "/users"、"./routes/layout.server.ts" → "" (root)
// layout.tsx と同じ pathPrefix になるよう意図的に揃える (lookup key として使う)。
function filePathToLayoutServerPath(filePath: string): string {
  const afterRoutes = filePath.replace(/^.*?\/routes/, "").replace(/\/layout\.server\.ts$/, "");
  return afterRoutes.replace(/\[([^\]]+)\]/g, ":$1");
}

// "/users/:id" → RegExp と paramNames (route 用、完全一致)
function pathToPattern(path: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const source = path.replace(/:([^/]+)/g, (_, name: string) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  return { pattern: new RegExp(`^${source}$`), paramNames };
}

// layout は prefix match なので、後続が "/" 始まりか終端で OK。
// root layout (path == "") は全 pathname にマッチさせる。
function layoutPathToPattern(path: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  if (path === "") return { pattern: /^\/.*$/, paramNames };
  const source = path.replace(/:([^/]+)/g, (_, name: string) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  return { pattern: new RegExp(`^${source}(?:/.*)?$`), paramNames };
}
