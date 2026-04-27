import { _$dynamicChild, h } from "@vidro/core";
import { navigate } from "./navigation";

type LinkProps = {
  href: string;
  // core の JSX.ElementChildrenAttribute に揃えて unknown で受ける (text / Node / array の混在)
  children?: unknown;
  class?: string;
};

/**
 * SPA 遷移用の `<a>` ラッパー。左クリックのみ preventDefault して navigate() に委譲し、
 * Ctrl/Cmd/Shift/Alt 併用やミドルクリックはブラウザ標準の挙動 (新タブ等) に任せる。
 *
 * 実装は vanilla `h(...)` + `_$dynamicChild(...)`。`<a>{props.children}</a>` の JSX
 * を書きたいところだが、`@vidro/router` の build 時には `@vidro/plugin` の jsxTransform
 * が掛かっていない (toy 段階の build 構成)。jsxTransform を経由しないと `{props.children}`
 * が `_$dynamicChild` で wrap されず、`createElement("a")` が `createText` より先に
 * 評価されて post-order を破る。HydrationRenderer の cursor がズレるので、ここでは
 * 手書き形式で post-order を保証する (B-3d)。
 */
export function Link(props: LinkProps): Node {
  const handleClick = (e: MouseEvent) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (e.button !== 0) return;
    e.preventDefault();
    navigate(props.href);
  };

  return h(
    "a",
    { href: props.href, class: props.class, onClick: handleClick },
    _$dynamicChild(() => props.children),
  );
}
