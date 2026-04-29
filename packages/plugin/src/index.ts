// @vidro/plugin の public entry。
//   vidro           — Vidro 全部入り plugin。CSR は `vidro()`、router は `vidro({ router: true })`
//   jsxTransform    — A 方式の JSX transform (`{expr}` を `_reactive(() => expr)` に包む)
//   routeTypes      — routes/ の構造から RouteMap の .d.ts を生成 (ADR 0011)
//   serverBoundary  — `.server.ts` を client bundle で空 stub にする security boundary (ADR 0043)
//
// 通常 user は `vidro()` だけ使えば足りる。jsxTransform / routeTypes / serverBoundary は
// 個別 tuning したい advanced 用途 (ADR を書く時など) 向けの low-level export として残す。
export { vidro, type VidroOptions } from "./vidro";
export { jsxTransform } from "./jsx-transform";
export { routeTypes, type RouteTypesOptions } from "./route-types";
export { serverBoundary, type ServerBoundaryOptions } from "./server-boundary";
