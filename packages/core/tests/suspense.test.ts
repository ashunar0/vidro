// @vitest-environment jsdom
// SSR Phase B Step B-5b: Suspense primitive の挙動検証 (ADR 0029)。
//   - resource pending 中は fallback、resolve 後 children
//   - 複数 resource を 1 Suspense でまとめて待つ (count 集約)
//   - error は Suspense に影響しない (loading は false に戻り、children に切替)
//   - Suspense より外で作られた resource は scope null = 影響しない
//   - nested Suspense: 各 scope が独立に集約

import { describe, expect, test } from "vite-plus/test";
import { h, _$text, _$dynamicChild, mount } from "../src/jsx";
import { resource } from "../src/resource";
import { Suspense } from "../src/suspense";

const flush = async (): Promise<void> => {
  // batch + then のチェーンを完全に流すため余裕をもって 4 回回す
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("Suspense", () => {
  test("resource pending 中は fallback、resolve 後 children", async () => {
    let resolveFn!: (v: string) => void;
    const promise = new Promise<string>((res) => {
      resolveFn = res;
    });

    const App = () =>
      Suspense({
        fallback: () => h("p", null, _$text("loading")),
        children: () => {
          const data = resource(() => promise);
          return h(
            "p",
            null,
            _$dynamicChild(() => data.value ?? ""),
          );
        },
      });

    const target = document.createElement("div");
    mount(App, target);

    expect(target.textContent).toBe("loading");

    resolveFn("hello");
    await flush();

    expect(target.textContent).toBe("hello");
  });

  test("複数 resource を 1 Suspense でまとめて待つ (count 集約)", async () => {
    let r1!: (v: string) => void;
    let r2!: (v: string) => void;

    const App = () =>
      Suspense({
        fallback: () => h("p", null, _$text("loading")),
        children: () => {
          const a = resource(
            () =>
              new Promise<string>((res) => {
                r1 = res;
              }),
          );
          const b = resource(
            () =>
              new Promise<string>((res) => {
                r2 = res;
              }),
          );
          return h(
            "p",
            null,
            _$dynamicChild(() => `${a.value ?? ""}-${b.value ?? ""}`),
          );
        },
      });

    const target = document.createElement("div");
    mount(App, target);

    expect(target.textContent).toBe("loading");

    // 1 つ resolve しても、もう 1 つが pending なら fallback のまま
    r1("A");
    await flush();
    expect(target.textContent).toBe("loading");

    // 2 つ目も resolve したら children
    r2("B");
    await flush();
    expect(target.textContent).toBe("A-B");
  });

  test("error は Suspense に影響しない (loading=false で children に切替)", async () => {
    const App = () =>
      Suspense({
        fallback: () => h("p", null, _$text("loading")),
        children: () => {
          const data = resource(() => Promise.reject(new Error("boom")));
          return h(
            "p",
            null,
            _$dynamicChild(() =>
              data.error instanceof Error ? data.error.message : (data.value ?? "ok"),
            ),
          );
        },
      });

    const target = document.createElement("div");
    mount(App, target);

    // 構築直後は pending=true なので fallback
    expect(target.textContent).toBe("loading");

    await flush();
    // reject 後 loading=false → unregister → pending=0 → children に切替、error 表示
    expect(target.textContent).toBe("boom");
  });

  test("Suspense より外で作られた resource は scope null = 影響しない", async () => {
    let resolveFn!: (v: string) => void;
    const promise = new Promise<string>((res) => {
      resolveFn = res;
    });

    const App = () => {
      // Suspense より外で構築 → getCurrentSuspense() は null → register しない
      const data = resource(() => promise);
      return Suspense({
        fallback: () => h("p", null, _$text("loading")),
        children: () =>
          h(
            "p",
            null,
            _$dynamicChild(() => data.value ?? "outside"),
          ),
      });
    };

    const target = document.createElement("div");
    mount(App, target);

    // Suspense は pending=0 で children を表示。data.value はまだ undefined なので "outside"
    expect(target.textContent).toBe("outside");

    resolveFn("loaded");
    await flush();
    // resource resolve で data.value="loaded"、effect で text 更新
    expect(target.textContent).toBe("loaded");
  });

  test("nested Suspense: 内側の resource は内側 scope のみ集約、外側に伝わらない", async () => {
    let r1!: (v: string) => void;
    let r2!: (v: string) => void;

    const App = () =>
      Suspense({
        fallback: () => h("p", null, _$text("outer-loading")),
        children: () => {
          const a = resource(
            () =>
              new Promise<string>((res) => {
                r1 = res;
              }),
          );
          return h(
            "div",
            null,
            h(
              "span",
              null,
              _$dynamicChild(() => a.value ?? "outer-empty"),
            ),
            Suspense({
              fallback: () => h("span", null, _$text("inner-loading")),
              children: () => {
                const b = resource(
                  () =>
                    new Promise<string>((res) => {
                      r2 = res;
                    }),
                );
                return h(
                  "span",
                  null,
                  _$dynamicChild(() => b.value ?? "inner-empty"),
                );
              },
            }),
          );
        },
      });

    const target = document.createElement("div");
    mount(App, target);

    // 構築直後: 外側 a は pending、内側 b も pending → 外側 fallback 表示
    expect(target.textContent).toBe("outer-loading");

    // 外側 a だけ resolve → 外側 children に切替。内側はまだ pending なので inner-loading
    r1("A");
    await flush();
    expect(target.textContent).toBe("Ainner-loading");

    // 内側 b も resolve → 内側 children に切替
    r2("B");
    await flush();
    expect(target.textContent).toBe("AB");
  });
});
