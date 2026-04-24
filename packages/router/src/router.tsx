import { effect, ErrorBoundary, getRenderer, onCleanup, signal } from "@vidro/core";
import {
  compileRoutes,
  matchRoute,
  type CompiledRoutes,
  type MatchResult,
  type RouteRecord,
} from "./route-tree";
import { currentPathname } from "./navigation";

// ---- bootstrap data (Phase A SSR data injection) ----
// server (createServerHandler) が navigation response の index.html に
// `<script type="application/json" id="__vidro_data">` として埋め込んだ
// 初期 loader data を module load 時に 1 回だけ取り出す。最初の render で
// consume し、以降の navigation では従来通り /__loader を fetch する。
type BootstrapLayer = { data?: unknown; error?: { name: string; message: string; stack?: string } };
type BootstrapData = { pathname: string; params: Record<string, string>; layers: BootstrapLayer[] };

let bootstrapData: BootstrapData | null = readBootstrapData();

function readBootstrapData(): BootstrapData | null {
  if (typeof document === "undefined") return null;
  const el = document.getElementById("__vidro_data");
  if (!el || !el.textContent) return null;
  try {
    const parsed = JSON.parse(el.textContent) as {
      params: Record<string, string>;
      layers: BootstrapLayer[];
    };
    const pathname = window.location.pathname;
    // consume: 同じデータを 2 度使わないよう DOM からも剥がす。
    el.remove();
    return { pathname, params: parsed.params, layers: parsed.layers };
  } catch {
    el.remove();
    return null;
  }
}

// ---- SSR (Phase B) 用型 ----
// server で Router を renderToString するとき、dynamic import は sync 化できないので
// 呼び側 (createServerHandler 等) が `preloadRouteComponents` で事前に全 module を
// 解決し、`resolvedModules` として Router に注入する。Router はこれを受けたら
// effect を張らず、sync に fold して Node tree を返す。
//
// bootstrapData は Phase A と同形式。server 側で gatherRouteData した結果を
// そのまま渡せる。
type RouteModule = { default: (props: Record<string, unknown>) => Node };
type ErrorModule = {
  default: (props: { error: unknown; reset: () => void; params: Record<string, string> }) => Node;
};

export type ResolvedModules = {
  /** leaf route の module。not-found 時は null */
  route: RouteModule | null;
  /** 浅い → 深い順の layout modules (match.layouts と同じ順序) */
  layouts: RouteModule[];
  /** 深い → 浅い順の error.tsx modules (match.errors と同じ順序)。個別 null は許容 */
  errors: Array<ErrorModule | null>;
};

export type SSRProps = {
  /** server 側で gatherRouteData した結果 (pathname / params / layers を含む) */
  bootstrapData: BootstrapData;
  /** preloadRouteComponents で事前解決した component 群 */
  resolvedModules: ResolvedModules;
};

type RouterProps = {
  routes: RouteRecord;
  /** server-side pre-render mode。渡されると Router は sync fold して Node を返す。 */
  ssr?: SSRProps;
};

/**
 * app 全体のルーティングを司る component。`routes` は `import.meta.glob` の結果を
 * そのまま渡す形式 (index.tsx / layout.tsx / server.ts / layout.server.ts /
 * error.tsx / not-found.tsx)。
 *
 * client mode (default): pathname の変化を subscribe し、マッチした route + 親 layout
 * 群 + 各 layer の loader + pathname に match する全 error.tsx を lazy load。各 load
 * は Promise.all で並列実行 (Remix 式 data fetching、設計書 3.7)。
 *
 * server mode (`ssr` prop あり): 呼び側が preloadRouteComponents で解決済み modules を
 * 注入するので effect を張らず、sync fold で Node tree を返す。renderToString から
 * 呼ぶのが前提で、navigation も popstate subscribe も発生しない (ADR 0017)。
 *
 * render は fold 構造: leaf + 各 layout を個別に `ErrorBoundary` で wrap しながら
 * 深い → 浅い順に `{ data, children: prev }` で畳む。layer ごとの ErrorBoundary
 * fallback は「その layer より外側の error.tsx」で切り替わる。
 *
 * error 処理 (ADR 0010、層別伝播版):
 * - **loader error** (async): 並列実行後に各 layer の error を検査、最も外側 (浅い
 *   index) を採用。その layer の位置を「その layer より外側の error.tsx」で置換、
 *   error layer より外側の layouts は正常 render、内側 (layouts + leaf) は mount
 *   しない。leaf loader error は最寄り (自分を含む深い側) の error.tsx を使う。
 * - **render error** (sync): leaf + 各 layout を `ErrorBoundary` で wrap。layer
 *   単位で catch され、fallback はそれぞれ「自 layer より外側の error.tsx」を呼び出す
 *   (leaf は最寄り)。layout render error でも外側 layouts は維持される。
 * - **error.tsx の選び分け**: `selectErrorMod(layerPathPrefix)`。leaf (null) なら
 *   最寄り (match.errors[0])、layout なら `pathPrefix < layerPathPrefix` を満たす
 *   最深。match.errors は深い → 浅い順なので `find` 相当の線形走査で良い。
 * - **error.tsx なし**: 素朴な default ("Error: <message>") を表示。
 * - **reset()**: 内部 reloadCounter を increment して effect を再実行。server mode
 *   では reset は no-op (次回 navigation は client が行う)。
 */
