// @vidro/hibana — Vidro の sibling、Hono の上に薄く乗る backend 主導 FW。
// Phase 1 Step 1 の最小実装: c.render(Component, props) を提供するだけの middleware。
// island / navigation / Vite plugin はまだ無い (= 後続 Step で追加)。
//
// 設計書: ~/brain/docs/backend-first FW 設計骨格.md

import type { MiddlewareHandler } from "hono";
import { h } from "@vidro/core";
import { renderToString } from "@vidro/core/server";

// Hibana の component 型 (server-side、関数参照ベース)。
// 関数参照で受け取るのは Inertia のような文字列識別子と違い、TS の型推論 / リファクタ追従 /
// IDE 補完が効くため (= 設計書「主要な設計決定とその根拠 / Render API」参照)。
//
// 戻り値は Node | Promise<Node>。jsxImportSource: @vidro/core で JSX.Element = Node なので、
// JSX を返す通常の component 関数はこの shape に自然に合致する。async server component は
// Promise<Node>。h() の ComponentFn と structurally 互換にすることで cast を最小化する。
type Component<P = Record<string, unknown>> = (props: P) => Node | Promise<Node>;

// Hono の `ContextRenderer` interface を augment して、c.render(Component, props) の
// 2-arg shape を提供する。HonoX も同名 c.render を生やすが意味が違う (HonoX は JSX content、
// Hibana は関数参照 + props)。HonoX との併用は想定しない (= Hibana 単独で完結)。
// 命名衝突の懸念は設計書 Open Questions に登録済 (= c.page / c.view 等への改名候補)。
declare module "hono" {
  interface ContextRenderer {
    <P>(component: Component<P>, props?: P): Response | Promise<Response>;
  }
}

/**
 * Hibana の最小 middleware。c.render(Component, props) を提供する。
 *
 * 流れ:
 *   1. c.setRenderer で c.render を Hibana 仕様 (= 関数参照 + props) に置き換え
 *   2. @vidro/core の renderToString が JSX 木を server renderer で評価して HTML body に焼く
 *   3. shell HTML で wrap して c.html で返す
 *
 * 現状の制約 (Phase 1 Step 1 minimum):
 *   - shell HTML (<!DOCTYPE html>...) は固定。layout / per-page <head> 制御は未実装
 *   - island hydrate なし (= .island.tsx は Phase 1 Step 2)
 *   - navigation (= HTML swap) なし (= Phase 1 Step 5)
 *   - Vite plugin なし (= Phase 1 Step 3 で .island.tsx 自動発見を導入)
 */
export const hibana = (): MiddlewareHandler => {
  return async (c, next) => {
    // setRenderer の引数型は augment 済の ContextRenderer に従う。
    // Component<unknown> は ComponentFn と structurally 互換 (= return covariance + props
    // contravariance) なので、h() への受け渡しに cast 不要。
    c.setRenderer(((
      component: Component<Record<string, unknown>>,
      props?: Record<string, unknown>,
    ) => {
      const body = renderToString(() => h(component, props ?? null));
      const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Hibana Demo</title>
  </head>
  <body>${body}</body>
</html>`;
      return c.html(html);
    }) as never);
    await next();
  };
};
