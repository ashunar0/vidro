// @vitest-environment jsdom
import { describe, expect, test } from "vite-plus/test";
import { Signal } from "../src/signal";
import { h, mount } from "../src/jsx";

// A 方式 transform が `{expr}` を `() => expr` に包むので、runtime は child として
// 関数を受け取る。返り値が Array / Node / primitive / Signal のそれぞれで期待通りに
// 振る舞うことを確認する。
describe("appendChild: function child の返り値ハンドリング", () => {
  test("関数が Array を返すと static に展開される", () => {
    const target = document.createElement("div");
    const items = ["A", "B", "C"].map((t) => {
      const li = document.createElement("li");
      li.textContent = t;
      return li;
    });

    mount(() => h("ul", null, () => items), target);

    const lis = target.querySelectorAll("li");
    expect(lis.length).toBe(3);
    expect(lis[0].textContent).toBe("A");
    expect(lis[2].textContent).toBe("C");
  });

  test("関数が Node を返すと static に挿入される", () => {
    const target = document.createElement("div");
    const node = document.createElement("span");
    node.textContent = "inline";

    mount(() => h("p", null, () => node), target);

    expect(target.querySelector("p > span")?.textContent).toBe("inline");
  });

  test("関数が primitive を返すと reactive text として動く", () => {
    const target = document.createElement("div");
    const count = new Signal(0);

    mount(() => h("p", null, () => count.value), target);
    expect(target.textContent).toBe("0");

    count.value = 42;
    expect(target.textContent).toBe("42");
  });

  test("関数が Signal を返すと unwrap されて reactive text になる", () => {
    const target = document.createElement("div");
    const count = new Signal(7);

    // `{count}` が transform されて `() => count` になるケースを再現
    mount(() => h("p", null, () => count), target);
    expect(target.textContent).toBe("7");

    count.value = 99;
    expect(target.textContent).toBe("99");
  });

  test("静的配列の中で Signal を混ぜても初回挿入のみ (reactive にはならない)", () => {
    const target = document.createElement("div");
    const sig = new Signal("live");
    const staticLi = document.createElement("li");
    staticLi.textContent = "static";
    const items = [staticLi, () => sig.value] as unknown[];

    mount(() => h("ul", null, () => items), target);
    // 初回評価時点で "live" が挿入されている
    expect(target.textContent).toContain("static");
    expect(target.textContent).toContain("live");
  });
});
