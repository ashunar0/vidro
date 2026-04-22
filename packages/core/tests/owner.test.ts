import { describe, expect, test, vi } from "vite-plus/test";
import { Owner, effectScope, getCurrentOwner, onCleanup } from "../src/owner";

describe("Owner", () => {
  describe("基本動作", () => {
    test("生成直後は disposed = false", () => {
      const owner = new Owner(null);
      expect(owner.disposed).toBe(false);
    });

    test("dispose 後は disposed = true", () => {
      const owner = new Owner(null);
      owner.dispose();
      expect(owner.disposed).toBe(true);
    });

    test("dispose を複数回呼んでもエラーにならない", () => {
      const owner = new Owner(null);
      owner.dispose();
      expect(() => owner.dispose()).not.toThrow();
    });
  });

  describe("run (scope activation)", () => {
    test("run 中は getCurrentOwner が自分を返す", () => {
      const owner = new Owner(null);
      let inside: Owner | null = null;
      owner.run(() => {
        inside = getCurrentOwner();
      });
      expect(inside).toBe(owner);
    });

    test("run 終了後は current owner が元に戻る", () => {
      const owner = new Owner(null);
      expect(getCurrentOwner()).toBe(null);
      owner.run(() => {});
      expect(getCurrentOwner()).toBe(null);
    });

    test("run はネストできる", () => {
      const a = new Owner(null);
      const b = new Owner(null);
      const seen: Array<Owner | null> = [];
      a.run(() => {
        seen.push(getCurrentOwner());
        b.run(() => {
          seen.push(getCurrentOwner());
        });
        seen.push(getCurrentOwner());
      });
      seen.push(getCurrentOwner());
      expect(seen).toEqual([a, b, a, null]);
    });

    test("run 内で例外が起きても current owner は戻る", () => {
      const owner = new Owner(null);
      expect(() =>
        owner.run(() => {
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(getCurrentOwner()).toBe(null);
    });

    test("run は fn の戻り値をそのまま返す", () => {
      const owner = new Owner(null);
      const result = owner.run(() => 42);
      expect(result).toBe(42);
    });
  });

  describe("addCleanup / dispose", () => {
    test("dispose 時に登録済み cleanup が全部呼ばれる", () => {
      const owner = new Owner(null);
      const a = vi.fn();
      const b = vi.fn();
      owner.addCleanup(a);
      owner.addCleanup(b);
      owner.dispose();
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });

    test("cleanup は LIFO 順で呼ばれる", () => {
      const owner = new Owner(null);
      const order: number[] = [];
      owner.addCleanup(() => order.push(1));
      owner.addCleanup(() => order.push(2));
      owner.addCleanup(() => order.push(3));
      owner.dispose();
      expect(order).toEqual([3, 2, 1]);
    });

    test("dispose 済み owner への addCleanup は無視される (後から呼ばれない)", () => {
      const owner = new Owner(null);
      owner.dispose();
      const fn = vi.fn();
      owner.addCleanup(fn);
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe("parent-child 階層", () => {
    test("親を dispose すると子も dispose される", () => {
      const parent = new Owner(null);
      const child = new Owner(parent);
      parent.dispose();
      expect(child.disposed).toBe(true);
    });

    test("子の cleanup も親 dispose で呼ばれる", () => {
      const parent = new Owner(null);
      const child = new Owner(parent);
      const cleanup = vi.fn();
      child.addCleanup(cleanup);
      parent.dispose();
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    test("孫まで再帰的に dispose される", () => {
      const g = new Owner(null);
      const p = new Owner(g);
      const c = new Owner(p);
      g.dispose();
      expect(p.disposed).toBe(true);
      expect(c.disposed).toBe(true);
    });

    test("子を手動 dispose しても親には影響しない", () => {
      const parent = new Owner(null);
      const child = new Owner(parent);
      child.dispose();
      expect(parent.disposed).toBe(false);
    });

    test("親を dispose しても、先に手動 dispose 済みの子の cleanup は 1 回しか呼ばれない", () => {
      const parent = new Owner(null);
      const child = new Owner(parent);
      const cleanup = vi.fn();
      child.addCleanup(cleanup);
      child.dispose();
      parent.dispose();
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    test("constructor で parent を省略すると current owner が親になる", () => {
      const parent = new Owner(null);
      let child: Owner | null = null;
      parent.run(() => {
        child = new Owner();
      });
      const cleanup = vi.fn();
      child!.addCleanup(cleanup);
      parent.dispose();
      // 子が parent に紐づいていれば、parent dispose で cleanup が呼ばれる
      expect(cleanup).toHaveBeenCalledTimes(1);
    });
  });

  describe("effectScope", () => {
    test("fn が即実行される", () => {
      const fn = vi.fn();
      effectScope(fn);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test("fn の戻り値が返る", () => {
      const result = effectScope(() => 123);
      expect(result).toBe(123);
    });

    test("fn 実行中は current owner が新 scope に切り替わる", () => {
      let inside: Owner | null = null;
      effectScope(() => {
        inside = getCurrentOwner();
      });
      expect(inside).not.toBe(null);
    });

    test("fn に渡される dispose で scope 内の cleanup が呼ばれる", () => {
      const cleanup = vi.fn();
      effectScope((dispose) => {
        onCleanup(cleanup);
        dispose();
      });
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    test("effectScope は親 owner から切り離される (root)", () => {
      const outerCleanup = vi.fn();
      const innerCleanup = vi.fn();
      const outer = new Owner(null);

      outer.run(() => {
        onCleanup(outerCleanup);
        // effectScope は detach → 親 outer を dispose しても inner は巻き込まれない
        effectScope(() => {
          onCleanup(innerCleanup);
        });
      });

      outer.dispose();
      expect(outerCleanup).toHaveBeenCalledTimes(1);
      expect(innerCleanup).not.toHaveBeenCalled();
    });
  });

  describe("onCleanup", () => {
    test("current owner に登録される", () => {
      const owner = new Owner(null);
      const fn = vi.fn();
      owner.run(() => onCleanup(fn));
      owner.dispose();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test("owner 外で呼んでも throw しない (silently ignore)", () => {
      expect(() => onCleanup(() => {})).not.toThrow();
    });
  });
});
