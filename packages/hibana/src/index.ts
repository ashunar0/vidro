// @vidro/hibana — Vidro の sibling、Hono の上に薄く乗る backend 主導 FW。
// Phase 1 Step 4 (ADR 0079) 着手時点の API:
//   - `hibana()` middleware: Hono の `c.render(Component, props)` を SSR HTML として返す
//   - per-route head は page module の `export const metadata` で扱う (= ADR 0079)
//   - `.island.tsx` の auto-wrap / 自動発見 / virtual client entry は `@vidro/hibana/vite` plugin が担当
//   - `defineIsland` は internal helper として `@vidro/hibana/internal` に移動 (= user 語彙から消えた)
//
// 設計書: ~/brain/docs/backend-first FW 設計骨格.md
// roadmap: docs/roadmap-hibana.md
// ADR: docs/decisions/0079-hibana-per-route-head-via-export-metadata.md

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
// 第 19 周目 (= ADR 0079 起票時) に c.render は据え置き決定 (= API surface を太らせない)。
declare module "hono" {
  interface ContextRenderer {
    <P>(component: Component<P>, props?: P): Response | Promise<Response>;
  }
}

// ── per-route head (ADR 0079) ────────────────────────────────────────────────

/**
 * page module の `export const metadata` で渡す compound type。
 * Vite plugin の transform が default export function に `.metadata` プロパティとして
 * attach し、`hibana()` middleware の renderer がここから読み取って shell HTML の
 * <head> に inject する。
 *
 * 拡張余地 (= ADR 0079 §拡張余地、dogfood で困ったら追加):
 *   - openGraph / twitter / robots / icons の compound type (= meta/link array で代用可)
 *   - meta name 単位 / link rel+href 単位の dedup (= v1 は append のみ)
 */
export type Metadata = {
  title?: string;
  description?: string;
  charset?: string;
  viewport?: string;
  meta?: Array<MetaTag>;
  link?: Array<LinkTag>;
};

export type MetaTag = {
  name?: string;
  property?: string;
  "http-equiv"?: string;
  content: string;
};

export type LinkTag = {
  rel: string;
  href: string;
  hreflang?: string;
  type?: string;
  sizes?: string;
};

/**
 * dynamic metadata 用。props を受け取って Metadata を返す。
 * 例: `export const metadata: MetadataFn<{ post: Post }> = ({ post }) => ({ title: post.title })`
 */
export type MetadataFn<P> = (props: P) => Metadata;

export type HibanaOptions = {
  /** shell HTML の <title> default。route ごとの上書きは page module の `export const metadata` で。 */
  title?: string;
};

// client bundle の URL path。Phase B-2 で auto-detect 化:
//   - dev (= vite が `process.env.NODE_ENV = "development"` を立てる): vite plugin が提供する
//     virtual entry を `/@id/__x00__virtual:hibana/client-entry` で直接読みに行く
//   - prod (= NODE_ENV === "production"): `vite build --mode client` で生成された
//     `/static/client.js` を Hono `serveStatic` で配信する前提
//
// 旧 (Phase A まで): user が `hibana({ clientScript: import.meta.env.PROD ? ... : ... })` で
// 自分で分岐していた。Phase B-2 で内部固定にし、user 語彙から完全に消した。
const clientScriptPath = (): string => {
  const isProd = typeof process !== "undefined" && process.env.NODE_ENV === "production";
  return isProd ? "/static/client.js" : "/@id/__x00__virtual:hibana/client-entry";
};

// HTML escape (= attribute value / text content 兼用)。
// shell HTML の <head> に inject する title / meta content / link href 等の文字列を
// XSS から守るための最低限。renderer 内で eval した metadata は user/server 由来の値が
// 入りうる (= 例: post.title を title に流す) ため必須。
const escapeHtml = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

