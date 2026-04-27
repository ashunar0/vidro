// @vitest-environment jsdom
// ADR 0035: 段階 hydration 機構 test。
//   - shell hydrate run で Suspense streaming branch は children を hold (= 評価しない)
//     + boundary range を cursor から skip する → cursor mismatch せず通過する
//   - boundary registry に push された entry は flushPending で walk され、fill 済みは
//     即 hydrate、未着は `window.__vidroPendingHydrate[id]` に保留される
//   - 後着 fill 経由 (= `__vidroFill` runtime が呼ぶ pending hydrate) で children の
//     event listener / effect が attach される
//   - resource の late-arriving lookup (cache 確定後でも window.__vidroResources を
//     経由で hit する) は resource-bootstrap.test.ts に保管 (本 test では DOM に集中)

import { describe, expect, test, beforeEach, afterEach } from "vite-plus/test";
import { h, _$text } from "../src/jsx";
import { hydrate } from "../src/hydrate";
import { Suspense } from "../src/suspense";
import { __resetVidroDataCache } from "../src/bootstrap";

// 各 test の clean state: bootstrap cache / window object / pending registry / DOM 残骸。
// `__vidroPendingHydrate` は実機の VIDRO_STREAMING_RUNTIME が `<head>` で空 object に
// 初期化する (`window.__vidroPendingHydrate = window.__vidroPendingHydrate || {};`)。
// jsdom test では runtime が走らないので、相当する初期化を beforeEach で simulate する。
beforeEach(() => {
  __resetVidroDataCache();
  for (const el of Array.from(document.querySelectorAll("#__vidro_data"))) el.remove();
  delete (globalThis as { __vidroResources?: unknown }).__vidroResources;
  (
    globalThis as unknown as { __vidroPendingHydrate: Record<string, () => void> }
  ).__vidroPendingHydrate = {};
});

afterEach(() => {
  for (const el of Array.from(document.body.querySelectorAll("[data-test-root]"))) el.remove();
});

