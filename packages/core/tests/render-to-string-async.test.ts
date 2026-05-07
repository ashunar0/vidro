// @vitest-environment node
// ADR 0030 Step B-5c: renderToStringAsync の 2-pass 挙動。
//   - bootstrapKey 付き resource を resolve してから markup
//   - reject は SerializedError 形式で resources に入る
//   - bootstrapKey なし resource は scope に register されず、loading=true で markup
//   - 重複 key は first-write-wins (warn)
//   - Suspense + bootstrap-hit で children 直出し

import { describe, expect, test, vi } from "vite-plus/test";
import { h, _$text, _$dynamicChild } from "../src/jsx";
import { resource } from "../src/resource";
import { Suspense } from "../src/suspense";
import { renderToStringAsync } from "../src/render-to-string";

describe("renderToStringAsync", () => {
  test("bootstrapKey 付き resource: resolve 後の値で markup", async () => {
    const { html, resources } = await renderToStringAsync(() => {
      const r = resource(() => Promise.resolve({ name: "Asahi" }), {
        bootstrapKey: "user:1",
      });
      return h(
        "p",
        null,
        _$dynamicChild(() => (r.value as { name: string } | undefined)?.name ?? "..."),
      );
    });

    expect(html).toBe("<p>Asahi</p>");
    expect(resources).toEqual({ "user:1": { data: { name: "Asahi" } } });
  });

  test("reject は SerializedError 形式で resources に入る + markup は user の error 表示", async () => {
    const { html, resources } = await renderToStringAsync(() => {
      const r = resource(() => Promise.reject(new Error("boom")), {
        bootstrapKey: "broken",
      });
      return h(
        "p",
        null,
        _$dynamicChild(() => (r.error instanceof Error ? r.error.message : "ok")),
      );
    });

    expect(html).toBe("<p>boom</p>");
    expect(resources["broken"]).toMatchObject({
      error: { name: "Error", message: "boom" },
    });
  });

  test("bootstrapKey なし resource は scope register されず loading=true で markup", async () => {
    const { html, resources } = await renderToStringAsync(() => {
      const r = resource(() => Promise.resolve("hello"));
      return h(
        "p",
        null,
        _$dynamicChild(() => (r.loading ? "loading" : (r.value ?? ""))),
      );
    });

    expect(html).toBe("<p>loading</p>");
    expect(resources).toEqual({});
  });

  test("重複 key: first-write-wins + warn 1 回", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let count = 0;

    const { html, resources } = await renderToStringAsync(() => {
      const a = resource(
        () => {
          count++;
          return Promise.resolve("first");
        },
        { bootstrapKey: "k" },
      );
      const b = resource(
        () => {
          count++;
          return Promise.resolve("second");
        },
        { bootstrapKey: "k" },
      );
      return h(
        "p",
        null,
        _$dynamicChild(() => `${a.value ?? ""}|${b.value ?? ""}`),
      );
    });

    // 同じ key の resource は同じ hit を引き当てる (first-write-wins)
    expect(html).toBe("<p>first|first</p>");
    expect(resources).toEqual({ k: { data: "first" } });
    // 1-pass で 1 回 + 2-pass で warn なし (hit branch なので register call されず)
    // 1-pass の時に b の register が duplicate と判断されて warn 1 回
    expect(warn).toHaveBeenCalledTimes(1);
    // fetcher も 1 回しか呼ばれない (重複 register が捨てられたので)
    expect(count).toBe(1);

    warn.mockRestore();
  });

  test("ADR 0064 Phase 3: component function が JSX 評価で 1 回しか呼ばれない (1-pass)", async () => {
    let calls = 0;
    const { html } = await renderToStringAsync(() => {
      calls++;
      const r = resource(() => Promise.resolve("Asahi"), { bootstrapKey: "u" });
      return h(
        "p",
        null,
        _$dynamicChild(() => r.value ?? "..."),
      );
    });

    // 旧 2-pass model では JSX 評価 2 回 → calls === 2 だった。Phase 3 で 1-pass に。
    expect(calls).toBe(1);
    expect(html).toBe("<p>Asahi</p>");
  });

  test("Suspense + bootstrap resolved: children が markup に焼かれる", async () => {
    const { html, resources } = await renderToStringAsync(() =>
      Suspense({
        fallback: () => h("p", null, _$text("loading")),
        children: () => {
          const r = resource(() => Promise.resolve("hi"), { bootstrapKey: "x" });
          return h(
            "p",
            null,
            _$dynamicChild(() => r.value ?? ""),
          );
        },
      }),
    );

    // 2-pass で hit 引き当て → loading=false でスタート → Suspense は children 直出し
    expect(html).toContain("<p>hi</p>");
    expect(html).not.toContain("loading");
    expect(resources).toEqual({ x: { data: "hi" } });
  });
});
