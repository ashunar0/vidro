// @vitest-environment jsdom
import { describe, expect, test, vi } from "vite-plus/test";
import { h, mount } from "../src/jsx";
import { ErrorBoundary } from "../src/error-boundary";
import { Signal } from "../src/signal";
import { effect } from "../src/effect";
import { onMount } from "../src/mount-queue";

describe("ErrorBoundary", () => {
  test("正常時は children を表示、onError は呼ばれない", () => {
    const target = document.createElement("div");
    const onError = vi.fn();
    const child = document.createElement("p");
    child.textContent = "ok";

    mount(
      () =>
        ErrorBoundary({
          children: () => child,
          fallback: () => document.createTextNode("fail"),
          onError,
        }),
      target,
    );

    expect(target.textContent).toBe("ok");
    expect(onError).not.toHaveBeenCalled();
  });

  test("子 component の初期描画 throw を catch → fallback 表示 + onError", () => {
    const target = document.createElement("div");
    const onError = vi.fn();
    const Broken = (): Node => {
      throw new Error("boom");
    };

    mount(
      () =>
        ErrorBoundary({
          children: () => h(Broken, null),
          fallback: (err) => {
            const p = document.createElement("p");
            p.textContent = `caught: ${(err as Error).message}`;
            return p;
          },
          onError,
        }),
      target,
    );

    expect(target.textContent).toBe("caught: boom");
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe("boom");
  });

  test("子 Effect の再実行 throw を catch", () => {
    const target = document.createElement("div");
    const onError = vi.fn();
    const trigger = new Signal(0);

    const Child = (): Node => {
      effect(() => {
        if (trigger.value > 0) throw new Error("effect-boom");
      });
      const p = document.createElement("p");
      p.textContent = "child";
      return p;
    };

    mount(
      () =>
        ErrorBoundary({
          children: () => h(Child, null),
          fallback: () => document.createTextNode("failed"),
          onError,
        }),
      target,
    );

    expect(target.textContent).toBe("child");
    expect(onError).not.toHaveBeenCalled();

    trigger.value = 1;
    expect(target.textContent).toBe("failed");
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe("effect-boom");
  });

  test("子 onMount の throw を catch", () => {
    const target = document.createElement("div");
    const onError = vi.fn();

    const Child = (): Node => {
      onMount(() => {
        throw new Error("mount-boom");
      });
      const p = document.createElement("p");
      p.textContent = "child";
      return p;
    };

    mount(
      () =>
        ErrorBoundary({
          children: () => h(Child, null),
          fallback: () => document.createTextNode("mount-failed"),
          onError,
        }),
      target,
    );

    expect(target.textContent).toBe("mount-failed");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("event handler の throw は boundary に届かない (onError 呼ばれない)", () => {
    const target = document.createElement("div");
    const onError = vi.fn();

    const Child = (): Node => {
      const btn = document.createElement("button");
      btn.addEventListener("click", () => {
        throw new Error("click-boom");
      });
      btn.textContent = "click";
      return btn;
    };

    mount(
      () =>
        ErrorBoundary({
          children: () => h(Child, null),
          fallback: () => document.createTextNode("failed"),
          onError,
        }),
      target,
    );

    // jsdom は event listener 内の throw を window の error event に変換する (DOM spec 通り)。
    // 未処理だと vitest が "unhandled error" を報告するので、テスト中だけ preventDefault で抑制する。
    const suppress = (e: ErrorEvent): void => e.preventDefault();
    window.addEventListener("error", suppress);
    try {
      const btn = target.querySelector("button")!;
      try {
        btn.click();
      } catch {
        /* listener の throw がここに漏れてきても本テストでは無視 */
      }
    } finally {
      window.removeEventListener("error", suppress);
    }

    expect(onError).not.toHaveBeenCalled();
    expect(target.textContent).toBe("click");
  });

  test("reset で children を再 mount (state 初期化)", () => {
    const target = document.createElement("div");
    const onError = vi.fn();
    const trigger = new Signal(1);
    let mountCount = 0;

    const Child = (): Node => {
      mountCount++;
      effect(() => {
        if (trigger.value > 0) throw new Error("boom");
      });
      return document.createElement("p");
    };

    let capturedReset: (() => void) | null = null;
    mount(
      () =>
        ErrorBoundary({
          children: () => h(Child, null),
          fallback: (_err, reset) => {
            capturedReset = reset;
            return document.createTextNode("failed");
          },
          onError,
        }),
      target,
    );

    expect(mountCount).toBe(1);
    expect(target.textContent).toBe("failed");

    // error を解消してから reset
    trigger.value = 0;
    capturedReset!();

    // children が再 mount されている (Child 関数が再評価、state は初期化)
    expect(mountCount).toBe(2);
    expect(target.textContent).toBe("");
  });

  test("nested boundary: 内 fallback で再 throw すると外 boundary が拾う", () => {
    const target = document.createElement("div");
    const outerOnError = vi.fn();
    const innerOnError = vi.fn();

    const Broken = (): Node => {
      throw new Error("inner-boom");
    };

    mount(
      () =>
        ErrorBoundary({
          children: () =>
            ErrorBoundary({
              children: () => h(Broken, null),
              fallback: (): Node => {
                throw new Error("fallback-boom");
              },
              onError: innerOnError,
            }),
          fallback: (err) => {
            const p = document.createElement("p");
            p.textContent = `outer: ${(err as Error).message}`;
            return p;
          },
          onError: outerOnError,
        }),
      target,
    );

    expect(innerOnError).toHaveBeenCalledTimes(1);
    expect(outerOnError).toHaveBeenCalledTimes(1);
    expect(target.textContent).toBe("outer: fallback-boom");
  });

  test("boundary の無い初期描画 throw は mount 呼び出し元に伝播する", () => {
    const target = document.createElement("div");
    const Broken = (): Node => {
      throw new Error("no-boundary");
    };
    expect(() => mount(() => h(Broken, null), target)).toThrow("no-boundary");
  });

  test("mount dispose で children owner も後片付けされる", () => {
    const target = document.createElement("div");
    const cleanup = vi.fn();
    const trigger = new Signal(0);

    const Child = (): Node => {
      effect(() => {
        void trigger.value; // 依存を張るためだけに読む
        return cleanup;
      });
      return document.createElement("p");
    };

    const dispose = mount(
      () =>
        ErrorBoundary({
          children: () => h(Child, null),
          fallback: () => document.createTextNode("fb"),
          onError: () => {},
        }),
      target,
    );

    expect(cleanup).not.toHaveBeenCalled();
    dispose();
    // children owner の dispose で effect cleanup が走る
    expect(cleanup).toHaveBeenCalledTimes(1);
    // dispose 後に Signal を動かしても effect が再実行されない
    trigger.value = 1;
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
