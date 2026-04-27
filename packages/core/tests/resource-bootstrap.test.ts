// @vitest-environment jsdom
// ADR 0030 Step B-5c: createResource の bootstrap-hit branch (client 側)。
//   - bootstrap data に hit → loading=false スタート、fetcher 呼ばれない
//   - error 形式の hit → error が hydrate される
//   - hit なし or bootstrapKey 未指定 → 従来動作 (即時 fetch)
//   - Suspense register されない (count に影響しない)

import { describe, expect, test, beforeEach } from "vite-plus/test";
import { createResource } from "../src/resource";
import { Suspense } from "../src/suspense";
import { h, _$text, _$dynamicChild, mount } from "../src/jsx";
import { __resetVidroDataCache } from "../src/bootstrap";

function setBootstrap(data: unknown): void {
  for (const el of Array.from(document.querySelectorAll("#__vidro_data"))) el.remove();
  const script = document.createElement("script");
  script.id = "__vidro_data";
  script.type = "application/json";
  script.textContent = JSON.stringify(data);
  document.head.appendChild(script);
}

beforeEach(() => {
  __resetVidroDataCache();
  for (const el of Array.from(document.querySelectorAll("#__vidro_data"))) el.remove();
});

describe("createResource bootstrap-hit (client)", () => {
  test("hit データあり: loading=false スタート + fetcher 呼ばれない", () => {
    setBootstrap({ resources: { "user:1": { data: { name: "Asahi" } } } });

    let fetcherCalls = 0;
    const r = createResource(
      () => {
        fetcherCalls++;
        return Promise.resolve({ name: "fallback" });
      },
      { bootstrapKey: "user:1" },
    );

    expect(r.loading).toBe(false);
    expect(r.value).toEqual({ name: "Asahi" });
    expect(r.error).toBeUndefined();
    expect(fetcherCalls).toBe(0);
  });

  test("hit error あり: error が hydrate される + loading=false", () => {
    setBootstrap({
      resources: {
        broken: { error: { name: "TypeError", message: "bad", stack: "..." } },
      },
    });

    let fetcherCalls = 0;
    const r = createResource(
      () => {
        fetcherCalls++;
        return Promise.resolve("ok");
      },
      { bootstrapKey: "broken" },
    );

    expect(r.loading).toBe(false);
    expect(r.value).toBeUndefined();
    expect(r.error).toBeInstanceOf(Error);
    expect((r.error as Error).message).toBe("bad");
    expect((r.error as Error).name).toBe("TypeError");
    expect(fetcherCalls).toBe(0);
  });

  test("hit なし (key 違い): 従来動作で即時 fetch", async () => {
    setBootstrap({ resources: { "other:1": { data: 99 } } });

    let fetcherCalls = 0;
    const r = createResource(
      () => {
        fetcherCalls++;
        return Promise.resolve(42);
      },
      { bootstrapKey: "user:1" },
    );

    // 従来動作: loading=true から始まる
    expect(r.loading).toBe(true);
    expect(fetcherCalls).toBe(1);
  });

  test("bootstrapKey 未指定: 従来動作 (B-5b 互換)", async () => {
    setBootstrap({ resources: { "user:1": { data: { name: "ignored" } } } });

    let fetcherCalls = 0;
    const r = createResource(() => {
      fetcherCalls++;
      return Promise.resolve(1);
    });

    expect(r.loading).toBe(true);
    expect(fetcherCalls).toBe(1);
  });

  test("Suspense 内 + bootstrap-hit: register されず children 直出し (blink なし)", () => {
    setBootstrap({ resources: { "u:1": { data: "hello" } } });

    const App = () =>
      Suspense({
        fallback: () => h("p", null, _$text("loading")),
        children: () => {
          const r = createResource(() => Promise.resolve("fallback"), {
            bootstrapKey: "u:1",
          });
          return h(
            "p",
            null,
            _$dynamicChild(() => r.value ?? ""),
          );
        },
      });

    const target = document.createElement("div");
    mount(App, target);

    // bootstrap-hit なので register されず、Suspense は children 直出し
    expect(target.textContent).toBe("hello");
  });
});
