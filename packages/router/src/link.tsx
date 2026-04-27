import { _$dynamicChild, effect, getRenderer, h } from "@vidro/core";
import { currentPathname, navigate } from "./navigation";

type LinkProps = {
  href: string;
  // core の JSX.ElementChildrenAttribute に揃えて unknown で受ける (text / Node / array の混在)
  children?: unknown;
  class?: string;
  /**
   * active 判定方式。default "exact" は `pathname === href` のみ。
   * "prefix" は `pathname === href || pathname.startsWith(href + "/")`。
   * `href === "/"` は prefix でも exact 強制 (全 path に hit するため)。
   */
  match?: "exact" | "prefix";
};

/**
 * SPA 遷移用の `<a>` ラッパー。左クリックのみ preventDefault して navigate() に委譲し、
 * Ctrl/Cmd/Shift/Alt 併用やミドルクリックはブラウザ標準の挙動 (新タブ等) に任せる。
 *
 * active state: currentPathname を effect で購読し、`isActive(...)` 結果に応じて
 * `aria-current="page"` を setAttribute / removeAttribute する。a11y standard の
 * aria-current のみで class 名は付けない (CSS で `[aria-current="page"]` selector
 * を書く前提、命名衝突回避 + bundle 軽量化)。server / hydrate でも renderer 経由
 * なので SSR markup に焼かれて初回 cursor 整合あり。
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

  const node = h(
    "a",
    { href: props.href, class: props.class, onClick: handleClick },
    _$dynamicChild(() => props.children),
  );

  // currentPathname を effect で購読して aria-current を reactive 切替。server mode
  // では effect 1 回実行で初期値が markup に焼かれる (hydrate 整合 OK、blink なし)。
  const renderer = getRenderer();
  effect(() => {
    const matchMode = props.match ?? "exact";
    if (isActive(currentPathname.value, props.href, matchMode)) {
      renderer.setAttribute(node as unknown as Element, "aria-current", "page");
    } else {
      renderer.removeAttribute(node as unknown as Element, "aria-current");
    }
  });

  return node;
}

function isActive(pathname: string, href: string, match: "exact" | "prefix"): boolean {
  if (pathname === href) return true;
  // "/" の prefix match は全 path 一致になるので exact 強制
  if (match !== "prefix" || href === "/") return false;
  // `+ "/"` 付きで `/use` が `/users` に hit する誤判定を防ぐ
  return pathname.startsWith(href + "/");
}
