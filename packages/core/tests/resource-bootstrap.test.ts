// @vitest-environment jsdom
// ADR 0030 Step B-5c: resource の bootstrap-hit branch (client 側)。
//   - bootstrap data に hit → loading=false スタート、fetcher 呼ばれない
//   - error 形式の hit → error が hydrate される
//   - hit なし or bootstrapKey 未指定 → 従来動作 (即時 fetch)
//   - Suspense register されない (count に影響しない)

import { describe, expect, test, beforeEach } from "vite-plus/test";
import { resource } from "../src/resource";
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
  delete (globalThis as { __vidroResources?: unknown }).__vidroResources;
});

describe("resource bootstrap-hit (client)", () => {
  test("hit データあり: loading=false スタート + fetcher 呼ばれない", () => {
    setBootstrap({ resources: { "user:1": { data: { name: "Asahi" } } } });

    let fetcherCalls = 0;
    const r = resource(
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
    const r = resource(
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
    const r = resource(
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
    const r = resource(() => {
      fetcherCalls++;
      return Promise.resolve(1);
    });

    expect(r.loading).toBe(true);
    expect(fetcherCalls).toBe(1);
  });

  test("ADR 0035 (C-α): window.__vidroResources の late-arriving lookup で hit する", () => {
    // shell hydrate run で Router が `__vidro_data` を読んだ後 (= cache 確定後) に
    // boundary chunk が `__vidroAddResources` で `window.__vidroResources` に
    // resources を書き込んだ状況を simulate する。bootstrap data の resources は
    // 空、window 側にだけ key が居る。
    setBootstrap({ resources: {} });
    (globalThis as { __vidroResources?: Record<string, unknown> }).__vidroResources = {
      "late:1": { data: { name: "After-fill" } },
    };

    let fetcherCalls = 0;
    const r = resource(
      () => {
        fetcherCalls++;
        return Promise.resolve({ name: "fallback" });
      },
      { bootstrapKey: "late:1" },
    );

    expect(r.loading).toBe(false);
    expect(r.value).toEqual({ name: "After-fill" });
    expect(fetcherCalls).toBe(0);
  });

  test("ADR 0035 (C-α): window 優先 + bootstrap data fallback 両立", () => {
    // bootstrap data に `early` が、window に `late` が居る状態。両方 hit する。
    setBootstrap({ resources: { early: { data: 1 } } });
    (globalThis as { __vidroResources?: Record<string, unknown> }).__vidroResources = {
      late: { data: 2 },
    };

    const rEarly = resource(() => Promise.resolve(99), { bootstrapKey: "early" });
    const rLate = resource(() => Promise.resolve(99), { bootstrapKey: "late" });

    expect(rEarly.value).toBe(1);
    expect(rEarly.loading).toBe(false);
    expect(rLate.value).toBe(2);
    expect(rLate.loading).toBe(false);
  });

  test("Suspense 内 + bootstrap-hit: register されず children 直出し (blink なし)", () => {
    setBootstrap({ resources: { "u:1": { data: "hello" } } });

    const App = () =>
      Suspense({
        fallback: () => h("p", null, _$text("loading")),
        children: () => {
          const r = resource(() => Promise.resolve("fallback"), {
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
