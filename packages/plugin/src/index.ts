// @vidro/plugin の public entry。
//   jsxTransform    — A 方式の JSX transform (`{expr}` を `_reactive(() => expr)` に包む)
//   routeTypes      — routes/ の構造から RouteMap の .d.ts を生成 (ADR 0011)
//   serverBoundary  — `.server.ts` を client bundle で空 stub にする security boundary (ADR 0043)
export { jsxTransform } from "./jsx-transform";
export { routeTypes, type RouteTypesOptions } from "./route-types";
export { serverBoundary, type ServerBoundaryOptions } from "./server-boundary";
