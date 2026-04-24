// routes/ 配下のファイルパスを URL パターンに変換し、pathname → route の match を行う。
// Vite plugin を挟まず app 側で import.meta.glob を書く形のため、
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

export type CompiledRoutes = {
  routes: RouteEntry[];
  notFound?: RouteLoader;
};

export type MatchResult = {
  route: RouteEntry | null;
  params: Record<string, string>;
};

/**
 * import.meta.glob の返り値を受け取り、RouteEntry のリストに変換する。
 * - `./routes/index.tsx` → "/"
 * - `./routes/about/index.tsx` → "/about"
 * - `./routes/users/[id]/index.tsx` → "/users/:id"
 * - `./routes/not-found.tsx` は 404 fallback として特別扱い
 * - それ以外の `.tsx` (`index.tsx` でもなく `not-found.tsx` でもない) は無視
 */
export function compileRoutes(modules: RouteRecord): CompiledRoutes {
  const routes: RouteEntry[] = [];
  let notFound: RouteLoader | undefined;

  for (const [filePath, rawLoad] of Object.entries(modules)) {
    const load = rawLoad as RouteLoader;
    if (isNotFoundFile(filePath)) {
      notFound = load;
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

  return { routes, notFound };
}

/** pathname を compiled routes と突き合わせ、最初にマッチした route を返す。 */
export function matchRoute(pathname: string, compiled: CompiledRoutes): MatchResult {
  for (const route of compiled.routes) {
    const m = pathname.match(route.pattern);
    if (!m) continue;
    const params: Record<string, string> = {};
    for (let i = 0; i < route.paramNames.length; i++) {
      params[route.paramNames[i]!] = m[i + 1]!;
    }
    return { route, params };
  }
  return { route: null, params: {} };
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

// "/users/:id" → RegExp と paramNames
function pathToPattern(path: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const source = path.replace(/:([^/]+)/g, (_, name: string) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  return { pattern: new RegExp(`^${source}$`), paramNames };
}
