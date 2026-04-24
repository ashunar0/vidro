// routes/ 配下のファイルパスを URL パターンに変換し、pathname → route + layouts の
// match を行う。Vite plugin を挟まず app 側で import.meta.glob を書く形のため、
// 受け取るのは `Record<filePath, () => Promise<Module>>` という最小表現。

type RouteModule = { default: (props?: Record<string, unknown>) => Node };
type RouteLoader = () => Promise<RouteModule>;

// Vite の import.meta.glob は `Record<string, () => Promise<unknown>>` を返すので、
// public 型はそちらに合わせて緩く、内部で RouteLoader としてキャストする。
export type RouteRecord = Record<string, () => Promise<unknown>>;

export type RouteEntry = {
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
  /** layout が適用される path prefix (例: "/users", root layout は "") */
  pathPrefix: string;
  /** pathname がこれにマッチしたら apply する RegExp */
  pattern: RegExp;
  /** capture group の順序に対応する param 名 */
  paramNames: string[];
  /** lazy load 関数 */
  load: RouteLoader;
};

export type CompiledRoutes = {
  routes: RouteEntry[];
  layouts: LayoutEntry[];
  notFound?: RouteLoader;
};

export type MatchResult = {
  /** マッチした leaf route。なければ null (= notFound 行き) */
  route: RouteEntry | null;
  /** 適用される layout 列。浅い → 深い順で並ぶ */
  layouts: LayoutEntry[];
  /** route + layouts の paramNames から抽出した値 */
  params: Record<string, string>;
};

/**
 * import.meta.glob の返り値を受け取り、RouteEntry / LayoutEntry のリストに変換する。
 * - `./routes/index.tsx` → "/"
 * - `./routes/about/index.tsx` → "/about"
 * - `./routes/users/[id]/index.tsx` → "/users/:id"
 * - `./routes/layout.tsx` → root layout (pathPrefix "")
 * - `./routes/users/layout.tsx` → "/users" 配下の layout
 * - `./routes/not-found.tsx` は 404 fallback として特別扱い
 */
export function compileRoutes(modules: RouteRecord): CompiledRoutes {
  const routes: RouteEntry[] = [];
  const layouts: LayoutEntry[] = [];
  let notFound: RouteLoader | undefined;

  for (const [filePath, rawLoad] of Object.entries(modules)) {
    const load = rawLoad as RouteLoader;
    if (isNotFoundFile(filePath)) {
      notFound = load;
      continue;
    }
    if (filePath.endsWith("/layout.tsx")) {
      const pathPrefix = filePathToLayoutPath(filePath);
      const { pattern, paramNames } = layoutPathToPattern(pathPrefix);
      layouts.push({ pathPrefix, pattern, paramNames, load });
      continue;
    }
    if (!filePath.endsWith("/index.tsx")) continue;

    const path = filePathToRoutePath(filePath);
    const { pattern, paramNames } = pathToPattern(path);
    routes.push({ path, pattern, paramNames, load });
  }

  // specificity 順で sort: dynamic segment 少ない route を先にマッチさせる。
  // 例: "/users/new" と "/users/:id" が両方あれば前者が優先。最小版では
  // route 数が少ないので paramNames 数での単純比較で十分。
  routes.sort((a, b) => a.paramNames.length - b.paramNames.length);

  return { routes, layouts, notFound };
}

/**
 * pathname を compiled routes と突き合わせ、マッチした route と適用 layouts を返す。
 * route が見つからない (notFound 行き) ケースでも layouts は collect される。
 * これにより 404 page も root layout で wrap されて表示される。
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

  return { route: matchedRoute, layouts: matchedLayouts, params };
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
