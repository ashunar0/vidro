import { describe, expect, test, vi } from "vite-plus/test";
import { Signal, signal, untrack } from "../src/index";

describe("Signal", () => {
  describe("両形式", () => {
    test("new Signal(0) が動く", () => {
      const count = new Signal(0);
      expect(count.value).toBe(0);
    });

    test("signal(0) は Signal インスタンスを返す", () => {
      const count = signal(0);
      expect(count).toBeInstanceOf(Signal);
      expect(count.value).toBe(0);
    });
  });

  describe("read / write", () => {
    test("value setter で値が更新される", () => {
      const count = new Signal(0);
      count.value = 1;
      expect(count.value).toBe(1);
    });

    test("value++ も getter/setter 経由で動く", () => {
      const count = new Signal(0);
      count.value++;
      expect(count.value).toBe(1);
    });
  });

  describe("subscribe", () => {
    test("変更時に subscriber が呼ばれる", () => {
      const count = new Signal(0);
      const fn = vi.fn();
      count.subscribe(fn);
      count.value = 1;
      expect(fn).toHaveBeenCalledWith(1);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test("返り値の unsubscribe 関数で解除できる", () => {
      const count = new Signal(0);
      const fn = vi.fn();
      const unsubscribe = count.subscribe(fn);
      count.value = 1;
      unsubscribe();
      count.value = 2;
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test("複数 subscriber 全員に通知される", () => {
      const count = new Signal(0);
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      count.subscribe(fn1);
      count.subscribe(fn2);
      count.value = 1;
      expect(fn1).toHaveBeenCalledWith(1);
      expect(fn2).toHaveBeenCalledWith(1);
    });

    test("通知は同期 (書いた次の行で反映済み)", () => {
      const count = new Signal(0);
      let latest = -1;
      count.subscribe((v) => {
        latest = v;
      });
      count.value = 1;
      expect(latest).toBe(1);
    });
  });

  describe("等価性判定 (Object.is)", () => {
    test("同値への書き込みは通知しない", () => {
      const count = new Signal(0);
      const fn = vi.fn();
      count.subscribe(fn);
      count.value = 0;
      expect(fn).not.toHaveBeenCalled();
    });

    test("NaN → NaN は通知しない (Object.is の性質)", () => {
      const s = new Signal(NaN);
      const fn = vi.fn();
      s.subscribe(fn);
      s.value = NaN;
      expect(fn).not.toHaveBeenCalled();
    });

    test("+0 と -0 は別物として通知される", () => {
      const s = new Signal(+0);
      const fn = vi.fn();
      s.subscribe(fn);
      s.value = -0;
      expect(fn).toHaveBeenCalledWith(-0);
    });

    test("異なる配列参照は通知される", () => {
      const s = new Signal<number[]>([]);
      const fn = vi.fn();
      s.subscribe(fn);
      s.value = [...s.value, 1];
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test("同じ配列参照への再代入は通知されない (mutation の罠)", () => {
      const arr: number[] = [];
      const s = new Signal(arr);
      const fn = vi.fn();
      s.subscribe(fn);
      arr.push(1);
      s.value = arr;
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe("peek()", () => {
    test("現在値を返す", () => {
      const count = new Signal(42);
      expect(count.peek()).toBe(42);
    });
  });

  describe("untrack()", () => {
    test("fn の結果を返す", () => {
      const count = new Signal(42);
      const result = untrack(() => count.value);
      expect(result).toBe(42);
    });
  });
});
