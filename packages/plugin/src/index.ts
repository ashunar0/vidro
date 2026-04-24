// @vidro/plugin の public entry。
//   jsxTransform — A 方式の JSX transform (`{expr}` を `_reactive(() => expr)` に包む)
// 将来: 他 plugin (route tree 型生成 / server boundary 等) を同じ index から export する。
export { jsxTransform } from "./jsx-transform";
