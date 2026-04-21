import { describe, expect, test, vi } from "vite-plus/test";
import { Signal } from "../src/signal";
import { Effect, effect } from "../src/effect";
import { untrack } from "../src/observer";

describe("Effect", () => {
  describe("両形式", () => {
    test("new Effect(fn) は Effect インスタンスを返す", () => {
      const e = new Effect(() => {});
      expect(e).toBeInstanceOf(Effect);
    });

    test("effect(fn) は Effect インスタンスを返す", () => {
      const e = effect(() => {});
      expect(e).toBeInstanceOf(Effect);
    });
  });

  describe("基本動作", () => {
    test("生成時に fn が即実行される", () => {
      const fn = vi.fn();
      new Effect(fn);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test("依存 Signal の変更で再実行される", () => {
      const count = new Signal(0);
      const fn = vi.fn(() => {
        void count.value;
      });
      new Effect(fn);
      expect(fn).toHaveBeenCalledTimes(1);
      count.value = 1;
      expect(fn).toHaveBeenCalledTimes(2);
      count.value = 2;
      expect(fn).toHaveBeenCalledTimes(3);
    });

    test("同値への代入では再実行されない", () => {
      const count = new Signal(0);
      const fn = vi.fn(() => {
        void count.value;
      });
      new Effect(fn);
      count.value = 0;
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test("複数の Signal に依存 → いずれの変更でも再実行", () => {
      const a = new Signal(0);
      const b = new Signal(0);
      const fn = vi.fn(() => {
        void a.value;
        void b.value;
      });
      new Effect(fn);
      expect(fn).toHaveBeenCalledTimes(1);
      a.value = 1;
      expect(fn).toHaveBeenCalledTimes(2);
      b.value = 1;
      expect(fn).toHaveBeenCalledTimes(3);
    });

    test("依存してない Signal の変更では再実行されない", () => {
      const a = new Signal(0);
      const b = new Signal(0);
      const fn = vi.fn(() => {
        void a.value;
      });
      new Effect(fn);
      b.value = 1;
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe("dispose", () => {
    test("dispose 後は再実行されない", () => {
      const count = new Signal(0);
      const fn = vi.fn(() => {
        void count.value;
      });
      const eff = new Effect(fn);
      eff.dispose();
      count.value = 1;
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test("dispose を複数回呼んでもエラーにならない", () => {
      const eff = new Effect(() => {});
      eff.dispose();
      expect(() => eff.dispose()).not.toThrow();
    });
  });

  describe("cleanup", () => {
    test("次の再実行前に前回の cleanup が呼ばれる", () => {
      const count = new Signal(0);
      const cleanup = vi.fn();
      new Effect(() => {
        void count.value;
        return cleanup;
      });
      expect(cleanup).toHaveBeenCalledTimes(0);
      count.value = 1;
      expect(cleanup).toHaveBeenCalledTimes(1);
      count.value = 2;
      expect(cleanup).toHaveBeenCalledTimes(2);
    });

    test("dispose 時にも cleanup が呼ばれる", () => {
      const cleanup = vi.fn();
      const eff = new Effect(() => cleanup);
      eff.dispose();
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    test("cleanup を return しなくても動く", () => {
      const count = new Signal(0);
      expect(() => {
        new Effect(() => {
          void count.value;
        });
        count.value = 1;
      }).not.toThrow();
    });
  });

  describe("動的依存", () => {
    test("条件分岐で読む Signal が変わると古い依存は外れる", () => {
      const flag = new Signal(true);
      const a = new Signal("a");
      const b = new Signal("b");
      const fn = vi.fn(() => {
        void (flag.value ? a.value : b.value);
      });
      new Effect(fn);
      expect(fn).toHaveBeenCalledTimes(1);

      // 最初は flag と a に依存
      a.value = "a2";
      expect(fn).toHaveBeenCalledTimes(2);

      // flag を false に → 再実行後は flag と b に依存
      flag.value = false;
      expect(fn).toHaveBeenCalledTimes(3);

      // a はもう依存してない → 反応しない
      a.value = "a3";
      expect(fn).toHaveBeenCalledTimes(3);

      // b には依存してるので反応
      b.value = "b2";
      expect(fn).toHaveBeenCalledTimes(4);
    });
  });

  describe("untrack", () => {
    test("untrack() で読んだ Signal は依存に加えられない", () => {
      const a = new Signal(0);
      const b = new Signal(0);
      const fn = vi.fn(() => {
        void a.value;
        untrack(() => b.value);
      });
      new Effect(fn);
      expect(fn).toHaveBeenCalledTimes(1);

      // untrack 経由なので反応しない
      b.value = 1;
      expect(fn).toHaveBeenCalledTimes(1);

      // 通常の依存は反応する
      a.value = 1;
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe("ネスト", () => {
    test("Effect 内で別の Effect を作っても外側の依存は乱れない", () => {
      const a = new Signal(0);
      const b = new Signal(0);
      const outer = vi.fn(() => {
        void a.value;
        new Effect(() => {
          void b.value;
        });
      });
      new Effect(outer);
      expect(outer).toHaveBeenCalledTimes(1);

      // b は inner の依存なので outer は反応しない
      b.value = 1;
      expect(outer).toHaveBeenCalledTimes(1);
    });
  });
});
