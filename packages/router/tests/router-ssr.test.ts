// @vitest-environment node
// Phase B Step B-2b: Router を server mode (ssr prop) + renderToString で
// 評価できることの確認 (ADR 0017)。
import { describe, expect, test } from "vite-plus/test";
import { h } from "@vidro/core";
import { renderToString } from "@vidro/core/server";
import { Router } from "../src/router";
import { loaderData } from "../src/loader-data";
import { preloadRouteComponents } from "../src/server";
import type { RouteRecord } from "../src/route-tree";

describe("Router SSR (server mode)", () => {
  test("基本: layout + index が HTML に焼ける", async () => {
    const IndexPage = () => h("h1", null, "Home");
    const RootLayout = (props: { children: unknown }) =>
      h("div", { class: "root" }, props.children);

    const manifest: RouteRecord = {
      "/routes/index.tsx": () => Promise.resolve({ default: IndexPage }),
      "/routes/layout.tsx": () => Promise.resolve({ default: RootLayout }),
    };

    const pathname = "/";
    const resolvedModules = await preloadRouteComponents(manifest, pathname);
    const html = renderToString(() =>
      Router({
        routes: manifest,
        ssr: {
          bootstrapData: {
            pathname,
            params: {},
            layers: [{ data: undefined }, { data: undefined }],
          },
          resolvedModules,
        },
      }),
    );

    // anchor: B-3b で `<!--router-->`、B-3c-1 で各 ErrorBoundary 出力に
    // `<!--error-boundary-->`。leaf + root layout の 2 層 wrap になる。
    expect(html).toBe(
      '<div class="root"><h1>Home</h1><!--error-boundary--></div><!--error-boundary--><!--router-->',
    );
  });

  test("nested route: /about が about/index.tsx を render", async () => {
    const AboutPage = () => h("h1", null, "About us");

    const manifest: RouteRecord = {
      "/routes/index.tsx": () => Promise.resolve({ default: () => h("h1", null, "Home") }),
      "/routes/about/index.tsx": () => Promise.resolve({ default: AboutPage }),
    };

    const pathname = "/about";
    const resolvedModules = await preloadRouteComponents(manifest, pathname);
    const html = renderToString(() =>
      Router({
        routes: manifest,
        ssr: {
          bootstrapData: { pathname, params: {}, layers: [{ data: undefined }] },
          resolvedModules,
        },
      }),
    );

    expect(html).toBe("<h1>About us</h1><!--error-boundary--><!--router-->");
  });

  test("loader data が loaderData() store として届く (ADR 0049)", async () => {
    // ADR 0049: PageProps.data 廃止。loader 戻りは loaderData<L>() で reactive
    // に取る。store proxy 経由なので leaf access は `.value`。
    type Loader = () => Promise<{ name: string }>;
    const IndexPage = () => {
      const data = loaderData<Loader>();
      return h("p", null, `Hello ${data.name.value}`);
    };

    const manifest: RouteRecord = {
      "/routes/index.tsx": () => Promise.resolve({ default: IndexPage }),
    };

    const pathname = "/";
    const resolvedModules = await preloadRouteComponents(manifest, pathname);
    const html = renderToString(() =>
      Router({
        routes: manifest,
        ssr: {
          bootstrapData: {
            pathname,
            params: {},
            layers: [{ data: { name: "zundamon" } }],
          },
          resolvedModules,
        },
      }),
    );

    expect(html).toBe("<p>Hello zundamon</p><!--error-boundary--><!--router-->");
  });

  test("loader error → 最寄り error.tsx で置換される", async () => {
    const IndexPage = () => h("h1", null, "should not appear");
    const ErrorPage = (props: { error: unknown }) =>
      h(
        "div",
        { class: "error" },
        `failed: ${props.error instanceof Error ? props.error.message : "unknown"}`,
      );

    const manifest: RouteRecord = {
      "/routes/index.tsx": () => Promise.resolve({ default: IndexPage }),
      "/routes/error.tsx": () => Promise.resolve({ default: ErrorPage }),
    };

    const pathname = "/";
    const resolvedModules = await preloadRouteComponents(manifest, pathname);
    const html = renderToString(() =>
      Router({
        routes: manifest,
        ssr: {
          bootstrapData: {
            pathname,
            params: {},
            layers: [{ error: { name: "Error", message: "boom" } }],
          },
          resolvedModules,
        },
      }),
    );

    // loader error 経路は ErrorBoundary で wrap されない (foldRouteTree が
    // 自分で renderError を呼ぶ。layouts も無いので Router anchor のみ)
    expect(html).toBe('<div class="error">failed: boom</div><!--router-->');
  });

  test("render error → ErrorBoundary で fallback に置換", async () => {
    const IndexPage = () => {
      throw new Error("render crash");
    };
    const ErrorPage = (props: { error: unknown }) =>
      h(
        "div",
        { class: "error" },
        `caught: ${props.error instanceof Error ? props.error.message : "unknown"}`,
      );

    const manifest: RouteRecord = {
      "/routes/index.tsx": () => Promise.resolve({ default: IndexPage }),
      "/routes/error.tsx": () => Promise.resolve({ default: ErrorPage }),
    };

    const pathname = "/";
    const resolvedModules = await preloadRouteComponents(manifest, pathname);
    const html = renderToString(() =>
      Router({
        routes: manifest,
        ssr: {
          bootstrapData: { pathname, params: {}, layers: [{ data: undefined }] },
          resolvedModules,
        },
      }),
    );

    // render error 経路は leaf を ErrorBoundary で wrap、fallback が anchor 内に入る
    expect(html).toBe(
      '<div class="error">caught: render crash</div><!--error-boundary--><!--router-->',
    );
  });

  test("404: route マッチ無し & not-found.tsx 無し → 素朴な text", async () => {
    const manifest: RouteRecord = {
      "/routes/index.tsx": () => Promise.resolve({ default: () => h("h1", null, "Home") }),
    };

    const pathname = "/nope";
    const resolvedModules = await preloadRouteComponents(manifest, pathname);
    const html = renderToString(() =>
      Router({
        routes: manifest,
        ssr: {
          bootstrapData: { pathname, params: {}, layers: [] },
          resolvedModules,
        },
      }),
    );

    // 404 経路は anchor 無し (resolvedModules.route が null のため early return)
    expect(html).toBe("404 Not Found");
  });

  test("not-found.tsx がある → そちらが render される", async () => {
    const NotFound = () => h("p", { class: "nf" }, "No such page");

    const manifest: RouteRecord = {
      "/routes/index.tsx": () => Promise.resolve({ default: () => h("h1", null, "Home") }),
      "/routes/not-found.tsx": () => Promise.resolve({ default: NotFound }),
    };

    const pathname = "/missing";
    const resolvedModules = await preloadRouteComponents(manifest, pathname);
    const html = renderToString(() =>
      Router({
        routes: manifest,
        ssr: {
          bootstrapData: {
            pathname,
            params: {},
            layers: [{ data: undefined }],
          },
          resolvedModules,
        },
      }),
    );

    expect(html).toBe('<p class="nf">No such page</p><!--error-boundary--><!--router-->');
  });
});
