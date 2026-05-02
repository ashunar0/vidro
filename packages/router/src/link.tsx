import { _$dynamicChild, effect, getRenderer, h } from "@vidro/core";
import { currentPathname, navigate } from "./navigation";

type LinkProps = {
  // ADR 0054: string なら static (snapshot)、`() => string` なら reactive (= 関数を渡すと
  // Link 内部の applyProp / effect が dynamic に追従する)。
  href: string | (() => string);
  // core の JSX.ElementChildrenAttribute に揃えて unknown で受ける (text / Node / array の混在)
  children?: unknown;
  // class も href と同じく `() => string` 形式で reactive 対応 (ADR 0054 scope b)。
  class?: string | (() => string);
  /**
   * active 判定方式。default "exact" は `pathname === href` のみ。
   * "prefix" は `pathname === href || pathname.startsWith(href + "/")`。
   * `href === "/"` は prefix でも exact 強制 (全 path に hit するため)。
   */
  match?: "exact" | "prefix";
};

// string / `() => string` 両形式を受けて現在の値を返す。effect の中で呼べば、
// 関数の場合に内部で読まれた signal が自動 track される。
function resolveValue(value: string | (() => string)): string {
  return typeof value === "function" ? value() : value;
}

/**
 * SPA 遷移用の `<a>` ラッパー。左クリックのみ preventDefault して navigate() に委譲し、
 * Ctrl/Cmd/Shift/Alt 併用やミドルクリックはブラウザ標準の挙動 (新タブ等) に任せる。
 *
 * **reactive escape hatch (ADR 0054)**: `href` / `class` は `string` だけでなく
 * `() => string` も受け付ける。関数を渡すと Link 内部の `applyProp` (= h() が呼ぶ)
 * が effect で wrap し、関数内で読まれた signal が変化したら DOM 属性が追従する。
 * pagination の `<Link href={() => buildHref(currentPage.value - 1)}>` 等のために。
 *
 * active state: currentPathname を effect で購読し、`isActive(...)` 結果に応じて
 * `aria-current="page"` を setAttribute / removeAttribute する。a11y standard の
 * aria-current のみで class 名は付けない (CSS で `[aria-current="page"]` selector
 * を書く前提、命名衝突回避 + bundle 軽量化)。server / hydrate でも renderer 経由
 * なので SSR markup に焼かれて初回 cursor 整合あり。href が関数なら effect 内で
 * resolveValue() を呼ぶことで dynamic href の active 判定にも追従する。
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
    // click 時に最新の href を resolve する (関数なら呼び出して string 化)。
    navigate(resolveValue(props.href));
  };

  // h() の applyProp が関数 / string 両方を handle する (jsx.ts:293-307):
  //   - string → 直接 setAttribute (snapshot)
  //   - function → effect で wrap して reactive 化
  // なので props.href / props.class をそのまま渡せば適切に分岐する。
  const node = h(
    "a",
    { href: props.href, class: props.class, onClick: handleClick },
    _$dynamicChild(() => props.children),
  );

  // currentPathname を effect で購読して aria-current を reactive 切替。href が関数の
  // 場合も resolveValue() を effect 内で呼ぶことで、関数内の signal が track される
  // → dynamic href の active 判定が追従する。server mode では effect 1 回実行で
  // 初期値が markup に焼かれる (hydrate 整合 OK、blink なし)。
  const renderer = getRenderer();
  effect(() => {
    const matchMode = props.match ?? "exact";
    const currentHref = resolveValue(props.href);
    if (isActive(currentPathname.value, currentHref, matchMode)) {
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
