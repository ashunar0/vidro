import { effect, ErrorBoundary, onCleanup, signal } from "@vidro/core";
import {
  compileRoutes,
  matchRoute,
  type RouteRecord,
  type ServerModule,
  type ServerModuleLoader,
} from "./route-tree";
import { currentPathname } from "./navigation";

type RouterProps = {
  routes: RouteRecord;
};

type RouteModule = { default: (props: Record<string, unknown>) => Node };
type ErrorModule = {
  default: (props: { error: unknown; reset: () => void; params: Record<string, string> }) => Node;
};

/**
 * app 全体のルーティングを司る component。`routes` は `import.meta.glob` の結果を
 * そのまま渡す形式 (index.tsx / layout.tsx / server.ts / layout.server.ts /
 * error.tsx / not-found.tsx)。
 *
 * pathname の変化を subscribe し、マッチした route + 親 layout 群 + 各 layer の
 * loader (server.ts / layout.server.ts) + 最寄りの error.tsx を lazy load。
 * leaf + 全 layout の loader は **Promise.all で並列実行** し、waterfall を避ける
 * (Remix 的 data fetching、設計書 3.7)。各 layer の data は対応する layout / leaf
 * の props.data として配られる。
 *
 * render は fold 構造: leaf を ErrorBoundary で wrap (render error 用) → 深い
 * layout から浅い layout の順に `{ data, children: prev }` で wrap していく。
 *
 * error 処理:
 * - **loader error** (async): 並列実行後に各 layer の error を検査し、最も外側
 *   (浅い index) の error を採用。その layer 以降 (内側 layouts + leaf) を最寄り
 *   error.tsx で置き換え、それより外側の layouts は正常 render。
 *   (MVP 方針: 本来は「error を起こした layer より外側の error.tsx」を使うべき。
 *    ADR 0009 参照。Phase 3 第 3 弾で階層伝播を正しく実装する)
 * - **render error** (sync, leaf component throw): leaf を ErrorBoundary で wrap、
 *   fallback で error.tsx を render。layout の render error は今は catch しない。
 * - **error.tsx なし**: 素朴な default ("Error: <message>") を表示。
 * - **reset()**: 内部 reloadCounter を increment して effect を再実行。
 */
