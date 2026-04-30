// @vidro/router の公開エントリ。
// RouteMap は `@vidro/plugin` の routeTypes() が `declare module` で augment する
// 土台 interface。Routes はその alias。LoaderArgs<R> / PageProps<L> / LayoutProps<L>
// はすべて Routes 経由で params 型を通す。
export { Router } from "./router";
export type { ResolvedModules, SSRProps } from "./router";
export { Link } from "./link";
export { navigate, currentPathname, currentParams } from "./navigation";
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
// ADR 0037 Phase 3 R-min — action primitive。submission() factory + ActionArgs<R>
// で server action と form を結ぶ。internal mutator (`_set*`) は router.tsx
// (form delegation) からのみ参照。
export { submission } from "./action";
export type { Submission, SubmissionError, ActionArgs, AnyAction } from "./action";
// ADR 0049 — loaderData() primitive。loader 戻りを reactive store として取得。
// internal helpers (`_setLayerIndex` 等) は router.tsx の foldRouteTree が呼ぶ。
export { loaderData } from "./loader-data";
