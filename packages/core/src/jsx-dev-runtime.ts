// dev 用 automatic JSX runtime entry (`"jsx": "react-jsxdev"` で使われる)。
// 現状 source 情報は使わないので jsx と挙動は同じ。
import { h, Fragment } from "./jsx";

export { Fragment };

type Props = Record<string, unknown> & { children?: unknown };

export function jsxDEV(type: Parameters<typeof h>[0], props: Props | null): Node {
  if (!props) return h(type, null);
  const { children, ...rest } = props;
  const restProps = Object.keys(rest).length > 0 ? (rest as Record<string, unknown>) : null;
  if (children === undefined) return h(type, restProps);
  if (Array.isArray(children)) return h(type, restProps, ...children);
  return h(type, restProps, children);
}
