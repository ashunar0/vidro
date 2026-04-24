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
 */
export function Link(props: LinkProps): Node {
  const handleClick = (e: MouseEvent) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (e.button !== 0) return;
    e.preventDefault();
    navigate(props.href);
  };

  return (
    <a href={props.href} class={props.class} onClick={handleClick}>
      {props.children}
    </a>
  );
}
