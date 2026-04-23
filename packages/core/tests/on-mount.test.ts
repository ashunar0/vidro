// @vitest-environment jsdom
import { describe, expect, test, vi } from "vite-plus/test";
import { mount } from "../src/jsx";
import { onMount } from "../src/mount-queue";

describe("onMount", () => {
  test("mount 完了後に fn が呼ばれる", () => {
    const target = document.createElement("div");
    const fn = vi.fn();
    mount(() => {
      onMount(fn);
      return document.createElement("p");
    }, target);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("fn が呼ばれる時点で要素は target に attach 済み", () => {
    const target = document.createElement("div");
    document.body.append(target);
    let parentAtMount: Node | null = null;
    mount(() => {
      const p = document.createElement("p");
      onMount(() => {
        parentAtMount = p.parentNode;
      });
      return p;
    }, target);
    expect(parentAtMount).toBe(target);
    target.remove();
  });

  test("複数の onMount は登録順に呼ばれる", () => {
    const target = document.createElement("div");
    const order: number[] = [];
    mount(() => {
      onMount(() => order.push(1));
      onMount(() => order.push(2));
      onMount(() => order.push(3));
      return document.createElement("p");
    }, target);
    expect(order).toEqual([1, 2, 3]);
  });

  test("mount scope 外での呼び出しは warn + no-op", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fn = vi.fn();
      onMount(fn);
      expect(fn).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("dispose 後の mount でも clean な queue で動く (前回の残りが走らない)", () => {
    const target = document.createElement("div");
    const fn1 = vi.fn();
    const dispose1 = mount(() => {
      onMount(fn1);
      return document.createElement("p");
    }, target);
    expect(fn1).toHaveBeenCalledTimes(1);
    dispose1();

    const fn2 = vi.fn();
    mount(() => {
      onMount(fn2);
      return document.createElement("p");
    }, target);
    // fn1 は 1 回のみ (2 回目の mount で再発火しない)、fn2 は 1 回
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  test("fn が throw した場合は例外が伝播する", () => {
    const target = document.createElement("div");
    expect(() => {
      mount(() => {
        onMount(() => {
          throw new Error("boom");
        });
        return document.createElement("p");
      }, target);
    }).toThrow("boom");
  });

  test("前の onMount で throw された場合、後続の onMount は呼ばれない", () => {
    const target = document.createElement("div");
    const afterBoom = vi.fn();
    expect(() => {
      mount(() => {
        onMount(() => {
          throw new Error("boom");
        });
        onMount(afterBoom);
        return document.createElement("p");
      }, target);
    }).toThrow("boom");
    expect(afterBoom).not.toHaveBeenCalled();
  });

  test("nested mount: 外側 mount の onMount fn 内で新たに mount() を呼ぶと内側の onMount も走る", () => {
    const outer = document.createElement("div");
    const inner = document.createElement("div");
    const outerFn = vi.fn();
    const innerFn = vi.fn();
    mount(() => {
      onMount(() => {
        outerFn();
        mount(() => {
          onMount(innerFn);
          return document.createElement("span");
        }, inner);
      });
      return document.createElement("p");
    }, outer);
    expect(outerFn).toHaveBeenCalledTimes(1);
    expect(innerFn).toHaveBeenCalledTimes(1);
  });
});
