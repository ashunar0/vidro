// @vitest-environment node
// Phase B Step B-2b: Router を server mode (ssr prop) + renderToString で
// 評価できることの確認 (ADR 0017)。
import { describe, expect, test } from "vite-plus/test";
import { h } from "@vidro/core";
import { renderToString } from "@vidro/core/server";
import { Router } from "../src/router";
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

    expect(html).toBe('<div class="root"><h1>Home</h1></div>');
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

    expect(html).toBe("<h1>About us</h1>");
  });

  test("loader data が leaf の props.data として届く", async () => {
    const IndexPage = (props: { data: { name: string } }) =>
      h("p", null, `Hello ${props.data.name}`);

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

    expect(html).toBe("<p>Hello zundamon</p>");
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

    expect(html).toBe('<div class="error">failed: boom</div>');
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

    expect(html).toBe('<div class="error">caught: render crash</div>');
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

    expect(html).toBe('<p class="nf">No such page</p>');
  });
});
