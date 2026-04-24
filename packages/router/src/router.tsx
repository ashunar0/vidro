import { effect, onCleanup } from "@vidro/core";
import { compileRoutes, matchRoute, type RouteRecord } from "./route-tree";
import { currentPathname } from "./navigation";

type RouterProps = {
  routes: RouteRecord;
};

/**
 * app 全体のルーティングを司る component。`routes` は `import.meta.glob` の結果を
 * そのまま渡す形式。pathname の変化を subscribe し、マッチした route を lazy load
 * して anchor の前に差し込む。layout nesting / data fetching は最小版では非対応。
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

    const loader = match.route ? match.route.load : compiled.notFound;
    if (!loader) {
      // not-found.tsx なし、かつ match なし → プレーンテキストでお茶を濁す
      swap(document.createTextNode("404 Not Found"));
      return;
    }

    void loader().then((mod) => {
      if (token !== loadToken) return; // 古い route の resolve は捨てる
      const node = mod.default({ params: match.params });
      swap(node);
    });
  });

  onCleanup(() => {
    if (currentNode) currentNode.parentNode?.removeChild(currentNode);
    anchor.parentNode?.removeChild(anchor);
  });

  return fragment;
}
