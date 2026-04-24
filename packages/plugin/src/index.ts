// @vidro/plugin の public entry。
//   jsxTransform    — A 方式の JSX transform (`{expr}` を `_reactive(() => expr)` に包む)
//   routeTypes      — routes/ の構造から RouteMap の .d.ts を生成 (ADR 0011)
//   serverBoundary  — dev server に /__loader endpoint を生やす (案 B Step 1)
export { jsxTransform } from "./jsx-transform";
export { routeTypes, type RouteTypesOptions } from "./route-types";
export { serverBoundary } from "./server-boundary";
