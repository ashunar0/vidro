// @vitest-environment jsdom
// ADR 0062: document level click delegation。Router boot 時に登録される click
// listener が `<a>` クリックを intercept して partial / client fold 経路に流す
// ことの単体検証。
//
// `<Link>` 自身の onClick は ADR 0062 で削除済 → 生 `<a href="/foo">` を DOM に
// 置いて click を dispatch する経路で十分検証できる。これにより `.server.tsx`
// 内 Link / 生 `<a>` のどちらでも均一に SPA 経路に流れる前提が test で固定される。

import { _$dynamicChild, _$text, h, hydrate } from "@vidro/core";
import { renderToString } from "@vidro/core/server";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { RouteRecord } from "../src/route-tree";

// 前回 setupRouter() で hydrate した owner を保持。次回 setup or afterEach で
// dispose して `onCleanup` 経由で click / submit listener を window から外す。
// 累積させると `e.defaultPrevented` 系正例しか書けない弱い test になるため、
// 念のため dispose を回す (= reviewer M-2)。
let lastDispose: (() => void) | null = null;

afterEach(() => {
  if (lastDispose) {
    lastDispose();
    lastDispose = null;
  }
});

// minimal な 1-leaf route で Router を hydrate するための共通 setup。各 test で
// document を毎回作り直す (= module-level state をなるべく漏らさない目的)。
async function setupRouter(): Promise<void> {
  if (lastDispose) {
    lastDispose();
    lastDispose = null;
  }
  const IndexPage = () => h("h1", null, _$text("Home"));
  const AboutPage = () => h("h1", null, _$text("About"));
  const RootLayout = (props: { children: unknown }) =>
    h(
      "div",
      { class: "root" },
      _$dynamicChild(() => props.children),
    );
  // /about も manifest に入れておく (= delegate 経由 navigate 後に Router の effect が
  // route match → load → swap を走らせるため、目的 route が manifest に居ないと
  // 404 fallback の hydrate cursor が exhaust する)。
  const manifest: RouteRecord = {
    "/routes/index.tsx": () => Promise.resolve({ default: IndexPage }),
    "/routes/about/index.tsx": () => Promise.resolve({ default: AboutPage }),
    "/routes/layout.tsx": () => Promise.resolve({ default: RootLayout }),
  };
  const eagerModules = {
    "/routes/index.tsx": { default: IndexPage },
    "/routes/about/index.tsx": { default: AboutPage },
    "/routes/layout.tsx": { default: RootLayout },
  };
  const pathname = "/";
  const bootstrap = {
    params: {},
    layers: [{ data: undefined }, { data: undefined }],
  };

  history.replaceState(null, "", pathname);
  document.body.innerHTML = `
    <script type="application/json" id="__vidro_data">${JSON.stringify(bootstrap)}</script>
    <div id="app"></div>
  `;

  const { Router } = await import("../src/router");
  const { preloadRouteComponents } = await import("../src/server");
  const resolvedModules = await preloadRouteComponents(manifest, pathname);
  const ssrHtml = renderToString(() =>
    Router({
      routes: manifest,
      ssr: {
        bootstrapData: { pathname, params: {}, layers: bootstrap.layers },
        resolvedModules,
      },
    }),
  );
  const appRoot = document.getElementById("app") as HTMLDivElement;
  appRoot.innerHTML = ssrHtml;
  lastDispose = hydrate(() => Router({ routes: manifest, eagerModules }), appRoot);
}

// click event を作って document に dispatch する helper。bubbles を必ず true に
// しないと document level listener まで上がらない。
function dispatchClick(target: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

describe("Router — document level click delegation (ADR 0062)", () => {
  test("同 origin の <a> click は preventDefault + history pushState", async () => {
    await setupRouter();
    const a = document.createElement("a");
    a.href = "/about";
    a.textContent = "About";
    document.body.appendChild(a);

    const event = dispatchClick(a);
    expect(event.defaultPrevented).toBe(true);
    expect(window.location.pathname).toBe("/about");
  });

  test("修飾キー併用 (ctrl/cmd/shift/alt) は intercept しない", async () => {
    await setupRouter();
    const a = document.createElement("a");
    a.href = "/about";
    document.body.appendChild(a);

    for (const init of [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { altKey: true },
    ]) {
      // 各 case 前に pathname を初期化して干渉を防ぐ
      history.replaceState(null, "", "/");
      const event = dispatchClick(a, init);
      expect(event.defaultPrevented).toBe(false);
      expect(window.location.pathname).toBe("/");
    }
  });

  test("button !== 0 (= 中クリック等) は intercept しない", async () => {
    await setupRouter();
    const a = document.createElement("a");
    a.href = "/about";
    document.body.appendChild(a);

    const event = dispatchClick(a, { button: 1 });
    expect(event.defaultPrevented).toBe(false);
    expect(window.location.pathname).toBe("/");
  });

  test("target=_blank は intercept しない", async () => {
    await setupRouter();
    const a = document.createElement("a");
    a.href = "/about";
    a.target = "_blank";
    document.body.appendChild(a);

    const event = dispatchClick(a);
    expect(event.defaultPrevented).toBe(false);
    expect(window.location.pathname).toBe("/");
  });

  test("download 属性付き <a> は intercept しない", async () => {
    await setupRouter();
    const a = document.createElement("a");
    a.href = "/file.pdf";
    a.setAttribute("download", "");
    document.body.appendChild(a);

    const event = dispatchClick(a);
    expect(event.defaultPrevented).toBe(false);
    expect(window.location.pathname).toBe("/");
  });

  test("異 origin の <a> は intercept しない", async () => {
    await setupRouter();
    const a = document.createElement("a");
    a.href = "https://example.com/page";
    document.body.appendChild(a);

    const event = dispatchClick(a);
    expect(event.defaultPrevented).toBe(false);
    // 異 origin なので pushState もされず、pathname は変わらない
    expect(window.location.pathname).toBe("/");
  });

  test("mailto: / tel: / javascript: スキームは intercept しない", async () => {
    // ADR 0062 採用案コメント「origin check 1 本で除外可能」の前提を test で
    // ピン止めする (= reviewer M-3)。HTTP 以外のスキームは HTMLAnchorElement.origin
    // が `null` 文字列 / 空文字 / scheme 自身 等になり、いずれも window.location.origin
    // と一致しないので除外条件を通過する。
    await setupRouter();
    for (const href of ["mailto:foo@example.com", "tel:+81-90-0000-0000", "javascript:void(0)"]) {
      const a = document.createElement("a");
      a.href = href;
      document.body.appendChild(a);
      const event = dispatchClick(a);
      expect(event.defaultPrevented).toBe(false);
      expect(window.location.pathname).toBe("/");
      a.remove();
    }
  });

  test("すでに defaultPrevented な event は早期 return (= navigate しない)", async () => {
    await setupRouter();
    const a = document.createElement("a");
    a.href = "/about";
    document.body.appendChild(a);

    // capture phase で先に preventDefault を打って delegate 側を skip させる
    const earlyHandler = (e: Event) => e.preventDefault();
    document.addEventListener("click", earlyHandler, true);
    const event = dispatchClick(a);
    document.removeEventListener("click", earlyHandler, true);

    expect(event.defaultPrevented).toBe(true);
    // delegate は早期 return するので pushState されず pathname は不変
    expect(window.location.pathname).toBe("/");
  });
});
