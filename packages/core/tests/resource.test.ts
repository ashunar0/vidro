// SSR Phase B Step B-5a: createResource の挙動検証。
//   - constructor で即時 fetch、loading=true から始まる
//   - resolve 経路: data 反映 + loading=false (batch で 1 effect)
//   - reject 経路: error 反映 + loading=false、data は前回値保持
//   - refetch: token increment + 古い in-flight の resolve は握り潰し
//   - effect 経由で .value / .loading が reactive 追従
//
// jsdom 不要 (DOM API 触らない primitive)、@vitest-environment node で十分。

import { describe, expect, test } from "vite-plus/test";
import { createResource } from "../src/resource";
import { effect } from "../src/effect";

// microtask flush。Promise.resolve / reject の then は microtask queue で実行される
// ので、test 内では明示的に await を 1〜2 回挟んで処理させる。
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("createResource", () => {
  test("構築直後は loading=true / value=undefined / error=undefined", () => {
    const r = createResource(() => Promise.resolve(42));
    expect(r.loading).toBe(true);
    expect(r.value).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  test("resolve 後: value 反映 + loading=false", async () => {
    const r = createResource(() => Promise.resolve(42));
    await flush();
    expect(r.loading).toBe(false);
    expect(r.value).toBe(42);
    expect(r.error).toBeUndefined();
  });

  test("reject 後: error 反映 + loading=false、value は前回値を保持", async () => {
    let n = 0;
    const r = createResource(() =>
      ++n === 1 ? Promise.resolve(100) : Promise.reject(new Error("boom")),
    );
    await flush();
    expect(r.value).toBe(100);

    r.refetch();
    await flush();
    expect(r.loading).toBe(false);
    expect(r.error).toBeInstanceOf(Error);
    expect((r.error as Error).message).toBe("boom");
    // reject 後も value は前回値 (Solid 互換)
    expect(r.value).toBe(100);
  });

  test("refetch: 再実行で loading=true → 新 value", async () => {
    let n = 0;
    const r = createResource(() => Promise.resolve(++n));
    await flush();
    expect(r.value).toBe(1);

    r.refetch();
    expect(r.loading).toBe(true);
    expect(r.error).toBeUndefined();
    await flush();
    expect(r.loading).toBe(false);
    expect(r.value).toBe(2);
  });

  test("race condition: 古い in-flight の resolve は token 不一致で握り潰される", async () => {
    let resolveFirst!: (v: number) => void;
    let resolveSecond!: (v: number) => void;
    const promises = [
      new Promise<number>((res) => {
        resolveFirst = res;
      }),
      new Promise<number>((res) => {
        resolveSecond = res;
      }),
    ];
    let i = 0;
    const r = createResource(() => promises[i++]!);

    // 1 つ目 (constructor 起動分) はまだ pending。即 refetch で 2 つ目を起動。
    r.refetch();

    // 2 つ目が先に resolve → 反映される
    resolveSecond(20);
    await flush();
    expect(r.value).toBe(20);

    // 1 つ目が後追いで resolve しても、token 不一致で無視される
    resolveFirst(10);
    await flush();
    expect(r.value).toBe(20);
  });

  test("effect 経由で .value / .loading が reactive 追従する", async () => {
    const r = createResource(() => Promise.resolve("hello"));
    let captured: string | undefined;
    let loadingHistory: boolean[] = [];
    effect(() => {
      captured = r.value;
      loadingHistory.push(r.loading);
    });
    // 初回 effect: loading=true、value=undefined
    expect(captured).toBeUndefined();
    expect(loadingHistory).toEqual([true]);

    await flush();
    // resolve 後: loading=false に切替、value="hello" に反映 (batch で 1 effect)
    expect(captured).toBe("hello");
    expect(loadingHistory).toEqual([true, false]);
  });
});
