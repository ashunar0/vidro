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
