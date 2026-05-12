// @vidro/hibana — Vidro の sibling、Hono の上に薄く乗る backend 主導 FW。
// Phase 1 Step 5 (ADR 0080) 着手時点の API:
//   - `hibana()` middleware: Hono の `c.render(Component, props)` を SSR HTML として返す
//   - per-route head は page module の `export const metadata` で扱う (= ADR 0079)
//   - `.island.tsx` の auto-wrap / 自動発見 / virtual client entry は `@vidro/hibana/vite` plugin が担当
//   - `defineIsland` は internal helper として `@vidro/hibana/internal` に移動 (= user 語彙から消えた)
//   - `Link` / `Frame` component を export (= ADR 0080、HTML swap navigation の opt-in API)
//
// 設計書: ~/brain/docs/backend-first FW 設計骨格.md
// roadmap: docs/roadmap-hibana.md
// ADR: docs/decisions/0079-hibana-per-route-head-via-export-metadata.md
// ADR: docs/decisions/0080-hibana-html-swap-navigation.md

import type { MiddlewareHandler } from "hono";
import { h } from "@vidro/core";
import { renderToString } from "@vidro/core/server";

// ADR 0080: Step 5 (HTML swap navigation) の user-facing components
export { Link } from "./link.js";
export type { LinkProps } from "./link.js";
export { Frame } from "./frame.js";
export type { FrameProps } from "./frame.js";

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
//
// ContextVariableMap には Hibana 内部状態 (= layout stack) を hibana 名前空間で 1 個積む。
// stack に直接アクセスする想定はない (= hibanaLayout middleware と renderer 経由でのみ操作)、
// user が `c.var.hibanaLayouts` を直接読む API 設計ではない点に注意。
declare module "hono" {
  interface ContextRenderer {
    <P>(component: Component<P>, props?: P): Response | Promise<Response>;
  }
  interface ContextVariableMap {
    /**
     * hibanaLayout middleware が push する layout component の stack。
     * Hono の middleware execution order (= 親 router の `.use("*")` → 子 router の
     * `.use("*")` の順) で push されるので、renderer 側で reduceRight すれば
     * 親 layout が外側、子 layout が内側、page が最内、という自然な nested wrap になる。
     */
    hibanaLayouts?: LayoutComponent[];
    /**
     * filesystem-based 版 (= @vidro/hibana/fs) の createFsApp が、route file 側
     * `export const metadata` を c.set で積む経路 (= ADR 0080 候補の解 a)。
     * hibana() middleware の renderer が c.var.hibanaRouteMetadata を読んで、無ければ
     * Component.metadata (= ADR 0079 既存経路) にフォールバック。
     * declare は @vidro/hibana 単独 import でも augment が効くよう core 側に置く。
     */
    hibanaRouteMetadata?: Metadata | MetadataFn<unknown>;
  }
}

// ── handler-based layout (Step 4 (3)) ────────────────────────────────────────

/**
 * layout component の型。children を受け取って JSX を返す関数 component。
 * Hibana の Component<P> と shape は近いが、`children: Node` を P の固定 field として
 * 持つ点で別エイリアスにしてある (= signature を doc 化するため)。
 *
 * page 用の Component<P> は props 経由で children を受けない想定 (= page は終端)、
 * Layout だけが children を受ける、という責務の差を型で見せる。
 */
export type LayoutComponent = (props: { children: Node }) => Node | Promise<Node>;

/**
 * Hono の `.use(...)` に渡す layout 適用 middleware。
 *
 * 例:
 *   const app = new Hono()
 *     .use("*", hibanaLayout(AppLayout))         // 全体
 *     .route("/posts", postsRoutes);
 *
 *   const postsRoutes = new Hono()
 *     .use("*", hibanaLayout(PostsLayout))       // /posts/* にだけ被せる
 *     .get("/", (c) => c.render(PostListPage, {...}));
 *
 * Hono の middleware execution order に乗ることで nested layout は自動で動く:
 *   /posts/ リクエスト時 → AppLayout が push → PostsLayout が push →
 *   handler の c.render() 時に stack = [AppLayout, PostsLayout]、
 *   renderer 側で reduceRight して `<AppLayout><PostsLayout><Page/></PostsLayout></AppLayout>` に組まれる
 *
 * 機構的には c.var.hibanaLayouts に immutable な配列を持たせて、`[...prev, Layout]` で
 * push するだけの薄い middleware。stack を直接持たず spread コピーする理由は、HMR や
 * 並列 request で前回の stack が漏れ込む事故を防ぐため (= 各 request の context は独立)。
 */
