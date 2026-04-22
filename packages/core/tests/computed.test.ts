import { describe, expect, test, vi } from "vite-plus/test";
import { Signal } from "../src/signal";
import { Effect } from "../src/effect";
import { Computed, computed } from "../src/computed";
import { untrack } from "../src/observer";
import { Owner } from "../src/owner";

describe("Computed", () => {
  describe("両形式", () => {
    test("new Computed(fn) は Computed インスタンスを返す", () => {
      const c = new Computed(() => 1);
      expect(c).toBeInstanceOf(Computed);
    });
    test("computed(fn) も Computed インスタンスを返す", () => {
      const c = computed(() => 1);
      expect(c).toBeInstanceOf(Computed);
    });
  });

  describe("基本動作", () => {
    test(".value で計算結果が取れる", () => {
      const count = new Signal(3);
      const doubled = new Computed(() => count.value * 2);
      expect(doubled.value).toBe(6);
    });

    test("依存 Signal の変更で値が追従する", () => {
      const count = new Signal(3);
      const doubled = new Computed(() => count.value * 2);
      expect(doubled.value).toBe(6);
      count.value = 10;
      expect(doubled.value).toBe(20);
    });

    test("lazy: .value を読むまで fn は走らない", () => {
      const fn = vi.fn(() => 42);
      new Computed(fn);
      expect(fn).toHaveBeenCalledTimes(0);
    });

    test("cache: 依存変更なしで複数回 .value を読んでも fn は 1 回", () => {
      const count = new Signal(1);
      const fn = vi.fn(() => count.value * 2);
      const c = new Computed(fn);
      void c.value;
      void c.value;
      void c.value;
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test("依存が変わると次の .value で再計算される", () => {
      const count = new Signal(1);
      const fn = vi.fn(() => count.value * 2);
      const c = new Computed(fn);
      void c.value;
      expect(fn).toHaveBeenCalledTimes(1);
      count.value = 2;
      expect(fn).toHaveBeenCalledTimes(1);
      void c.value;
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe("Effect との連携", () => {
    test("Effect 内で Computed を読むと、依存 Signal 変更で Effect が再実行される", () => {
      const count = new Signal(1);
      const doubled = new Computed(() => count.value * 2);
      const spy = vi.fn();
      new Effect(() => {
        spy(doubled.value);
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenLastCalledWith(2);

      count.value = 5;
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenLastCalledWith(10);
    });
  });

  describe("ネスト", () => {
    test("Computed が Computed を読む (2 段)", () => {
      const count = new Signal(2);
      const doubled = new Computed(() => count.value * 2);
      const quad = new Computed(() => doubled.value * 2);
      expect(quad.value).toBe(8);

      count.value = 3;
      expect(quad.value).toBe(12);
    });

    test("3 段チェーンでも正しく伝播する", () => {
      const a = new Signal(1);
      const b = new Computed(() => a.value + 1);
      const c = new Computed(() => b.value * 10);
      const d = new Computed(() => c.value - 5);
      expect(d.value).toBe(15); // ((1+1)*10)-5 = 15
      a.value = 4;
      expect(d.value).toBe(45); // ((4+1)*10)-5 = 45
    });
  });

  describe("dispose", () => {
    test("dispose 後は再計算しない (最後の値を返し続ける)", () => {
      const count = new Signal(1);
      const fn = vi.fn(() => count.value * 2);
      const c = new Computed(fn);
      expect(c.value).toBe(2);
      c.dispose();

      count.value = 10;
      expect(c.value).toBe(2);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test("dispose 複数回呼んでも throw しない", () => {
      const c = new Computed(() => 1);
      c.dispose();
      expect(() => c.dispose()).not.toThrow();
    });
  });

  describe("untrack", () => {
    test("untrack 内で読んだ Signal は依存に加わらない", () => {
      const a = new Signal(1);
      const b = new Signal(10);
      const c = new Computed(() => a.value + untrack(() => b.value));
      expect(c.value).toBe(11);

      b.value = 20;
      expect(c.value).toBe(11); // a 変更なし、b は untrack なので再計算しない
      a.value = 2;
      expect(c.value).toBe(22); // a 変更で再計算、その時点の b を読み直す
    });
  });

  describe("Owner との統合", () => {
    test("Owner.run 内で作った Computed は Owner.dispose で dispose される", () => {
      const owner = new Owner(null);
      const count = new Signal(1);
      let comp!: Computed<number>;
      owner.run(() => {
        comp = new Computed(() => count.value * 2);
      });
      expect(comp.value).toBe(2);

      owner.dispose();
      count.value = 5;
      expect(comp.value).toBe(2);
    });
  });
});
