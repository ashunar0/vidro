// @vitest-environment jsdom
import { describe, expect, test } from "vite-plus/test";
import { signal } from "../src/signal";
import { Show } from "../src/show";
import { mount } from "../src/jsx";

describe("Show", () => {
  test("when=true で children を表示", () => {
    const target = document.createElement("div");
    const child = document.createElement("p");
    child.textContent = "visible";

    mount(() => Show({ when: true, children: child }), target);
    expect(target.textContent).toBe("visible");
  });

  test("when=false で children を表示しない (fallback なし)", () => {
    const target = document.createElement("div");
    const child = document.createElement("p");
    child.textContent = "visible";

    mount(() => Show({ when: false, children: child }), target);
    expect(target.textContent).toBe("");
  });

  test("when=false で fallback を表示", () => {
    const target = document.createElement("div");
    const child = document.createElement("p");
    child.textContent = "visible";
    const fb = document.createElement("p");
    fb.textContent = "fallback";

    mount(() => Show({ when: false, children: child, fallback: fb }), target);
    expect(target.textContent).toBe("fallback");
  });

  test("Signal when の切替で children/fallback がスワップされる", () => {
    const target = document.createElement("div");
    const cond = signal(true);
    const child = document.createElement("p");
    child.textContent = "A";
    const fb = document.createElement("p");
    fb.textContent = "B";

    mount(() => Show({ when: cond, children: child, fallback: fb }), target);
    expect(target.textContent).toBe("A");

    cond.value = false;
    expect(target.textContent).toBe("B");

    cond.value = true;
    expect(target.textContent).toBe("A");
  });

  test("関数 when で依存追跡される", () => {
    const target = document.createElement("div");
    const count = signal(0);
    const child = document.createElement("p");
    child.textContent = "positive";

    mount(() => Show({ when: () => count.value > 0, children: child }), target);
    expect(target.textContent).toBe("");

    count.value = 5;
    expect(target.textContent).toBe("positive");

    count.value = 0;
    expect(target.textContent).toBe("");
  });

  test("children は同じ Node が再利用される (state 保持)", () => {
    const target = document.createElement("div");
    const cond = signal(true);
    const child = document.createElement("input");
    child.value = "typed"; // "state" を Node 自身に持たせて検証

    mount(() => Show({ when: cond, children: child }), target);
    const inputBefore = target.querySelector("input");
    expect(inputBefore?.value).toBe("typed");

    // toggle false → true
    cond.value = false;
    expect(target.querySelector("input")).toBeNull();

    cond.value = true;
    const inputAfter = target.querySelector("input");
    // 同一 Node 参照であることと、value が保持されていること
    expect(inputAfter).toBe(child);
    expect(inputAfter?.value).toBe("typed");
  });

  test("mount の dispose で内部 Effect も掃除される", () => {
    const target = document.createElement("div");
    const cond = signal(true);
    const child = document.createElement("p");
    child.textContent = "x";

    const dispose = mount(() => Show({ when: cond, children: child }), target);
    expect(target.textContent).toBe("x");

    dispose();
    // dispose 後に when を切り替えても Effect は反応しない
    cond.value = false;
    // child の親は target を離れ、anchor も外れてる
    expect(target.contains(child)).toBe(false);
  });
});
