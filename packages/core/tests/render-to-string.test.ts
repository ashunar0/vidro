// @vitest-environment node
import { describe, expect, test } from "vite-plus/test";
import { h, Fragment } from "../src/jsx";
import { signal } from "../src/signal";
import { effect } from "../src/effect";
import { onMount } from "../src/mount-queue";
import { renderToString } from "../src/render-to-string";

// Step B-2a: server renderer + renderToString の挙動確認。
// node 環境 (document / window なし) で動くこと自体が universal renderer 成立の証明。

describe("renderToString", () => {
  test("plain element", () => {
    const html = renderToString(() => h("h1", null, "Hello"));
    expect(html).toBe("<h1>Hello</h1>");
  });

  test("nested elements", () => {
    const html = renderToString(() => h("div", null, h("h1", null, "Title"), h("p", null, "body")));
    expect(html).toBe("<div><h1>Title</h1><p>body</p></div>");
  });

  test("attributes", () => {
    const html = renderToString(() => h("a", { href: "/x", id: "link" }, "Link"));
    // 出現順は Object.entries 順 = 挿入順
    expect(html).toBe('<a href="/x" id="link">Link</a>');
  });

  test("className / style object", () => {
    const html = renderToString(() =>
      h(
        "div",
        {
          class: "box active",
          style: { backgroundColor: "red", marginTop: 10 },
        },
        "X",
      ),
    );
    expect(html).toBe('<div class="box active" style="background-color:red;margin-top:10">X</div>');
  });

  test("reactive text (signal.value via effect)", () => {
    const count = signal(42);
    // A 方式 transform 後のコード相当: `{count.value}` → `() => count.value`
    const html = renderToString(() => h("p", null, () => count.value));
    expect(html).toBe("<p>42</p>");
  });

  test("server mode effect は body を 1 回だけ走らせる", () => {
    const count = signal(0);
    let runs = 0;
    const html = renderToString(() => {
      effect(() => {
        void count.value; // subscribe ではなく初期値 peek だけ
        runs++;
      });
      return h("span", null, "x");
    });
    expect(html).toBe("<span>x</span>");
    expect(runs).toBe(1);

    // server mode の effect は subscribe しないので、後から count を書き換えても
    // runs は増えない
    count.value = 99;
    expect(runs).toBe(1);
  });

  test("onMount は server では呼ばれない", () => {
    let mounted = false;
    const html = renderToString(() => {
      onMount(() => {
        mounted = true;
      });
      return h("div", null, "ok");
    });
    expect(html).toBe("<div>ok</div>");
    expect(mounted).toBe(false);
  });

  test("event handler は attribute に出さず捨てる", () => {
    const html = renderToString(() => h("button", { onClick: () => {} }, "Click"));
    expect(html).toBe("<button>Click</button>");
  });

  test("void element (br / img) は自己閉じ", () => {
    const html = renderToString(() => h("div", null, h("br", null), h("img", { src: "/a.png" })));
    expect(html).toBe('<div><br><img src="/a.png"></div>');
  });

  test("text content の HTML escape", () => {
    const html = renderToString(() => h("p", null, "<script>alert('x')</script> & more"));
    expect(html).toBe("<p>&lt;script&gt;alert('x')&lt;/script&gt; &amp; more</p>");
  });

  test("attribute の HTML escape", () => {
    const html = renderToString(() => h("a", { title: `quote "x" & <tag>` }, "t"));
    // attribute 内の `>` は HTML 仕様上 escape 不要 (`<` / `&` / `"` だけ escape)
    expect(html).toBe('<a title="quote &quot;x&quot; &amp; &lt;tag>">t</a>');
  });

  test("Fragment は open/close tag を出さない", () => {
    const html = renderToString(() =>
      h(Fragment, null, h("span", null, "A"), h("span", null, "B")),
    );
    expect(html).toBe("<span>A</span><span>B</span>");
  });

  test("value property は attribute に展開 (form 初期値)", () => {
    const html = renderToString(() => h("input", { value: "abc" }));
    // value は PROPS_AS_PROPERTY で setProperty 経由 → serialize で attribute 化
    expect(html).toBe('<input value="abc">');
  });

  test("checked (true) は真偽 attribute", () => {
    const html = renderToString(() => h("input", { type: "checkbox", checked: true }));
    expect(html).toBe('<input type="checkbox" checked>');
  });
});
