// TypeScript の automatic JSX runtime entry (`"jsx": "react-jsx"` + `"jsxImportSource": "@vidro/core"`)。
// コンパイラがここから `jsx` / `jsxs` / `Fragment` を自動 import する想定。
import { h, Fragment } from "./jsx";

export { Fragment };

type Props = Record<string, unknown> & { children?: unknown };

// automatic runtime 共通: children は props.children に入って届く。h の可変長 children に戻して委譲する。
function callH(type: Parameters<typeof h>[0], props: Props | null): Node {
  if (!props) return h(type, null);
  const { children, ...rest } = props;
  const restProps = Object.keys(rest).length > 0 ? (rest as Record<string, unknown>) : null;
  if (children === undefined) return h(type, restProps);
  if (Array.isArray(children)) return h(type, restProps, ...children);
  return h(type, restProps, children);
}

/** 単一 child 用 (automatic runtime は動的 / 単発 children でこちらを呼ぶ)。 */
export function jsx(type: Parameters<typeof h>[0], props: Props | null): Node {
  return callH(type, props);
}

/** 複数 static children 用 (children が配列で確定しているケース、jsx と挙動は同じ)。 */
export function jsxs(type: Parameters<typeof h>[0], props: Props | null): Node {
  return callH(type, props);
}