export function Router(props: RouterProps): Node {
  const compiled = compileRoutes(props.routes);

  // server mode: sync fold → 直接 Node を返す。DOM / window 系に触らない。
  if (props.ssr) {
    return renderServerSide(compiled, props.ssr);
  }

  // --- client mode ---
  const r = getRenderer();

  // popstate (戻る/進む) で pathname signal を同期。Router が mount されてる間だけ
  // listener を張り、dispose で剥がす。
  const onPopState = () => {
    currentPathname.value = window.location.pathname;
  };
  window.addEventListener("popstate", onPopState);
  onCleanup(() => window.removeEventListener("popstate", onPopState));

  // Show と同じ anchor パターン: DocumentFragment に Comment アンカーを仕込んで
  // append 時に親 DOM に散らす。anchor の前 (insertBefore) に現在の route node を置く。
  const anchor = r.createComment("router");
  const fragment = r.createFragment();
  r.appendChild(fragment, anchor);

  // 前回 mount した DOM Node 群。swap で一斉に剥がすため配列で保持する。DocumentFragment
  // を swap の引数で受け取ったケース (最外側が ErrorBoundary の fragment など) に備え、
  // insertBefore 前に fragment の子 Node 一覧を吸い出して記録する (fragment は
  // insertBefore 時点で空になるため、後で removeChild できない)。
  let currentNodes: Node[] = [];
  // route 切替時の stale resolve 対策: token が一致した resolve のみ DOM に反映。
  let loadToken = 0;

  // reset() で effect を再実行するための trigger。currentPathname の同値 set だと
  // signal が notify しないので、別軸で reload trigger を持つ。
  const reloadCounter = signal(0);
  const reset = (): void => {
    reloadCounter.value += 1;
  };

  function swap(next: Node): void {
    for (const node of currentNodes) {
      node.parentNode?.removeChild(node);
    }
    // fragment は insertBefore 時に展開されて空になるので、child Node を先に記録。
    // 単一 Node (text / element) の場合は自分自身を 1 要素配列として記録。
    const nextNodes: Node[] =
      next.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? Array.from(next.childNodes) : [next];
    (anchor as unknown as Node).parentNode?.insertBefore(next, anchor as unknown as Node);
    currentNodes = nextNodes;
  }

  // `/__loader?path=...` を叩いて全 layer の loader 結果を 1 回の HTTP で取得する
  // (Remix 式 RPC)。server 側 (@vidro/plugin の serverBoundary) が layer 並列実行を
  // 肩代わりするので、ここでの Promise.all は 1 系列だけで済む。
  // response shape: `{ params, layers: [{ data? , error? SerializedError }, ...] }`。
  // error は serialize された plain object で来るため、Error-like に hydrate し直して
  // 既存の err.message / err.stack 依存コードを動かす。
  //
  // Phase A bootstrap: 初回 navigation だけ、server が index.html に inline した
  // `__vidro_data` を使って fetch を skip する。pathname 一致を確認したうえで
  // consume し、以降は HTTP 経路に戻る。
  async function fetchLoaders(pathname: string): Promise<Array<{ data: unknown; error: unknown }>> {
    if (bootstrapData && bootstrapData.pathname === pathname) {
      const boot = bootstrapData;
      bootstrapData = null;
      return boot.layers.map((r) => ({
        data: r.data,
        error: r.error ? hydrateError(r.error) : undefined,
      }));
    }

    const res = await fetch(`/__loader?path=${encodeURIComponent(pathname)}`);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      // endpoint 自体が 4xx/5xx → 復旧できないので outer catch (default error) へ
      throw hydrateError(body.error ?? { message: `HTTP ${res.status}` });
    }
    const body = (await res.json()) as {
      params: Record<string, string>;
      layers: Array<{ data?: unknown; error?: { name: string; message: string; stack?: string } }>;
    };
    return body.layers.map((r) => ({
      data: r.data,
      error: r.error ? hydrateError(r.error) : undefined,
    }));
  }

  effect(() => {
    // reload trigger を dependency に登録 (reset() で再実行されるため)。
    // `void` は「副作用として読むだけ」の意図表明 (lint の no-unused-expressions 回避)。
    void reloadCounter.value;
    const pathname = currentPathname.value;
    const match = matchRoute(pathname, compiled);
    const token = ++loadToken;

    const leafLoader = match.route ? match.route.load : compiled.notFound;
    if (!leafLoader) {
      // not-found.tsx なし、かつ route match なし → 素朴にテキスト
      swap(r.createText("404 Not Found") as unknown as Node);
      return;
    }

    // 3 系列を同時起動して Promise.all:
    //   1. component modules (layouts + leaf の .tsx)
    //   2. loader 実行結果 (server の /__loader endpoint から bulk 取得)
    //   3. 全 error.tsx modules (層ごとの選び分けのため preload)
    // 並列 fetch の本体は server 側 (plugin の serverBoundary が Promise.all で
    // layer 並列実行する)。client は HTTP 1 回だけで、waterfall にならない。
    const loadComponents = Promise.all([...match.layouts.map((l) => l.load()), leafLoader()]);
    const loadLoaderResults = fetchLoaders(pathname);
    // match.errors[i] と errorMods[i] は 1:1 対応 (深い → 浅い順)。個別 load 失敗は
    // null に fall back させ、selectErrorMod が自然に次の候補に skip する。
    const loadErrorMods = Promise.all(
      match.errors.map((e) => (e.load() as Promise<ErrorModule>).catch(() => null)),
    );

    void Promise.all([loadComponents, loadLoaderResults, loadErrorMods])
      .then(([rawMods, loaderResults, errorMods]) => {
        if (token !== loadToken) return;
        const componentMods = rawMods as RouteModule[];
        const node = foldRouteTree({
          match,
          componentMods,
          loaderResults,
          errorMods,
          reset,
        });
        swap(node);
      })
      .catch((err) => {
        // component module の load 失敗 (network failure 等)。error.tsx modules の
        // load 失敗は個別に null に吸収されてるので、ここに来るのは component module
        // load 失敗が主。loader throw は runServerLoader で吸い込み済み。
        if (token !== loadToken) return;
        console.error("[router] module load error:", err);
        swap(defaultErrorNode(err));
      });
  });

  onCleanup(() => {
    for (const node of currentNodes) {
      node.parentNode?.removeChild(node);
    }
    currentNodes = [];
    (anchor as unknown as Node).parentNode?.removeChild(anchor as unknown as Node);
  });

  return fragment;
}