export function Router(props: RouterProps): Node {
  const compiled = compileRoutes(props.routes);

  // popstate (戻る/進む) で pathname signal を同期。Router が mount されてる間だけ
  // listener を張り、dispose で剥がす。
  const onPopState = () => {
    currentPathname.value = window.location.pathname;
  };
  window.addEventListener("popstate", onPopState);
  onCleanup(() => window.removeEventListener("popstate", onPopState));

  // Show と同じ anchor パターン: DocumentFragment に Comment アンカーを仕込んで
  // append 時に親 DOM に散らす。anchor の前 (insertBefore) に現在の route node を置く。
  const anchor = document.createComment("router");
  const fragment = document.createDocumentFragment();
  fragment.appendChild(anchor);

  let currentNode: Node | null = null;
  // route 切替時の stale resolve 対策: token が一致した resolve のみ DOM に反映。
  let loadToken = 0;

  // reset() で effect を再実行するための trigger。currentPathname の同値 set だと
  // signal が notify しないので、別軸で reload trigger を持つ。
  const reloadCounter = signal(0);
  const reset = (): void => {
    reloadCounter.value += 1;
  };

  function swap(next: Node): void {
    if (currentNode) currentNode.parentNode?.removeChild(currentNode);
    anchor.parentNode?.insertBefore(next, anchor);
    currentNode = next;
  }

  function defaultErrorNode(err: unknown): Node {
    const div = document.createElement("div");
    div.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    return div;
  }

  function renderError(
    err: unknown,
    errorMod: ErrorModule | null,
    params: Record<string, string>,
  ): Node {
    if (errorMod) return errorMod.default({ error: err, reset, params });
    return defaultErrorNode(err);
  }

  // server.ts / layout.server.ts を 1 layer 分 load → loader があれば実行。
  // module load 失敗も loader throw も一様に error として扱うことで、呼び側の
  // エラー処理が 1 箇所にまとまる。
  async function runServerLoader(
    loadFn: ServerModuleLoader | null,
    params: Record<string, string>,
  ): Promise<{ data: unknown; error: unknown }> {
    if (!loadFn) return { data: undefined, error: undefined };
    try {
      const mod = (await loadFn()) as ServerModule;
      if (!mod.loader) return { data: undefined, error: undefined };
      const data = await mod.loader({ params });
      return { data, error: undefined };
    } catch (err) {
      return { data: undefined, error: err };
    }
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
      swap(document.createTextNode("404 Not Found"));
      return;
    }

    // 3 系列を同時起動して Promise.all:
    //   1. component modules (layouts + leaf の .tsx)
    //   2. loader 実行結果 (layouts の layout.server.ts + leaf の server.ts を並列)
    //   3. error.tsx module
    // loader 群は「並列 fetch」の本体。layer 間で独立に走るので waterfall にならない。
    const loadComponents = Promise.all([...match.layouts.map((l) => l.load()), leafLoader()]);
    const loadLoaderResults = Promise.all([
      ...match.layouts.map((l) => runServerLoader(l.serverLoad, match.params)),
      runServerLoader(match.server ? match.server.load : null, match.params),
    ]);
    const loadErrorMod: Promise<ErrorModule | null> = match.error
      ? (match.error.load() as Promise<ErrorModule>).catch(() => null)
      : Promise.resolve(null);

    void Promise.all([loadComponents, loadLoaderResults, loadErrorMod])
      .then(([rawMods, loaderResults, errorMod]) => {
        if (token !== loadToken) return;

        const componentMods = rawMods as RouteModule[];
        // loaderResults[i] は layouts[i] に、最後の要素が leaf に対応する。
        // 最も外側 (浅い index) の error を拾って、その layer 以降を切り捨てる。
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
          // 該当 layer の位置を error.tsx (or default) で置き換え、外側の layouts
          // だけで fold する。error layer の内側 (layouts + leaf) はマウントしない。
          node = renderError(loaderError, errorMod, match.params);
          for (let i = errorIndex - 1; i >= 0; i--) {
            const layoutMod = componentMods[i]!;
            node = layoutMod.default({
              params: match.params,
              data: loaderResults[i]!.data,
              children: node,
            });
          }
        } else {
          // 全 loader 成功 → 通常経路。leaf は render error catch のため
          // ErrorBoundary で wrap、全 layouts で fold する。
          const leafMod = componentMods[componentMods.length - 1]!;
          const leafData = loaderResults[loaderResults.length - 1]!.data;
          const layoutMods = componentMods.slice(0, -1);

          node = ErrorBoundary({
            fallback: (err) => renderError(err, errorMod, match.params),
            onError: (err) => console.error("[router] render error:", err),
            children: () => leafMod.default({ params: match.params, data: leafData }),
          });
          for (let i = layoutMods.length - 1; i >= 0; i--) {
            node = layoutMods[i]!.default({
              params: match.params,
              data: loaderResults[i]!.data,
              children: node,
            });
          }
        }
        swap(node);
      })
      .catch((err) => {
        // component module 自体の load 失敗 (network failure 等)。error.tsx も含め
        // て load 失敗の可能性があるので、素朴な default 表示に fall back。loader
        // 側は runServerLoader で吸い込まれているので、ここに来るのは component
        // module load か error module load 失敗のケース。
        if (token !== loadToken) return;
        console.error("[router] module load error:", err);
        swap(defaultErrorNode(err));
      });
  });

  onCleanup(() => {
    if (currentNode) currentNode.parentNode?.removeChild(currentNode);
    anchor.parentNode?.removeChild(anchor);
  });

  return fragment;
}
