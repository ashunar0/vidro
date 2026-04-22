import { describe, expect, test, vi } from "vite-plus/test";
import { Signal } from "../src/signal";
import { Effect, effect } from "../src/effect";
import { untrack } from "../src/observer";
import { Owner, onCleanup } from "../src/owner";

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

  describe("子 scope の管理", () => {
    test("親 Effect 再実行時に、前回の内側で作った子 Effect は dispose される", () => {
      const trigger = new Signal(0);
      const innerSignal = new Signal(0);
      const inner = vi.fn(() => {
        void innerSignal.value;
      });

      new Effect(() => {
        void trigger.value;
        new Effect(inner);
      });
      expect(inner).toHaveBeenCalledTimes(1);

      // 親再実行 → 旧 inner は dispose、新 inner が 1 回走る (合計 2)
      trigger.value = 1;
      expect(inner).toHaveBeenCalledTimes(2);

      // innerSignal を変更 → 生きてる inner は 1 つだけなので +1 (合計 3)
      // 旧 inner が生きてると +2 されてしまう
      innerSignal.value = 99;
      expect(inner).toHaveBeenCalledTimes(3);
    });

    test("Effect 内の onCleanup は次回再実行前に発火する", () => {
      const trigger = new Signal(0);
      const cleanup = vi.fn();
      new Effect(() => {
        void trigger.value;
        onCleanup(cleanup);
      });
      expect(cleanup).toHaveBeenCalledTimes(0);

      trigger.value = 1;
      expect(cleanup).toHaveBeenCalledTimes(1);

      trigger.value = 2;
      expect(cleanup).toHaveBeenCalledTimes(2);
    });

    test("Effect dispose 時に子 Effect も dispose される", () => {
      const innerSignal = new Signal(0);
      const inner = vi.fn(() => {
        void innerSignal.value;
      });

      const outer = new Effect(() => {
        new Effect(inner);
      });
      expect(inner).toHaveBeenCalledTimes(1);

      outer.dispose();
      innerSignal.value = 1;
      expect(inner).toHaveBeenCalledTimes(1); // 子も巻き込まれて死んでる
    });

    test("多段ネスト: 孫 Effect も親再実行でまとめて dispose される", () => {
      const trigger = new Signal(0);
      const grandchildSignal = new Signal(0);
      const grandchild = vi.fn(() => {
        void grandchildSignal.value;
      });

      new Effect(() => {
        void trigger.value;
        new Effect(() => {
          new Effect(grandchild);
        });
      });
      expect(grandchild).toHaveBeenCalledTimes(1);

      // 親再実行で孫まで一旦全消し、新しい孫が 1 回走る
      trigger.value = 1;
      expect(grandchild).toHaveBeenCalledTimes(2);

      // 生きてる孫は 1 つだけの証明
      grandchildSignal.value = 1;
      expect(grandchild).toHaveBeenCalledTimes(3);
    });

    test("子 Effect 内の onCleanup は親再実行時にも発火する (子ごと dispose される流れ)", () => {
      const trigger = new Signal(0);
      const innerCleanup = vi.fn();
      new Effect(() => {
        void trigger.value;
        new Effect(() => {
          onCleanup(innerCleanup);
        });
      });
      expect(innerCleanup).toHaveBeenCalledTimes(0);

      trigger.value = 1;
      // 親再実行 → 子 childOwner dispose → 孫 Effect dispose → その中の onCleanup が発火
      expect(innerCleanup).toHaveBeenCalledTimes(1);
    });
  });

  describe("Owner との統合", () => {
    test("Owner.run 内で作った Effect は Owner.dispose で dispose される", () => {
      const owner = new Owner(null);
      const count = new Signal(0);
      const fn = vi.fn(() => {
        void count.value;
      });
      owner.run(() => new Effect(fn));
      expect(fn).toHaveBeenCalledTimes(1);

      owner.dispose();
      count.value = 1;
      expect(fn).toHaveBeenCalledTimes(1); // owner dispose 済みなので再実行されない
    });

    test("Owner.dispose で Effect 内の cleanup も呼ばれる", () => {
      const owner = new Owner(null);
      const cleanup = vi.fn();
      owner.run(() => new Effect(() => cleanup));
      owner.dispose();
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    test("ネスト Owner: 親 dispose で子 Owner 内の Effect も dispose される", () => {
      const parent = new Owner(null);
      const count = new Signal(0);
      const fn = vi.fn(() => {
        void count.value;
      });

      parent.run(() => {
        const child = new Owner(); // parent が current owner、child の親は parent
        child.run(() => new Effect(fn));
      });
      expect(fn).toHaveBeenCalledTimes(1);

      parent.dispose();
      count.value = 1;
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test("Owner 外で作った Effect は Owner.dispose の影響を受けない", () => {
      const owner = new Owner(null);
      const count = new Signal(0);
      const fn = vi.fn(() => {
        void count.value;
      });
      new Effect(fn); // owner.run の外で生成
      expect(fn).toHaveBeenCalledTimes(1);

      owner.dispose();
      count.value = 1;
      expect(fn).toHaveBeenCalledTimes(2); // 独立 Effect なので生きてる
    });

    test("同じ Owner に複数の Effect を登録、全部 dispose される", () => {
      const owner = new Owner(null);
      const a = new Signal(0);
      const b = new Signal(0);
      const fnA = vi.fn(() => void a.value);
      const fnB = vi.fn(() => void b.value);

      owner.run(() => {
        new Effect(fnA);
        new Effect(fnB);
      });
      expect(fnA).toHaveBeenCalledTimes(1);
      expect(fnB).toHaveBeenCalledTimes(1);

      owner.dispose();
      a.value = 1;
      b.value = 1;
      expect(fnA).toHaveBeenCalledTimes(1);
      expect(fnB).toHaveBeenCalledTimes(1);
    });

    test("Effect を手動 dispose 済みでも Owner.dispose は安全 (idempotent)", () => {
      const owner = new Owner(null);
      let eff: Effect | null = null;
      owner.run(() => {
        eff = new Effect(() => {});
      });
      eff!.dispose();
      expect(() => owner.dispose()).not.toThrow();
    });
  });
});