function setupRoot(html: string): HTMLDivElement {
  const root = document.createElement("div");
  root.setAttribute("data-test-root", "");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe("段階 hydration (ADR 0035)", () => {
  test("shell hydrate: 未 fill な Suspense boundary は children を hold + pending registry に登録", () => {
    // SSR shell markup (fill 前): `<!--vb-vb0-start--> + fallback markup +
    // <!--vb-vb0-end--> + <!--suspense-->`。template element は別途 fill 待ち。
    const root = setupRoot(
      "<!--vb-vb0-start--><p>loading...</p><!--vb-vb0-end--><!--suspense-->" +
        '<template id="vidro-tpl-vb0"><button>resolved</button></template>',
    );

    let childrenEvaluated = 0;
    const App = () =>
      Suspense({
        fallback: () => h("p", null, _$text("loading...")),
        children: () => {
          childrenEvaluated++;
          return h("button", null, _$text("resolved"));
        },
      });

    hydrate(App, root);

    // shell hydrate 完了時点では children 評価ゼロ (hold されている)
    expect(childrenEvaluated).toBe(0);
    // pending registry に登録されている (template が居る = 未 fill 判定)
    const pending = (globalThis as { __vidroPendingHydrate?: Record<string, () => void> })
      .__vidroPendingHydrate;
    expect(pending?.["vb0"]).toBeDefined();
  });

  test("shell hydrate: fill 済み boundary は flushPending で即時 hydrate される", () => {
    // template が remove 済み = fill 完了 (ADR 0035 isBoundaryFilled の判定基準)。
    // start/end 間は resolved children (= button) が入っている。
    const root = setupRoot(
      "<!--vb-vb0-start--><button>resolved</button><!--vb-vb0-end--><!--suspense-->",
    );

    let childrenEvaluated = 0;
    let buttonClicks = 0;
    const App = () =>
      Suspense({
        fallback: () => h("p", null, _$text("loading...")),
        children: () => {
          childrenEvaluated++;
          return h("button", { onClick: () => buttonClicks++ }, _$text("resolved"));
        },
      });

    hydrate(App, root);

    // fill 済み → flushPending で即時 hydrate
    expect(childrenEvaluated).toBe(1);
    // button の event listener が attach されている
    (root.querySelector("button") as HTMLButtonElement).click();
    expect(buttonClicks).toBe(1);
    // pending registry には残らない (即時消化)
    const pending = (globalThis as { __vidroPendingHydrate?: Record<string, () => void> })
      .__vidroPendingHydrate;
    expect(pending?.["vb0"]).toBeUndefined();
  });

  test("後着 fill: pending hydrate runner を呼ぶと children が hydrate される", () => {
    // fill 前 markup + template。hydrate 時点では未 fill。
    const root = setupRoot(
      "<!--vb-vb0-start--><p>loading...</p><!--vb-vb0-end--><!--suspense-->" +
        '<template id="vidro-tpl-vb0"><button>resolved</button></template>',
    );

    let childrenEvaluated = 0;
    let buttonClicks = 0;
    const App = () =>
      Suspense({
        fallback: () => h("p", null, _$text("loading...")),
        children: () => {
          childrenEvaluated++;
          return h("button", { onClick: () => buttonClicks++ }, _$text("resolved"));
        },
      });

    hydrate(App, root);

    // shell hydrate 直後: children 未評価、pending 登録済み
    expect(childrenEvaluated).toBe(0);
    const pending = (globalThis as { __vidroPendingHydrate?: Record<string, () => void> })
      .__vidroPendingHydrate;
    const runner = pending?.["vb0"];
    expect(runner).toBeDefined();

    // boundary chunk 着 → __vidroFill 相当の DOM 操作を手で再現:
    //   1. template content を start/end 間に入れて fallback markup を remove
    //   2. template element を remove
    const start = findCommentInBody("vb-vb0-start")!;
    const end = findCommentInBody("vb-vb0-end")!;
    // fallback Node を remove
    let n = start.nextSibling;
    while (n && n !== end) {
      const next = n.nextSibling;
      n.parentNode!.removeChild(n);
      n = next;
    }
    const tpl = document.getElementById("vidro-tpl-vb0") as HTMLTemplateElement;
    end.parentNode!.insertBefore(tpl.content, end);
    tpl.remove();

    // pending runner を発火 (実機では VIDRO_STREAMING_RUNTIME の __vidroFill が呼ぶ)
    runner!();

    // children が hydrate された + event listener attach
    expect(childrenEvaluated).toBe(1);
    (root.querySelector("button") as HTMLButtonElement).click();
    expect(buttonClicks).toBe(1);
  });

  test("複数 Suspense: id は post-order で vb0, vb1, ... と採番される", () => {
    // 2 個の Suspense を並列に置く。client 側 StreamingHydrationContext.allocBoundaryId
    // は server-side StreamingContext と同規則で採番されるので、cursor 通過順 =
    // vb0 → vb1 になる。
    const root = setupRoot(
      "<div>" +
        "<!--vb-vb0-start--><p>fb-A</p><!--vb-vb0-end--><!--suspense-->" +
        "<!--vb-vb1-start--><p>fb-B</p><!--vb-vb1-end--><!--suspense-->" +
        "</div>" +
        '<template id="vidro-tpl-vb0"><span>A</span></template>' +
        '<template id="vidro-tpl-vb1"><span>B</span></template>',
    );

    const App = () =>
      h(
        "div",
        null,
        Suspense({
          fallback: () => h("p", null, _$text("fb-A")),
          children: () => h("span", null, _$text("A")),
        }),
        Suspense({
          fallback: () => h("p", null, _$text("fb-B")),
          children: () => h("span", null, _$text("B")),
        }),
      );

    hydrate(App, root);

    const pending = (globalThis as { __vidroPendingHydrate?: Record<string, () => void> })
      .__vidroPendingHydrate;
    expect(pending?.["vb0"]).toBeDefined();
    expect(pending?.["vb1"]).toBeDefined();
    expect(Object.keys(pending!).sort()).toEqual(["vb0", "vb1"]);
  });

  test("ADR 0035 review #2 fix: __vidroPendingHydrate 不在 + 未 fill → silent skip (mismatch しない)", () => {
    // VIDRO_STREAMING_RUNTIME が `<head>` に inject されない異常状態を simulate。
    // shell 内に未 fill な fallback markup が居ても、hydrate trigger 不能なので
    // 黙ってスキップする (旧実装は即時 tryHydrateBoundary を呼んで cursor mismatch
    // で throw していた)。実害はあるが silent の方が安全。
    delete (globalThis as { __vidroPendingHydrate?: unknown }).__vidroPendingHydrate;

    const root = setupRoot(
      "<!--vb-vb0-start--><p>loading...</p><!--vb-vb0-end--><!--suspense-->" +
        '<template id="vidro-tpl-vb0"><button>resolved</button></template>',
    );

    let childrenEvaluated = 0;
    const App = () =>
      Suspense({
        fallback: () => h("p", null, _$text("loading...")),
        children: () => {
          childrenEvaluated++;
          return h("button", null, _$text("resolved"));
        },
      });

    // throw しない (= silent skip path)
    expect(() => hydrate(App, root)).not.toThrow();
    // children は評価されない (boundary hydrate skip された)
    expect(childrenEvaluated).toBe(0);
  });

  test("ADR 0035 review #2 fix: __vidroPendingHydrate 不在 + fill 済み → 即時 hydrate される", () => {
    // runtime 不在でも fill 済み boundary は即時 hydrate される (= isBoundaryFilled
    // が template 不在を見て true を返す path)。
    delete (globalThis as { __vidroPendingHydrate?: unknown }).__vidroPendingHydrate;

    const root = setupRoot(
      "<!--vb-vb0-start--><button>resolved</button><!--vb-vb0-end--><!--suspense-->",
    );

    let childrenEvaluated = 0;
    let buttonClicks = 0;
    const App = () =>
      Suspense({
        fallback: () => h("p", null, _$text("loading...")),
        children: () => {
          childrenEvaluated++;
          return h("button", { onClick: () => buttonClicks++ }, _$text("resolved"));
        },
      });

    hydrate(App, root);

    expect(childrenEvaluated).toBe(1);
    (root.querySelector("button") as HTMLButtonElement).click();
    expect(buttonClicks).toBe(1);
  });

  test("ADR 0035 review #7 dev assertion: start/end marker 消失で console.warn", () => {
    // 普通に shell hydrate して pending registry に boundary が積まれる。
    // その後 boundary chunk が来る前に DOM から marker を remove (= server /
    // client 採番 desync で client 側だけが id を進めた状況の simulate)。
    // pending runner が呼ばれると findCommentMarker が null を返して warn 出力。
    const root = setupRoot(
      "<!--vb-vb0-start--><p>loading</p><!--vb-vb0-end--><!--suspense-->" +
        '<template id="vidro-tpl-vb0"><span>ok</span></template>',
    );

    hydrate(
      () =>
        Suspense({
          fallback: () => h("p", null, _$text("loading")),
          children: () => h("span", null, _$text("ok")),
        }),
      root,
    );

    const pending = (globalThis as { __vidroPendingHydrate?: Record<string, () => void> })
      .__vidroPendingHydrate;
    const runner = pending?.["vb0"];
    expect(runner).toBeDefined();

    // marker を DOM から削除 (desync simulate)
    for (const c of Array.from(root.childNodes)) {
      if (c.nodeType === Node.COMMENT_NODE) c.parentNode?.removeChild(c);
    }
    document.getElementById("vidro-tpl-vb0")?.remove();

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map((a) => String(a)).join(" "));
    try {
      runner!();
    } finally {
      console.warn = origWarn;
    }

    const desyncWarn = warnings.filter(
      (w) => w.includes('boundary "vb0"') && w.includes("not found"),
    );
    expect(desyncWarn.length).toBeGreaterThanOrEqual(1);
  });

  test("hydrate target に streaming marker が無ければ通常 hydrate (=未介入)", () => {
    // streaming SSR ではない普通の SSR markup。Suspense は通常 client mode で動く。
    const root = setupRoot("<button>plain</button>");

    let buttonClicks = 0;
    const App = () => h("button", { onClick: () => buttonClicks++ }, _$text("plain"));

    hydrate(App, root);

    // pending registry に何も登録されていない (= streaming hydrate 経路を通って
    // いない、 ctx 自体作られていない)。registry object は beforeEach で `{}` を
    // simulate 初期化済みなので、key が無いことだけ assert する。
    const pending =
      (globalThis as { __vidroPendingHydrate?: Record<string, () => void> })
        .__vidroPendingHydrate ?? {};
    expect(Object.keys(pending).length).toBe(0);
    // event listener attach 済み
    (root.querySelector("button") as HTMLButtonElement).click();
    expect(buttonClicks).toBe(1);
  });
});

function findCommentInBody(value: string): Comment | null {
  const iter = document.createNodeIterator(document.body, NodeFilter.SHOW_COMMENT);
  let n: Node | null;
  while ((n = iter.nextNode())) {
    if ((n as Comment).nodeValue === value) return n as Comment;
  }
  return null;
}
