import { effect, onCleanup } from "@vidro/core";
import { compileRoutes, matchRoute, type RouteRecord } from "./route-tree";
import { currentPathname } from "./navigation";

type RouterProps = {
  routes: RouteRecord;
};

type RouteModule = { default: (props: Record<string, unknown>) => Node };
type ServerModule = {
  loader?: (args: { params: Record<string, string> }) => Promise<unknown>;
};

/**
 * app 全体のルーティングを司る component。`routes` は `import.meta.glob` の結果を
 * そのまま渡す形式 (index.tsx / layout.tsx / server.ts / not-found.tsx を含む)。
 *
 * pathname の変化を subscribe し、マッチした route + 親 layout 群 + 同 dir の
 * server.ts (loader) を lazy load。loader があれば実行して `data` を抽出し、
 * leaf component の props に `{ params, data }` として渡す。layout は今のところ
 * loader を持たない (Phase 3 第 2 弾)。
 *
 * render は fold 構造: leaf component を render → 深い layout から浅い layout へ
 * `{ children: prevNode }` を渡しつつ wrap していく。route 切替時は layout も
 * 含めて毎回 remount する (state 保持は別タスク)。
 *
 * loader 実行中の placeholder と error boundary は別タスク。最小版では loader
 * の resolve を待ってから一括 swap、reject はそのまま throw に任せる。
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

  function swap(next: Node): void {
    if (currentNode) currentNode.parentNode?.removeChild(currentNode);
    anchor.parentNode?.insertBefore(next, anchor);
    currentNode = next;
  }

  effect(() => {
    const pathname = currentPathname.value;
    const match = matchRoute(pathname, compiled);
    const token = ++loadToken;

    const leafLoader = match.route ? match.route.load : compiled.notFound;
    if (!leafLoader) {
      // not-found.tsx なし、かつ route match なし → 素朴にテキスト
      swap(document.createTextNode("404 Not Found"));
      return;
    }

    // layouts (親 → 子) + leaf を 1 つの配列にして並列 load。server module は
    // 別軸 (component module ではない) なので独立して load する。loader の実行は
    // server module が解決してから。
    const moduleLoaders = [...match.layouts.map((l) => l.load), leafLoader];
    const loadModules = Promise.all(moduleLoaders.map((l) => l()));
    const loadServer = match.server ? match.server.load() : Promise.resolve(null);

    void Promise.all([loadModules, loadServer]).then(async ([mods, serverMod]) => {
      if (token !== loadToken) return;

      // server があり loader が定義されてれば実行。戻り値を data として保持。
      // loader 自体が async なので、ここでさらに await が入る。
      let data: unknown;
      if (serverMod && (serverMod as ServerModule).loader) {
        data = await (serverMod as ServerModule).loader!({ params: match.params });
        if (token !== loadToken) return;
      }

      const modules = mods as RouteModule[];
      const leafMod = modules[modules.length - 1]!;
      const layoutMods = modules.slice(0, -1);

      // leaf を render → 深い layout から浅い layout の順に wrap (fold)。
      // 結果として 親 layout が一番外側に来る DOM tree になる。
      // data が undefined のケース (server.ts なし) でも leaf に props として
      // 渡すが、component の signature が引数省略なら関数 contravariance で無視される。
      let node: Node = leafMod.default({ params: match.params, data });
      for (let i = layoutMods.length - 1; i >= 0; i--) {
        node = layoutMods[i]!.default({ params: match.params, children: node });
      }
      swap(node);
    });
  });

  onCleanup(() => {
    if (currentNode) currentNode.parentNode?.removeChild(currentNode);
    anchor.parentNode?.removeChild(anchor);
  });

  return fragment;
}
