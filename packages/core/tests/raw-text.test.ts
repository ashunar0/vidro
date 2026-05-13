// @vitest-environment jsdom
// F7 (= 第 25 周目 CRUD form dogfood で発見): raw text elements (= textarea / title) の dynamic child は
// `_$rawText` 経由で marker なし Text Node + effect で扱う。`_$dynamicChild` 経路は adjacent merge 防止の
// ために `_$marker()` (= empty comment) を周りに挟むが、HTML 仕様で raw text element の中はコメント
// parse されず visible リテラルになるため、Solid SSR と同様に marker を抜く。

import { describe, expect, test } from "vite-plus/test";
import { h, _$rawText, mount } from "../src/jsx";
import { signal } from "../src/signal";
import { hydrate } from "../src/hydrate";
import { renderToString } from "../src/render-to-string";

describe("_$rawText", () => {
  test("SSR: textarea の中身が marker なしで埋まる", () => {
    const App = () =>
      h(
        "textarea",
        null,
        _$rawText(() => "initial value"),
      );
    const html = renderToString(App);
    expect(html).toBe("<textarea>initial value</textarea>");
    expect(html).not.toContain("<!--");
  });

  test("SSR: title の中身も marker なしで埋まる", () => {
    const App = () =>
      h(
        "title",
        null,
        _$rawText(() => "Page Title"),
      );
    const html = renderToString(App);
    expect(html).toBe("<title>Page Title</title>");
  });

  test("SSR: empty string でも `<textarea></textarea>` で marker が残らない", () => {
    const App = () =>
      h(
        "textarea",
        null,
        _$rawText(() => ""),
      );
    const html = renderToString(App);
    expect(html).toBe("<textarea></textarea>");
    expect(html).not.toContain("<!--");
  });

  test("client (CSR): signal 更新で textarea の textContent が reactive 追従する", () => {
    const value = signal("first");
    const App = () =>
      h(
        "textarea",
        null,
        _$rawText(() => value.value),
      );
    const container = document.createElement("div");
    mount(App, container);

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    expect(textarea.firstChild?.textContent).toBe("first");

    value.value = "second";
    expect(textarea.firstChild?.textContent).toBe("second");
  });

  test("hydrate: SSR output から再開、Text Node を再利用する", () => {
    const App = () =>
      h(
        "textarea",
        null,
        _$rawText(() => "ssr value"),
      );
    const html = renderToString(App);
    const container = document.createElement("div");
    container.innerHTML = html;
    const textareaBefore = container.firstChild as HTMLTextAreaElement;
    const textNodeBefore = textareaBefore.firstChild;

    hydrate(App, container);

    expect(container.firstChild).toBe(textareaBefore);
    expect(textareaBefore.firstChild).toBe(textNodeBefore);
    expect(textareaBefore.firstChild?.textContent).toBe("ssr value");
  });
});