// ADR 0079: metadata を抽出して shell HTML の <head> 部分文字列に焼く。
//
// Component の `.metadata` プロパティは Vite plugin の transform が default export に
// attach する (= page module の `export const metadata` を読んで attach、@vidro/hibana/vite 参照)。
// function 形式なら props 渡して eval、object 形式ならそのまま使う。両方無ければ undefined。
//
// Merge ルール (v1、ADR 0079 §Merge ルール):
//   - title / description / charset / viewport = page metadata が設定してれば override (= 後勝ち)
//   - meta / link = append のみ (= dedup なし、dogfood で困ったら v2 で強化)
const buildHeadHtml = (
  component: Component<Record<string, unknown>>,
  props: Record<string, unknown> | undefined,
  defaultTitle: string,
  scriptTag: string,
): string => {
  const rawMetadata = (component as { metadata?: Metadata | MetadataFn<unknown> }).metadata;
  const metadata: Metadata | undefined =
    typeof rawMetadata === "function"
      ? (rawMetadata as MetadataFn<unknown>)(props as unknown)
      : rawMetadata;

  const charset = metadata?.charset ?? "utf-8";
  const viewport = metadata?.viewport ?? "width=device-width, initial-scale=1";
  const title = metadata?.title ?? defaultTitle;
  const description = metadata?.description;

  const parts: string[] = [
    `<meta charset="${escapeHtml(charset)}" />`,
    `<meta name="viewport" content="${escapeHtml(viewport)}" />`,
    `<title>${escapeHtml(title)}</title>`,
  ];

  if (description !== undefined) {
    parts.push(`<meta name="description" content="${escapeHtml(description)}" />`);
  }

  for (const tag of metadata?.meta ?? []) {
    const attrs: string[] = [];
    if (tag.name !== undefined) attrs.push(`name="${escapeHtml(tag.name)}"`);
    if (tag.property !== undefined) attrs.push(`property="${escapeHtml(tag.property)}"`);
    if (tag["http-equiv"] !== undefined)
      attrs.push(`http-equiv="${escapeHtml(tag["http-equiv"])}"`);
    attrs.push(`content="${escapeHtml(tag.content)}"`);
    parts.push(`<meta ${attrs.join(" ")} />`);
  }

  for (const tag of metadata?.link ?? []) {
    const attrs: string[] = [`rel="${escapeHtml(tag.rel)}"`, `href="${escapeHtml(tag.href)}"`];
    if (tag.hreflang !== undefined) attrs.push(`hreflang="${escapeHtml(tag.hreflang)}"`);
    if (tag.type !== undefined) attrs.push(`type="${escapeHtml(tag.type)}"`);
    if (tag.sizes !== undefined) attrs.push(`sizes="${escapeHtml(tag.sizes)}"`);
    parts.push(`<link ${attrs.join(" ")} />`);
  }

  parts.push(scriptTag);

  return parts.join("\n    ");
};

/**
 * Hibana の最小 middleware。c.render(Component, props) を提供する。
 *
 * 流れ:
 *   1. c.setRenderer で c.render を Hibana 仕様 (= 関数参照 + props) に置き換え
 *   2. Component の `.metadata` を読んで shell HTML の <head> を組み立てる (= ADR 0079)
 *   3. @vidro/core の renderToString が JSX 木を server renderer で評価して HTML body に焼く
 *   4. 完成した shell HTML で wrap して c.html で返す
 *
 * 現状の制約 (Phase 1 Step 4 (1)+(2) 着手時点):
 *   - parent layout の metadata merge は未実装 (= Step 4 (3) layout pattern で扱う)
 *   - client-side document.title 更新は未実装 (= Step 5 navigation で扱う)
 *   - navigation (= HTML swap) なし (= Step 5)
 *   - prod runtime entry (= Node 起動 + serveStatic) は未実装 (= Step 6)
 */
export const hibana = (options: HibanaOptions = {}): MiddlewareHandler => {
  const defaultTitle = options.title ?? "Hibana";
  const scriptTag = `<script type="module" src="${clientScriptPath()}"></script>`;

  return async (c, next) => {
    // setRenderer の引数型は augment 済の ContextRenderer に従う。
    // Component<unknown> は ComponentFn と structurally 互換 (= return covariance + props
    // contravariance) なので、h() への受け渡しに cast 不要。
    c.setRenderer(((
      component: Component<Record<string, unknown>>,
      props?: Record<string, unknown>,
    ) => {
      const headHtml = buildHeadHtml(component, props, defaultTitle, scriptTag);
      const body = renderToString(() => h(component, props ?? null));
      const html = `<!DOCTYPE html>
<html>
  <head>
    ${headHtml}
  </head>
  <body>${body}</body>
</html>`;
      return c.html(html);
    }) as never);
    await next();
  };
};
