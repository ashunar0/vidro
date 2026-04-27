// @vitest-environment jsdom
// ADR 0032: reactive source overload (resource(source, fetcher, options?)) の挙動。
//   - source 変化で auto refetch
//   - gating (false / null / undefined) で fetcher 呼ばれない
//   - gating → 値で fetch 開始
//   - pending 中に source 変化 → token race で旧 fetch を握り潰し
//   - previous value 保持 (refetch 中の r.value は前回値)
//   - refetch() で同 source value 再実行
//   - Suspense + reactive source: source 変化で register / unregister
//   - bootstrap-hit + reactive source: 二重 fetch 回避

import { describe, expect, test, beforeEach } from "vite-plus/test";
import { resource } from "../src/resource";
import { Suspense } from "../src/suspense";
import { signal } from "../src/signal";
import { mount, h, _$text, _$dynamicChild } from "../src/jsx";
import { __resetVidroDataCache } from "../src/bootstrap";

beforeEach(() => {
  __resetVidroDataCache();
  for (const el of Array.from(document.querySelectorAll("#__vidro_data"))) el.remove();
});

// 次回 microtask まで待つ helper。Promise.resolve の resolve 経路を 1 ターン進める。
const tick = () => new Promise<void>((r) => queueMicrotask(r));

describe("resource (reactive source)", () => {
  test("source 変化で auto refetch", async () => {
    const userId = signal(1);
    const calls: number[] = [];
    const r = resource(
      () => userId.value,
      (id) => {
        calls.push(id);
        return Promise.resolve(`user-${id}`);
      },
    );

    // 初回: source=1 で fetch 開始
    expect(calls).toEqual([1]);
    expect(r.loading).toBe(true);
    await tick();
    await tick();
    expect(r.value).toBe("user-1");
    expect(r.loading).toBe(false);

    // source 変化 → auto refetch
    userId.value = 2;
    expect(calls).toEqual([1, 2]);
    expect(r.loading).toBe(true);
    await tick();
    await tick();
    expect(r.value).toBe("user-2");
  });

  test("gating: source が false / null / undefined を返したら fetcher 呼ばれない", async () => {
    const enabled = signal(false);
    let fetcherCalls = 0;
    const r = resource(
      () => enabled.value,
      (v) => {
        fetcherCalls++;
        return Promise.resolve(v);
      },
    );

    expect(fetcherCalls).toBe(0);
    expect(r.loading).toBe(false);

    // 別 source で null / undefined も同じく gate されることの確認
    const opt = signal<string | null | undefined>(null);
    let nCalls = 0;
    resource(
      () => opt.value,
      () => {
        nCalls++;
        return Promise.resolve("ok");
      },
    );
    opt.value = undefined;
    await tick();
    expect(nCalls).toBe(0);
  });

  test("gating → 値に変わったら fetch 開始", async () => {
    const enabled = signal<boolean | string>(false);
    let fetcherCalls = 0;
    const r = resource(
      () => enabled.value,
      (v) => {
        fetcherCalls++;
        return Promise.resolve(`got-${v}`);
      },
    );

    expect(fetcherCalls).toBe(0);
    enabled.value = "x";
    expect(fetcherCalls).toBe(1);
    expect(r.loading).toBe(true);
    await tick();
    await tick();
    expect(r.value).toBe("got-x");
  });

  test("pending 中に source 変化 → 旧 fetch は握り潰される (token race)", async () => {
    const id = signal(1);
    const resolvers: Array<(v: string) => void> = [];
    const r = resource(
      () => id.value,
      (i) =>
        new Promise<string>((resolve) => {
          resolvers.push((v) => resolve(`${i}-${v}`));
        }),
    );

    expect(r.loading).toBe(true);
    expect(resolvers.length).toBe(1);

    // pending 中に source 変化 → 新 fetcher 開始、resolvers[1] が active
    id.value = 2;
    expect(resolvers.length).toBe(2);

    // 古い fetch を遅れて resolve させても state には反映されない
    resolvers[0]!("old");
    await tick();
    await tick();
    expect(r.value).toBeUndefined();
    expect(r.loading).toBe(true);

    // 新しい fetch を resolve すると state 更新
    resolvers[1]!("new");
    await tick();
    await tick();
    expect(r.value).toBe("2-new");
    expect(r.loading).toBe(false);
  });

  test("previous value 保持: source 変化中 r.value は前回値のまま", async () => {
    const id = signal(1);
    const resolvers: Array<(v: string) => void> = [];
    const r = resource(
      () => id.value,
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    // 1 個目を resolve して r.value を確定
    resolvers[0]!("first");
    await tick();
    await tick();
    expect(r.value).toBe("first");

    // source 変化 → loading=true、value はまだ "first"
    id.value = 2;
    expect(r.loading).toBe(true);
    expect(r.value).toBe("first");

    // 新 fetch が resolve したら更新
    resolvers[1]!("second");
    await tick();
    await tick();
    expect(r.value).toBe("second");
  });

  test("r.refetch() は直近 source value で再実行 (Solid 互換)", async () => {
    const id = signal(7);
    const calls: number[] = [];
    const r = resource(
      () => id.value,
      (i) => {
        calls.push(i);
        return Promise.resolve(`#${i}`);
      },
    );

    expect(calls).toEqual([7]);
    await tick();
    await tick();
    expect(r.value).toBe("#7");

    r.refetch();
    expect(calls).toEqual([7, 7]);
    await tick();
    await tick();
    expect(r.value).toBe("#7");
  });

  test("Suspense + reactive source: source 変化で register/unregister が回る", async () => {
    const id = signal(1);
    const resolvers: Array<(v: string) => void> = [];
    const target = document.createElement("div");

    mount(
      () =>
        Suspense({
          fallback: () => h("p", { id: "fb" }, _$text("loading")),
          children: () => {
            const r = resource(
              () => id.value,
              () =>
                new Promise<string>((resolve) => {
                  resolvers.push(resolve);
                }),
            );
            return h(
              "p",
              { id: "ok" },
              _$dynamicChild(() => r.value ?? ""),
            );
          },
        }),
      target,
    );

    // 初回 pending → fallback 表示
    expect(target.querySelector("#fb")).not.toBeNull();
    expect(target.querySelector("#ok")).toBeNull();

    // 1 回目 resolve → children 表示
    resolvers[0]!("first");
    await tick();
    await tick();
    expect(target.querySelector("#fb")).toBeNull();
    expect(target.querySelector("#ok")?.textContent).toBe("first");

    // source 変化 → 再 pending、Suspense は fallback に戻る
    id.value = 2;
    await tick();
    expect(target.querySelector("#fb")).not.toBeNull();

    // 新 fetch resolve → 再び children
    resolvers[1]!("second");
    await tick();
    await tick();
    expect(target.querySelector("#ok")?.textContent).toBe("second");
    expect(resolvers.length).toBe(2);
  });

  test("bootstrap-hit + reactive source: 初回 effect で fetcher は呼ばれない (二重 fetch 回避)", async () => {
    // bootstrap data を inject (id=1 の hit のみ)
    const script = document.createElement("script");
    script.id = "__vidro_data";
    script.type = "application/json";
    script.textContent = JSON.stringify({
      resources: { "user:1": { data: { name: "Asahi" } } },
    });
    document.head.appendChild(script);

    const id = signal(1);
    let fetcherCalls = 0;
    const r = resource(
      () => id.value,
      (i) => {
        fetcherCalls++;
        return Promise.resolve({ name: `fallback-${i}` });
      },
      { bootstrapKey: "user:1" },
    );

    // 初回: hit があるので applyBootstrapHit + effect 初回 invocation skip
    expect(r.loading).toBe(false);
    expect(r.value).toEqual({ name: "Asahi" });
    expect(fetcherCalls).toBe(0);

    // source 変化 → auto refetch (hit はもう関係ない、新 key だから)
    id.value = 2;
    expect(fetcherCalls).toBe(1);
    expect(r.loading).toBe(true);
    await tick();
    await tick();
    expect(r.value).toEqual({ name: "fallback-2" });
  });
});
