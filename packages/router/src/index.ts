// @vidro/router の公開エントリ。
// RouteMap は `@vidro/plugin` の routeTypes() が `declare module` で augment する
// 土台 interface。Routes はその alias。LoaderArgs<R> / PageProps<L> / LayoutProps<L>
// はすべて Routes 経由で params 型を通す。
export { Router } from "./router";
export { Link } from "./link";
export { navigate } from "./navigation";
export type { RouteRecord } from "./route-tree";
export type {
  PageProps,
  LayoutProps,
  LoaderArgs,
  ErrorPageProps,
  RouteMap,
  Routes,
} from "./page-props";
