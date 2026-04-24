// @vidro/plugin の public entry。
//   jsxTransform — A 方式の JSX transform (`{expr}` を `_reactive(() => expr)` に包む)
//   routeTypes  — routes/ の構造から RouteMap の .d.ts を生成 (ADR 0011)
// 将来: server boundary 等を同じ index から export する。
export { jsxTransform } from "./jsx-transform";
export { routeTypes, type RouteTypesOptions } from "./route-types";