// ---- server-mode entry (ADR 0017) ----
// `preloadRouteComponents` + `gatherRouteData` で事前解決した材料を使って、
// client mode と同じ foldRouteTree で sync に tree を組む。effect / popstate /
// fetch / DocumentFragment は一切使わない (renderToString 用)。
//
// leaf module は `ssr.resolvedModules.route` に pre-load 済み (matched route or
// not-found.tsx どちらか)。null の場合は「route 無し & not-found.tsx も無し」と
// 解釈して client mode と同じ 404 text を返す。
function renderServerSide(compiled: CompiledRoutes, ssr: SSRProps): Node {
  const match = matchRoute(ssr.bootstrapData.pathname, compiled);

  if (!ssr.resolvedModules.route) {
    return getRenderer().createText("404 Not Found") as unknown as Node;
  }

  // loader 結果を client mode と同じ shape に整える (hydrateError で Error に復元)
  const loaderResults = ssr.bootstrapData.layers.map((l) => ({
    data: l.data,
    error: l.error ? hydrateError(l.error) : undefined,
  }));

  return foldRouteTree({
    match,
    componentMods: ssr.resolvedModules.layouts.concat([ssr.resolvedModules.route]),
    loaderResults,
    errorMods: ssr.resolvedModules.errors,
    reset: () => {
      // server では reset 発火不可。client hydration で再発火する前提。
    },
  });
}

// ---- fold logic (client / server 共通) ----
// 解決済みの (match, componentMods, loaderResults, errorMods) を受け取って、
// layer error 検査 + ErrorBoundary wrap + layout fold を行い Node を返す pure 関数。
type FoldInput = {
  match: MatchResult;
  componentMods: RouteModule[];
  loaderResults: Array<{ data: unknown; error: unknown }>;
  errorMods: Array<ErrorModule | null>;
  reset: () => void;
};

