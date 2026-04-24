import { effect, onCleanup } from "@vidro/core";
import { compileRoutes, matchRoute, type RouteRecord } from "./route-tree";
import { currentPathname } from "./navigation";

type RouterProps = {
  routes: RouteRecord;
};

type RouteModule = { default: (props: Record<string, unknown>) => Node };

/**
 * app 全体のルーティングを司る component。`routes` は `import.meta.glob` の結果を
 * そのまま渡す形式。pathname の変化を subscribe し、マッチした route + 親 layout 群を
 * lazy load して anchor の前に差し込む。
 *
 * render は fold 構造: leaf component を render → 深い layout から浅い layout へ
 * `{ children: prevNode }` を渡しつつ wrap していく。route 切替時は layout を含めて
 * 毎回 remount する (state 保持は別タスク)。
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

    // layouts (親 → 子) + leaf を 1 つの配列にして並列 load。
    const loaders = [...match.layouts.map((l) => l.load), leafLoader];

    void Promise.all(loaders.map((l) => l())).then((mods) => {
      if (token !== loadToken) return; // 古い route の resolve は捨てる

      const modules = mods as RouteModule[];
      const leafMod = modules[modules.length - 1]!;
      const layoutMods = modules.slice(0, -1);

      // leaf を render → 深い layout から浅い layout の順に wrap (fold)。
      // 結果として 親 layout が一番外側に来る DOM tree になる。
      let node: Node = leafMod.default({ params: match.params });
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
