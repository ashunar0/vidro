// @vidro/router の公開エントリ。最小版では Router / Link / navigate のみ export。
// layout / loader は後続タスク。
export { Router } from "./router";
export { Link } from "./link";
export { navigate } from "./navigation";
export type { RouteRecord } from "./route-tree";
export type { PageProps, LayoutProps, LoaderArgs, ErrorPageProps } from "./page-props";
