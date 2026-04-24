import { effect, ErrorBoundary, onCleanup, signal } from "@vidro/core";
import { compileRoutes, matchRoute, type RouteRecord } from "./route-tree";
import { currentPathname } from "./navigation";

type RouterProps = {
  routes: RouteRecord;
};

type RouteModule = { default: (props: Record<string, unknown>) => Node };
type ServerModule = {
  loader?: (args: { params: Record<string, string> }) => Promise<unknown>;
};
type ErrorModule = {
  default: (props: { error: unknown; reset: () => void; params: Record<string, string> }) => Node;
};

/**
 * app 全体のルーティングを司る component。`routes` は `import.meta.glob` の結果を
 * そのまま渡す形式 (index.tsx / layout.tsx / server.ts / error.tsx / not-found.tsx)。
 *
 * pathname の変化を subscribe し、マッチした route + 親 layout 群 + 同 dir の
 * server.ts (loader) + 最寄りの error.tsx を lazy load。loader があれば実行して
 * `data` を抽出し、leaf component の props に `{ params, data }` として渡す。
 *
 * render は fold 構造: leaf を ErrorBoundary で wrap (render error 用) → 深い
 * layout から浅い layout の順に `{ children: prev }` で wrap していく。layouts
 * は今のところ loader を持たない (Phase 3 第 2 弾で並列 fetch + layout loader)。
 *
 * error 処理:
 * - **loader error** (async): Promise を try/catch して、leaf の代わりに最寄り
 *   error.tsx を render。layouts は外側に維持。
 * - **render error** (sync, component throw): leaf を ErrorBoundary で wrap し、
 *   fallback で error.tsx を render。
 * - **error.tsx なし**: 素朴な default ("Error: <message>") を表示。
 * - **reset()**: 内部 reloadCounter を increment して effect を再実行 → 同 pathname
 *   で loader + render が走り直す (Solid ErrorBoundary の reset と同じ思想)。
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

    // layouts (親 → 子) + leaf を 1 つの配列にして並列 load。server / error も
    // 独立して並列 load。errorMod 自体の load 失敗は default 表示に fall back。
    const moduleLoaders = [...match.layouts.map((l) => l.load), leafLoader];
    const loadModules = Promise.all(moduleLoaders.map((l) => l()));
    const loadServer = match.server ? match.server.load() : Promise.resolve(null);
    const loadErrorMod: Promise<ErrorModule | null> = match.error
      ? (match.error.load() as Promise<ErrorModule>).catch(() => null)
      : Promise.resolve(null);

    void Promise.all([loadModules, loadServer, loadErrorMod])
      .then(async ([mods, serverMod, errorMod]) => {
        if (token !== loadToken) return;

        // loader 実行 (あれば)。throw された場合は loaderError に格納し、後段で
        // error.tsx に流す。data は undefined のまま。
        let data: unknown;
        let loaderError: unknown;
        if (serverMod && (serverMod as ServerModule).loader) {
          try {
            data = await (serverMod as ServerModule).loader!({ params: match.params });
          } catch (err) {
            loaderError = err;
          }
          if (token !== loadToken) return;
        }

        const modules = mods as RouteModule[];
        const leafMod = modules[modules.length - 1]!;
        const layoutMods = modules.slice(0, -1);

        // leaf 部分の Node を作る。loader error があれば error.tsx を、無ければ
        // ErrorBoundary で wrap した leaf component を使う (render error catch 用)。
        let leafNode: Node;
        if (loaderError !== undefined) {
          leafNode = renderError(loaderError, errorMod, match.params);
        } else {
          leafNode = ErrorBoundary({
            fallback: (err) => renderError(err, errorMod, match.params),
            onError: (err) => console.error("[router] render error:", err),
            children: () => leafMod.default({ params: match.params, data }),
          });
        }

        // 深い layout から浅い layout の順に wrap (fold)。loader error の場合も
        // layouts は外側に維持される (Remix / SvelteKit と同じ挙動)。
        let node: Node = leafNode;
        for (let i = layoutMods.length - 1; i >= 0; i--) {
          node = layoutMods[i]!.default({ params: match.params, children: node });
        }
        swap(node);
      })
      .catch((err) => {
        // module 自体の load 失敗 (network failure 等)。error.tsx も含めて
        // load 失敗の可能性があるので、素朴な default 表示に fall back。
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
