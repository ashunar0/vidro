// @vitest-environment jsdom
// Step B-3a: hydrate(fn, target) が SSR で焼かれた既存 DOM に effect / event listener
// を attach し、DOM を再生成しないことの確認 (ADR 0019)。
//
// transform 経由の出力を test 内で手書きするため、`_$text` / `_$dynamicChild` を
// 直接 import して使う。

import { describe, expect, test } from "vite-plus/test";
import { h, _$text, _$dynamicChild } from "../src/jsx";
import { signal } from "../src/signal";
import { hydrate } from "../src/hydrate";
import { renderToString } from "../src/render-to-string";
import { ErrorBoundary } from "../src/error-boundary";
import { Show } from "../src/show";
import { Switch, Match } from "../src/switch";
import { For } from "../src/for";

const ssrInto = (fn: () => Node): HTMLDivElement => {
  const html = renderToString(fn);
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
};

describe("hydrate", () => {
  test("plain text: SSR の DOM Node を再生成せず再利用する", () => {
    const App = () => h("h1", null, _$text("Hello"));
    const container = ssrInto(App);
    const h1Before = container.firstChild;
    const textBefore = h1Before?.firstChild;

    hydrate(App, container);

    expect(container.firstChild).toBe(h1Before);
    expect(container.firstChild?.firstChild).toBe(textBefore);
    expect(container.textContent).toBe("Hello");
  });

  test("nested elements も同一 Node を再利用する", () => {
    const App = () =>
      h("div", { class: "root" }, h("h1", null, _$text("T")), h("p", null, _$text("body")));
    const container = ssrInto(App);
    const divBefore = container.firstChild as HTMLElement;
    const h1Before = divBefore.firstChild;
    const pBefore = divBefore.lastChild;

    hydrate(App, container);

    expect(container.firstChild).toBe(divBefore);
    expect(divBefore.firstChild).toBe(h1Before);
    expect(divBefore.lastChild).toBe(pBefore);
    expect(divBefore.outerHTML).toBe('<div class="root"><h1>T</h1><p>body</p></div>');
  });

  test("event listener が hydrate で attach される", () => {
    let clicks = 0;
    const App = () => h("button", { onClick: () => clicks++ }, _$text("Click me"));
    const container = ssrInto(App);

    // hydrate 前は listener 無し: click しても clicks は 0
    (container.querySelector("button") as HTMLButtonElement).click();
    expect(clicks).toBe(0);

    hydrate(App, container);
    (container.querySelector("button") as HTMLButtonElement).click();
    expect(clicks).toBe(1);
  });

  test("signal の更新で dynamic text が再描画される (Node は同一)", () => {
    const count = signal(0);
    const App = () =>
      h(
        "p",
        null,
        _$dynamicChild(() => count.value),
      );
    const container = ssrInto(App);
    const pBefore = container.firstChild;
    const textBefore = pBefore?.firstChild;

    hydrate(App, container);
    expect(container.textContent).toBe("0");

    count.value = 7;
    expect(container.textContent).toBe("7");
    // signal 更新でも DOM Node は再生成されず、text の data だけ更新される
    expect(container.firstChild).toBe(pBefore);
    expect(container.firstChild?.firstChild).toBe(textBefore);
  });

  test("dynamic attribute (function value) が effect で update される", () => {
    const cls = signal("a");
    const App = () => h("div", { class: () => cls.value }, _$text("x"));
    const container = ssrInto(App);
    const divBefore = container.firstChild as HTMLElement;
    expect(divBefore.className).toBe("a");

    hydrate(App, container);
    cls.value = "b";
    expect(divBefore.className).toBe("b");
    // 同一 element instance であること
    expect(container.firstChild).toBe(divBefore);
  });

  test("dispose で effect が解放される (DOM はそのまま残る)", () => {
    const count = signal(0);
    const App = () =>
      h(
        "p",
        null,
        _$dynamicChild(() => count.value),
      );
    const container = ssrInto(App);

    const dispose = hydrate(App, container);
    count.value = 1;
    expect(container.textContent).toBe("1");

    dispose();
    count.value = 99;
    // dispose 後は effect が解放されているので text は更新されない
    expect(container.textContent).toBe("1");
    // DOM は残ってる (mount と違って hydrate は dispose 時に DOM 削除しない)
    expect(container.firstChild).not.toBeNull();
  });

  test("ErrorBoundary を含む subtree が cursor 整合で hydrate できる (B-3c-1)", () => {
    // server: ErrorBoundary が `<contentNode><!--error-boundary-->` を吐く。
    // hydrate 時は HydrationRenderer が content の中身 + anchor を post-order で
    // 消費し、event listener を attach する。
    let clicks = 0;
    const App = () =>
      ErrorBoundary({
        fallback: (err) => h("p", null, _$text(`failed: ${(err as Error).message}`)),
        onError: () => {},
        children: () => h("button", { onClick: () => clicks++ }, _$text("ok")),
      });
    const container = ssrInto(App);
    // SSR markup は `<button>ok</button><!--error-boundary-->` の形になっているはず
    expect(container.innerHTML).toBe("<button>ok</button><!--error-boundary-->");
    const buttonBefore = container.firstChild;

    hydrate(App, container);

    // hydrate 後も同じ Node、event listener が attach されてる
    expect(container.firstChild).toBe(buttonBefore);
    (container.querySelector("button") as HTMLButtonElement).click();
    expect(clicks).toBe(1);
    // anchor も維持
    expect(container.lastChild?.nodeType).toBe(Node.COMMENT_NODE);
  });

  test("Show: when 静的 true で children を hydrate (B-3c-2)", () => {
    // 注: B-3c-2 では `<Show fallback={<X />}>{<Y />}</Show>` のような fallback あり
    // ケースは hydrate cursor mismatch する (children/fallback 両方 eager 評価され
    // SSR markup には active 1 つしか出ないため)。完全対応は B-4 (children getter 化)。
    // ここではシンプルケース (fallback 無し + when 静的 true) のみ確認する。
    const App = () => Show({ when: true, children: () => h("p", null, _$text("visible")) });
    const container = ssrInto(App);
    expect(container.innerHTML).toBe("<p>visible</p><!--show-->");
    const pBefore = container.firstChild;

    hydrate(App, container);

    expect(container.firstChild).toBe(pBefore);
    expect(container.textContent).toBe("visible");
    expect(container.lastChild?.nodeType).toBe(Node.COMMENT_NODE);
  });

  test("Show: when 静的 false + fallback 無し で anchor のみ hydrate (B-3c-2)", () => {
    const App = () => Show({ when: false, children: () => h("p", null, _$text("hidden")) });
    // 注: children Node は h() 評価で作られるが server fragment には入らない (active が
    // 無いため)。client hydrate 時も h() 評価で children Node が作られるが、これは
    // cursor を消費する。children = h("p", null, _$text("hidden")) → createText("hidden")
    // + createElement("p") の cursor 消費が必要だが target には無いので mismatch する。
    // → B-4 で children getter 化されると初めてこのケースが動く。
    //
    // 今回は SSR markup の確認だけ行う (server で active 無し → anchor のみ)。
    const html = renderToString(App);
    expect(html).toBe("<!--show-->");
  });

  test("Switch: 単一 Match true で hydrate (B-3c-3)", () => {
    // 注: B-3c-3 では複数 Match や fallback ありケースは inactive children も
    // eager 評価されて cursor mismatch する。完全対応は B-4 (children getter 化)。
    // ここでは「Match 1 個 + when 静的 true」のシンプルケースのみ確認する。
    const App = () =>
      Switch({
        children: [Match({ when: true, children: () => h("p", null, _$text("A")) })],
      });
    const container = ssrInto(App);
    expect(container.innerHTML).toBe("<p>A</p><!--switch-->");
    const pBefore = container.firstChild;

    hydrate(App, container);

    expect(container.firstChild).toBe(pBefore);
    expect(container.textContent).toBe("A");
    expect(container.lastChild?.nodeType).toBe(Node.COMMENT_NODE);
  });

  test("Switch: 全 Match false + fallback 無し で anchor のみ SSR (B-3c-3)", () => {
    // children Node が h() で評価されて cursor を消費する点は Show と同じく
    // fallback 無しでも複数 Match では mismatch しうる。SSR markup の確認のみ。
    const App = () =>
      Switch({
        children: [Match({ when: false, children: () => h("p", null, _$text("X")) })],
      });
    const html = renderToString(App);
    expect(html).toBe("<!--switch-->");
  });

  test("For: list 非空 + fallback 無し で hydrate (B-3c-4)", () => {
    // For の children は元々関数 (item, index) => Node なので、Show / Switch と
    // 違って inactive children の eager 評価問題がない。fallback だけが eager
    // 評価される (B-4 持ち越し)。
    const items = ["a", "b", "c"];
    const App = () =>
      For({
        each: items,
        children: (item) => h("li", null, _$text(item)),
      });
    const container = document.createElement("ul");
    container.innerHTML = renderToString(App);
    expect(container.innerHTML).toBe("<li>a</li><li>b</li><li>c</li><!--for-->");
    const liA = container.children[0];

    hydrate(App, container);

    // 同一 Node 再利用 (DOM 再生成なし)
    expect(container.children[0]).toBe(liA);
    expect(container.textContent).toBe("abc");
    expect(container.lastChild?.nodeType).toBe(Node.COMMENT_NODE);
  });

  test("For: 空リスト + fallback あり で hydrate (B-3c-4)", () => {
    const App = () =>
      For({
        each: [] as string[],
        fallback: () => h("p", null, _$text("empty")),
        children: (item) => h("li", null, _$text(item)),
      });
    const container = document.createElement("div");
    container.innerHTML = renderToString(App);
    expect(container.innerHTML).toBe("<p>empty</p><!--for-->");
    const pBefore = container.firstChild;

    hydrate(App, container);

    expect(container.firstChild).toBe(pBefore);
    expect(container.textContent).toBe("empty");
  });

  test("For: 空リスト + fallback 無し は anchor のみ SSR (B-3c-4)", () => {
    const App = () =>
      For({
        each: [] as string[],
        children: (item) => h("li", null, _$text(item)),
      });
    expect(renderToString(App)).toBe("<!--for-->");
  });

  test("ErrorBoundary 内 throw → hydrate で fallback に切り替わる (B-3c-1)", () => {
    // server: children が throw → fallback の出力 (= `<p>fallback</p>`) + anchor が SSR markup に焼かれる
    // hydrate: client でも同じく throw → fallback、cursor は fallback 出力 + anchor を消費する
    const App = () =>
      ErrorBoundary({
        fallback: () => h("p", null, _$text("fb")),
        onError: () => {},
        children: () => {
          throw new Error("server-render-fail");
        },
      });
    const container = ssrInto(App);
    expect(container.innerHTML).toBe("<p>fb</p><!--error-boundary-->");
    const pBefore = container.firstChild;

    hydrate(App, container);

    // hydrate 後も同じ p Node を使う (fallback DOM の再生成なし)
    expect(container.firstChild).toBe(pBefore);
    expect(container.textContent).toBe("fb");
  });

  test("Show: fallback あり + when=true で children のみ hydrate (B-4 完全 hydrate)", () => {
    // B-3c-2 では fallback も eager 評価されて cursor mismatch していたケース。
    // B-4 で children/fallback が getter 化され、active branch のみ評価されるため
    // 完全 hydrate できる (ADR 0025)。
    const App = () =>
      Show({
        when: true,
        children: () => h("p", null, _$text("visible")),
        fallback: () => h("span", null, _$text("hidden")),
      });
    const container = ssrInto(App);
    expect(container.innerHTML).toBe("<p>visible</p><!--show-->");
    const pBefore = container.firstChild;

    hydrate(App, container);

    expect(container.firstChild).toBe(pBefore);
    expect(container.textContent).toBe("visible");
  });

  test("Show: fallback あり + when=false で fallback のみ hydrate (B-4 完全 hydrate)", () => {
    const App = () =>
      Show({
        when: false,
        children: () => h("p", null, _$text("visible")),
        fallback: () => h("span", null, _$text("empty")),
      });
    const container = ssrInto(App);
    expect(container.innerHTML).toBe("<span>empty</span><!--show-->");
    const spanBefore = container.firstChild;

    hydrate(App, container);

    expect(container.firstChild).toBe(spanBefore);
    expect(container.textContent).toBe("empty");
  });

  test("Switch: 複数 Match + 1 つ true で active のみ hydrate (B-4 完全 hydrate)", () => {
    // B-3c-3 では inactive Match の child も eager 評価されて cursor mismatch
    // していたケース。B-4 で readChild getter 化され active のみ呼ぶため完全 hydrate。
    const App = () =>
      Switch({
        children: [
          Match({ when: false, children: () => h("p", null, _$text("A")) }),
          Match({ when: true, children: () => h("p", null, _$text("B")) }),
          Match({ when: false, children: () => h("p", null, _$text("C")) }),
        ],
      });
    const container = ssrInto(App);
    expect(container.innerHTML).toBe("<p>B</p><!--switch-->");
    const pBefore = container.firstChild;

    hydrate(App, container);

    expect(container.firstChild).toBe(pBefore);
    expect(container.textContent).toBe("B");
  });

  test("Switch: fallback あり + 全 Match false で fallback のみ hydrate (B-4 完全 hydrate)", () => {
    const App = () =>
      Switch({
        fallback: () => h("p", null, _$text("none")),
        children: [
          Match({ when: false, children: () => h("p", null, _$text("A")) }),
          Match({ when: false, children: () => h("p", null, _$text("B")) }),
        ],
      });
    const container = ssrInto(App);
    expect(container.innerHTML).toBe("<p>none</p><!--switch-->");
    const pBefore = container.firstChild;

    hydrate(App, container);

    expect(container.firstChild).toBe(pBefore);
    expect(container.textContent).toBe("none");
  });

  test("For: list 非空 + fallback あり で items のみ hydrate (B-4 完全 hydrate)", () => {
    // B-3c-4 では fallback Node が h() で eager 評価されて cursor 過剰消費 →
    // mismatch していたケース。B-4 で fallback も getter 化、each が空でない時は
    // 呼ばれないため完全 hydrate。
    const App = () =>
      For({
        each: ["a", "b"],
        fallback: () => h("p", null, _$text("empty")),
        children: (item) => h("li", null, _$text(item)),
      });
    const container = document.createElement("ul");
    container.innerHTML = renderToString(App);
    expect(container.innerHTML).toBe("<li>a</li><li>b</li><!--for-->");
    const liA = container.children[0];

    hydrate(App, container);

    expect(container.children[0]).toBe(liA);
    expect(container.textContent).toBe("ab");
  });

  test("ErrorBoundary: 普通の JSX 風 children (transform 経由) でも hydrate できる (B-4 forward-compat)", () => {
    // ADR 0004 で約束した forward-compat: B-4 後は `<ErrorBoundary><Child /></ErrorBoundary>`
    // も書けるようになる。test では transform 出力 (= `() => h(Child)`) を手書きで
    // simulate して、ErrorBoundary が children() を呼んで動くことを確認する。
    const App = () =>
      ErrorBoundary({
        fallback: () => h("p", null, _$text("err")),
        onError: () => {},
        children: () => h("p", null, _$text("ok")),
      });
    const container = ssrInto(App);
    expect(container.innerHTML).toBe("<p>ok</p><!--error-boundary-->");
    const pBefore = container.firstChild;

    hydrate(App, container);

    expect(container.firstChild).toBe(pBefore);
    expect(container.textContent).toBe("ok");
  });

  test("text content mismatch は warn + override", () => {
    const App = () => h("h1", null, _$text("expected"));
    const container = document.createElement("div");
    container.innerHTML = "<h1>stale</h1>";

    const warns: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args);
    try {
      hydrate(App, container);
    } finally {
      console.warn = orig;
    }

    expect(container.textContent).toBe("expected");
    expect(warns.length).toBe(1);
    expect(String(warns[0]?.[0])).toContain("text mismatch");
  });
});
