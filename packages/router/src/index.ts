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
// ADR 0051 — derive 派楽観更新 + intent pattern。
// `submission()` (= 最新の stable view、単発 form 用) と `submissions()` (= array、
// 複数 in-flight 楽観 UX 用) と `submit()` (= programmatic) を露出。`<form method="post">`
// は Router が自動 intercept し、複数 form の区別は HTML `<button name="intent">`。
export { submission, submissions, submit } from "./action";
export type {
  Submission,
  LatestSubmission,
  SubmissionError,
  ActionArgs,
  AnyAction,
  SubmitInput,
  SubmitOptions,
} from "./action";
// ADR 0049 — loaderData() primitive。loader 戻りを reactive store として取得。
// internal helpers (`_setLayerIndex` 等) は router.tsx の foldRouteTree が呼ぶ。
export { loaderData } from "./loader-data";
// ADR 0052 — searchParams() primitive。URL search 部分を reactive store として扱う
// client URL state primitive。`revalidate()` は Path Y で必要な loader 再 fire 経路。
export { searchParams, revalidate } from "./search-params";
