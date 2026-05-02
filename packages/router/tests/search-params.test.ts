// @vitest-environment jsdom
// ADR 0052 — searchParams() / revalidate() の単体検証。
// jsdom で window / history / location / popstate を扱い、Path Y の動作 (= URL ↔
// signal sync は行うが loader 自動再実行はしない) を最小単位で確認する。

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { isSignal } from "@vidro/core";
import {
  _endServerSearchScope,
  _initServerSearch,
  _registerRevalidator,
  _resetSearchParamsForTest,
  _syncSearchParamsFromUrl,
  revalidate,
  searchParams,
} from "../src/search-params";

beforeEach(() => {
  // 各 test で URL を初期化 (= history を /test に reset)。
  window.history.replaceState({}, "", "/test");
  _resetSearchParamsForTest();
});

afterEach(() => {
  _resetSearchParamsForTest();
});

describe("searchParams() — public API", () => {
  test("URL の existing param を Signal として返す", () => {
    window.history.replaceState({}, "", "/test?q=Vidro&page=2");
    const sp = searchParams();
    expect(isSignal(sp.q)).toBe(true);
    expect(sp.q.value).toBe("Vidro");
    expect(sp.page.value).toBe("2");
  });

  test("未指定 key は undefined", () => {
    window.history.replaceState({}, "", "/test?q=Vidro");
    const sp = searchParams();
    expect(sp.missing.value).toBeUndefined();
  });

  test("同 page 内で複数回呼んでも signal identity は共有される", () => {
    window.history.replaceState({}, "", "/test?q=Vidro");
    const sp1 = searchParams();
    const sp2 = searchParams();
    // Proxy instance 自体は別だが get trap が同じ Map を見るので signal は同一
    expect(sp1.q).toBe(sp2.q);
  });

  test("write で URL が history.replaceState 経由で更新される (= history を汚さない)", () => {
    window.history.replaceState({}, "", "/test");
    const sp = searchParams();
    sp.q.value = "Vidro";
    expect(window.location.search).toBe("?q=Vidro");
  });

  test("undefined 代入で URL から完全削除 (= URLSearchParams.delete)", () => {
    window.history.replaceState({}, "", "/test?q=Vidro&page=2");
    const sp = searchParams();
    // 一度 access して signal を生成
    expect(sp.q.value).toBe("Vidro");
    sp.q.value = undefined;
    expect(window.location.search).toBe("?page=2");
  });

  test('空文字 ("") 代入で URL に q= (empty value) として残す', () => {
    window.history.replaceState({}, "", "/test?q=Vidro");
    const sp = searchParams();
    expect(sp.q.value).toBe("Vidro");
    sp.q.value = "";
    // URLSearchParams は空文字でも `q=` として保持する (= delete とは区別)。
    expect(window.location.search).toBe("?q=");
  });

  test("write で history.pushState は呼ばれない (= replaceState 固定)", () => {
    window.history.replaceState({}, "", "/test");
    const pushSpy = vi.spyOn(window.history, "pushState");
    const sp = searchParams();
    sp.q.value = "Vidro";
    expect(pushSpy).not.toHaveBeenCalled();
    pushSpy.mockRestore();
  });
});

describe("_syncSearchParamsFromUrl()", () => {
  test("URL の値が変化すると既存 signal の値も更新される", () => {
    window.history.replaceState({}, "", "/test?q=Vidro");
    const sp = searchParams();
    expect(sp.q.value).toBe("Vidro");

    // 直接 URL を書き換える (popstate 相当)
    window.history.replaceState({}, "", "/test?q=Solid");
    _syncSearchParamsFromUrl();

    expect(sp.q.value).toBe("Solid");
  });

  test("URL から param が消えた場合 signal は undefined になる", () => {
    window.history.replaceState({}, "", "/test?q=Vidro&page=2");
    const sp = searchParams();
    expect(sp.q.value).toBe("Vidro");

    window.history.replaceState({}, "", "/test?page=2");
    _syncSearchParamsFromUrl();

    expect(sp.q.value).toBeUndefined();
    expect(sp.page.value).toBe("2");
  });

  test("sync 中は subscribe 経由 replaceState は走らない (= 二重書き込み抑止)", () => {
    window.history.replaceState({}, "", "/test?q=Vidro");
    const sp = searchParams();
    void sp.q.value; // signal 生成

    const replaceSpy = vi.spyOn(window.history, "replaceState");
    window.history.replaceState({}, "", "/test?q=Solid");
    expect(replaceSpy).toHaveBeenCalledTimes(1); // 上の手動 replaceState

    _syncSearchParamsFromUrl();
    // sync 由来の signal 更新では追加 replaceState は走らない
    expect(replaceSpy).toHaveBeenCalledTimes(1);

    replaceSpy.mockRestore();
  });
});

describe("SSR scope — _initServerSearch / _endServerSearchScope", () => {
  test("server 側で URL を持たずに initial search から signal が初期化できる", () => {
    // window.location.search を空に reset
    window.history.replaceState({}, "", "/test");
    _initServerSearch("?q=Vidro&page=2");

    const sp = searchParams();
    expect(sp.q.value).toBe("Vidro");
    expect(sp.page.value).toBe("2");

    _endServerSearchScope();
  });

  test("_endServerSearchScope() で signals がクリアされて次 request に漏れない", () => {
    _initServerSearch("?q=Vidro");
    const sp1 = searchParams();
    const q1 = sp1.q;
    expect(q1.value).toBe("Vidro");

    _endServerSearchScope();
    _initServerSearch("?q=Solid");

    const sp2 = searchParams();
    // 別 request の signal なので identity が異なる (= 漏れない)
    expect(sp2.q).not.toBe(q1);
    expect(sp2.q.value).toBe("Solid");

    _endServerSearchScope();
  });
});

describe("revalidate()", () => {
  test("Router 未 mount (revalidator 未登録) では Promise.resolve() の no-op", async () => {
    const result = await revalidate();
    expect(result).toBeUndefined();
  });

  test("登録された revalidator が呼ばれて、その Promise が伝播する", async () => {
    let resolver: () => void = () => {};
    const fn = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolver = res;
        }),
    );
    const unregister = _registerRevalidator(fn);

    const p = revalidate();
    expect(fn).toHaveBeenCalledOnce();

    // resolver を発火させて await 解放を確認
    resolver();
    await p;

    unregister();
  });

  test("unregister 後は再度 no-op", async () => {
    const fn = vi.fn(() => Promise.resolve());
    const unregister = _registerRevalidator(fn);
    await revalidate();
    expect(fn).toHaveBeenCalledOnce();

    unregister();
    await revalidate();
    expect(fn).toHaveBeenCalledOnce(); // 増えてない
  });
});
