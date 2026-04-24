// @vidro/router の公開エントリ。
// RouteMap は `@vidro/plugin` の routeTypes() が `declare module` で augment する
// 土台 interface。Routes はその alias。LoaderArgs<R> / PageProps<L> / LayoutProps<L>
// はすべて Routes 経由で params 型を通す。
export { Router } from "./router";
export { Link } from "./link";
export { navigate } from "./navigation";
// compileRoutes / matchRoute は DOM に触らない純粋関数で、@vidro/plugin
// の serverBoundary() が server 側で match を行うために使う。
export { compileRoutes, matchRoute } from "./route-tree";
export type {
  RouteRecord,
  RouteEntry,
  LayoutEntry,
  ServerEntry,
  ErrorEntry,
  CompiledRoutes,
  MatchResult,
  ServerModule,
  ServerModuleLoader,
} from "./route-tree";
export type {
  PageProps,
  LayoutProps,
  LoaderArgs,
  ErrorPageProps,
  RouteMap,
  Routes,
} from "./page-props";
