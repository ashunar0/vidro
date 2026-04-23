// @vitest-environment jsdom
import { describe, expect, test } from "vite-plus/test";
import { signal } from "../src/signal";
import { Switch, Match } from "../src/switch";
import { mount } from "../src/jsx";

describe("Switch / Match", () => {
  test("最初に true の Match の children を表示", () => {
    const target = document.createElement("div");
    const a = document.createElement("p");
    a.textContent = "A";
    const b = document.createElement("p");
    b.textContent = "B";

    mount(
      () =>
        Switch({
          children: [Match({ when: false, children: a }), Match({ when: true, children: b })],
        }),
      target,
    );
    expect(target.textContent).toBe("B");
  });

  test("早い者勝ち (複数 true でも最初の 1 つのみ)", () => {
    const target = document.createElement("div");
    const a = document.createElement("p");
    a.textContent = "A";
    const b = document.createElement("p");
    b.textContent = "B";

    mount(
      () =>
        Switch({
          children: [Match({ when: true, children: a }), Match({ when: true, children: b })],
        }),
      target,
    );
    expect(target.textContent).toBe("A");
  });

  test("全 Match false で fallback を表示", () => {
    const target = document.createElement("div");
    const a = document.createElement("p");
    a.textContent = "A";
    const fb = document.createElement("p");
    fb.textContent = "fb";

    mount(
      () =>
        Switch({
          fallback: fb,
          children: [Match({ when: false, children: a })],
        }),
      target,
    );
    expect(target.textContent).toBe("fb");
  });

  test("全 Match false + fallback 無しで何も表示しない", () => {
    const target = document.createElement("div");
    const a = document.createElement("p");
    a.textContent = "A";

    mount(
      () =>
        Switch({
          children: [Match({ when: false, children: a })],
        }),
      target,
    );
    expect(target.textContent).toBe("");
  });

  test("Signal state の変更で branch が swap される", () => {
    const target = document.createElement("div");
    const state = signal<"loading" | "error" | "ok">("loading");
    const loading = document.createElement("p");
    loading.textContent = "loading";
    const error = document.createElement("p");
    error.textContent = "error";
    const ok = document.createElement("p");
    ok.textContent = "ok";

    mount(
      () =>
        Switch({
          children: [
            Match({ when: () => state.value === "loading", children: loading }),
            Match({ when: () => state.value === "error", children: error }),
            Match({ when: () => state.value === "ok", children: ok }),
          ],
        }),
      target,
    );
    expect(target.textContent).toBe("loading");

    state.value = "error";
    expect(target.textContent).toBe("error");

    state.value = "ok";
    expect(target.textContent).toBe("ok");
  });

  test("同じ Node 参照が再利用される (state 保持)", () => {
    const target = document.createElement("div");
    const flag = signal(true);
    const a = document.createElement("input");
    a.value = "typed";
    const b = document.createElement("p");
    b.textContent = "B";

    mount(
      () =>
        Switch({
          children: [
            Match({ when: flag, children: a }),
            Match({ when: () => !flag.value, children: b }),
          ],
        }),
      target,
    );
    expect(target.querySelector("input")?.value).toBe("typed");

    flag.value = false;
    expect(target.querySelector("input")).toBeNull();
    expect(target.textContent).toBe("B");

    flag.value = true;
    expect(target.querySelector("input")).toBe(a);
    expect(target.querySelector("input")?.value).toBe("typed");
  });

  test("mount dispose で Effect が掃除される", () => {
    const target = document.createElement("div");
    const cond = signal(true);
    const a = document.createElement("p");
    a.textContent = "A";

    const dispose = mount(
      () =>
        Switch({
          children: [Match({ when: cond, children: a })],
        }),
      target,
    );
    expect(target.textContent).toBe("A");

    dispose();
    cond.value = false;
    expect(target.contains(a)).toBe(false);
  });

  test("children に Match 以外が混ざっていても無視される", () => {
    const target = document.createElement("div");
    const a = document.createElement("p");
    a.textContent = "A";
    const stray = document.createElement("p");
    stray.textContent = "stray";

    mount(
      () =>
        Switch({
          children: [
            stray, // 生の Node は collectMatches で無視される
            Match({ when: true, children: a }),
          ],
        }),
      target,
    );
    expect(target.textContent).toBe("A");
  });
});