function foldRouteTree(input: FoldInput): Node {
  const { match, componentMods, loaderResults, errorMods, reset } = input;

  // layer の pathPrefix (null = leaf) に応じて使う error.tsx を選ぶ。
  //   leaf → 最寄り (match.errors[0])
  //   layout[i] → pathPrefix < layerPathPrefix を満たす最深 (= errors の中で
  //              最初に該当するもの。match.errors が深い → 浅い順なので OK)
  const selectErrorMod = (layerPathPrefix: string | null): ErrorModule | null => {
    if (layerPathPrefix === null) return errorMods[0] ?? null;
    for (let i = 0; i < match.errors.length; i++) {
      if (match.errors[i]!.pathPrefix.length < layerPathPrefix.length) {
        return errorMods[i] ?? null;
      }
    }
    return null;
  };

  // layout を ErrorBoundary で wrap し、render error 時にその layer より外側の
  // error.tsx で置き換える。children を引数として closure に凍結するのは、
  // 呼び側 (fold ループ) で `node` 変数が次のループで上書きされるのを防ぐため。
  const wrapLayout = (
    layoutMod: RouteModule,
    layerPathPrefix: string,
    data: unknown,
    children: Node,
  ): Node =>
    ErrorBoundary({
      fallback: (err) => renderError(err, selectErrorMod(layerPathPrefix), match.params, reset),
      onError: (err) => console.error("[router] layout render error:", err),
      children: () => layoutMod.default({ params: match.params, data, children }),
    });

  // loader error を layer 単位で検査。最も外側 (最小 index) を採用し、その
  // layer 以降 (内側 layouts + leaf) を切り捨てる。
  let errorIndex = -1;
  let loaderError: unknown;
  for (let i = 0; i < loaderResults.length; i++) {
    if (loaderResults[i]!.error !== undefined) {
      errorIndex = i;
      loaderError = loaderResults[i]!.error;
      break;
    }
  }

  let node: Node;
  if (errorIndex !== -1) {
    // errorIndex が layouts.length なら leaf loader error → 最寄り (null)
    // それ以外は layout[errorIndex] の pathPrefix より外側の error.tsx を使う
    const errorLayerPrefix =
      errorIndex < match.layouts.length ? match.layouts[errorIndex]!.pathPrefix : null;
    node = renderError(loaderError, selectErrorMod(errorLayerPrefix), match.params, reset);
    // error layer より外側の layouts で fold。外側 layouts も render error を
    // 起こしうるので wrapLayout で個別 ErrorBoundary wrap する。
    for (let i = errorIndex - 1; i >= 0; i--) {
      node = wrapLayout(
        componentMods[i]!,
        match.layouts[i]!.pathPrefix,
        loaderResults[i]!.data,
        node,
      );
    }
  } else {
    // 全 loader 成功 → 通常経路。leaf は render error catch のため ErrorBoundary
    // で wrap (fallback は最寄り)、各 layout は wrapLayout で外側 error.tsx。
    const leafMod = componentMods[componentMods.length - 1]!;
    const leafData = loaderResults[loaderResults.length - 1]!.data;
    const layoutMods = componentMods.slice(0, -1);

    node = ErrorBoundary({
      fallback: (err) => renderError(err, selectErrorMod(null), match.params, reset),
      onError: (err) => console.error("[router] render error:", err),
      children: () => leafMod.default({ params: match.params, data: leafData }),
    });
    for (let i = layoutMods.length - 1; i >= 0; i--) {
      node = wrapLayout(layoutMods[i]!, match.layouts[i]!.pathPrefix, loaderResults[i]!.data, node);
    }
  }
  return node;
}

// ---- error helpers (renderer 経由) ----

function defaultErrorNode(err: unknown): Node {
  const r = getRenderer();
  const div = r.createElement("div");
  const text = r.createText(`Error: ${err instanceof Error ? err.message : String(err)}`);
  r.appendChild(div, text);
  return div as unknown as Node;
}

function renderError(
  err: unknown,
  errorMod: ErrorModule | null,
  params: Record<string, string>,
  reset: () => void,
): Node {
  if (errorMod) return errorMod.default({ error: err, reset, params });
  return defaultErrorNode(err);
}

// plain object → Error。server 側から JSON で来た `{ name, message, stack }` を
// Error インスタンスに復元することで、既存 ErrorBoundary / renderError の
// `err.message` / `err instanceof Error` 依存を満たす。
function hydrateError(raw: unknown): Error {
  if (raw && typeof raw === "object" && "message" in raw) {
    const obj = raw as { name?: string; message?: string; stack?: string };
    const err = new Error(obj.message ?? "Unknown error");
    if (obj.name) err.name = obj.name;
    if (obj.stack) err.stack = obj.stack;
    return err;
  }
  return new Error(String(raw));
}