export const hibanaLayout = (Layout: LayoutComponent): MiddlewareHandler => {
  return async (c, next) => {
    const current = c.get("hibanaLayouts") ?? [];
    c.set("hibanaLayouts", [...current, Layout]);
    await next();
  };
};

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
// 取得経路は 2 つあり、優先順位は route metadata > component metadata:
//   1. route metadata (= c.var.hibanaRouteMetadata、filesystem-based 版 @vidro/hibana/fs 用)
//      route file 側の `export const metadata` を Vite plugin が import し、createFsApp の
//      handler wrapper が c.set で積んだもの。第 21 周目で追加 (解 a)。
//   2. component metadata (= Component の .metadata プロパティ、handler-based 版用)
//      page module の `export const metadata` を Vite plugin の transformMetadata が
//      default export に attach したもの (= ADR 0079 既存経路)。
// 両方なければ undefined で default fallback (= options.title など)。
//
// function 形式なら props 渡して eval、object 形式ならそのまま使う。
//
// Merge ルール (v1、ADR 0079 §Merge ルール):
//   - title / description / charset / viewport = page metadata が設定してれば override (= 後勝ち)
//   - meta / link = append のみ (= dedup なし、dogfood で困ったら v2 で強化)
const buildHeadHtml = (
  component: Component<Record<string, unknown>>,
  props: Record<string, unknown> | undefined,
  defaultTitle: string,
  scriptTag: string,
  routeMetadata?: Metadata | MetadataFn<unknown>,
): string => {
  const componentMetadata = (component as { metadata?: Metadata | MetadataFn<unknown> }).metadata;
  const rawMetadata = routeMetadata ?? componentMetadata;
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
 *   3. c.var.hibanaLayouts (= hibanaLayout middleware が積んだ stack) を reduceRight で
 *      wrap し、`<L1><L2><...><Page/></...></L2></L1>` の nested 木を組み立てる
 *   4. @vidro/core の renderToString が JSX 木を server renderer で評価して HTML body に焼く
 *   5. 完成した shell HTML で wrap して c.html で返す
 *
 * 現状の制約 (Phase 1 Step 4 (3) 着手時点):
 *   - parent layout の metadata merge は未実装 (= dogfood で困ったら検討、現状 page metadata のみ)
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
      const routeMetadata = c.get("hibanaRouteMetadata");
      const layouts = c.get("hibanaLayouts") ?? [];

      // ADR 0080 Phase 3: partial mode 判定。client-navigation.ts が <Link> click intercept で
      // `Accept: text/html;hibana-partial` を送ってきた時だけ partial response を返す。
      // 通常の browser navigation (= MPA、Accept: text/html) は既存 full HTML を返す経路。
      // 兼用 endpoint なので JS 切れた状態 / 書き忘れ素 <a> も graceful degradation で動く。
      const accept = c.req.header("Accept") ?? "";
      const isPartial = accept.includes("hibana-partial");

      if (isPartial) {
        // partial mode: layout chain skip、page だけ render。
        // raw body は <hibana-frame> 等の wrapper 無し、純粋な page content のみ。
        // client は受け取った body を現 DOM の最深 <hibana-frame> の innerHTML に直接代入する。
        const body = renderToString(() => h(component, props ?? null));

        // ADR 0079 metadata から title だけ抽出して header で送る。
        // <meta> / <link> 更新は v1 では skip (= dogfood で困ったら Phase 5 で対応)。
        const componentMetadata = (component as { metadata?: Metadata | MetadataFn<unknown> })
          .metadata;
        const rawMetadata = routeMetadata ?? componentMetadata;
        const metadata: Metadata | undefined =
          typeof rawMetadata === "function"
            ? (rawMetadata as MetadataFn<unknown>)(props as unknown)
            : rawMetadata;
        const title = metadata?.title ?? defaultTitle;

        // layout stack の name list を header で送る (= Phase 4 で client 側が共通祖先計算に使う)。
        // function .name は declaration name (例: `function PostsLayout` → "PostsLayout")、
        // anonymous の場合は "Anonymous" を fallback として置く。
        // prod minify で .name が消えると識別不能になる懸念は ADR 0080 §拡張余地として後回し。
        const layoutNames = layouts.map((L) => L.name || "Anonymous");

        return c.body(body, 200, {
          "Content-Type": "text/html; charset=utf-8",
          "X-Hibana-Layouts": layoutNames.join(","),
          "X-Hibana-Title": title,
        });
      }

      // 通常経路 (= full HTML response、MPA / 直 fetch / JS 切れ環境用)。
      // layout stack を取り出して reduceRight で nested wrap。stack が空なら page 直叩き。
      // reduceRight にする理由: stack は [親, 子] 順で push されるので、最後 (子) から
      // 反転して `h(子Layout, {children: h(page)})` を作り、次に `h(親Layout, {children: ...})` で
      // 包む。結果として親が外側、子が内側、page が最内 = JSX 木として正しい nested 構造になる。
      //
      // 重要: h() の呼び出しは **必ず renderToString の callback 内** で実行する。
      // renderToString が ALS で server renderer scope を立ち上げて初めて、h() が server 側
      // (= 文字列出力) に振れる。callback 外で h() を呼ぶと client renderer (= document API)
      // 経由で評価されて `document is not defined` で落ちる。
      const headHtml = buildHeadHtml(component, props, defaultTitle, scriptTag, routeMetadata);
      const body = renderToString(() => {
        const pageNode = h(component, props ?? null);
        // LayoutComponent (= `{children: Node}` 受け) は parameter contravariance で h() の
        // ComponentFn (= `Record<string, unknown>` 受け) に直接代入不可。`as unknown as
        // ComponentFn` の 2 段階 cast で意図を明示 (= `as never` は型穴を黙らせるだけで、
        // shape 変更を検知できない code-review 指摘を反映)。
        return layouts.reduceRight<Node>(
          (children, Layout) =>
            h(Layout as unknown as (p: Record<string, unknown>) => Node, { children }),
          pageNode,
        );
      });
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
