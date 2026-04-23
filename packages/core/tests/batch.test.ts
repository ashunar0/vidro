import { describe, expect, test, vi } from "vite-plus/test";
import { batch } from "../src/batch";
import { computed } from "../src/computed";
import { effect } from "../src/effect";
import { signal } from "../src/signal";

describe("batch", () => {
  test("複数 Signal 書き込みは 1 回の Effect 実行にまとまる", () => {
    const a = signal(0);
    const b = signal(0);
    const fn = vi.fn(() => {
      void a.value;
      void b.value;
    });
    effect(fn);
    expect(fn).toHaveBeenCalledTimes(1);

    batch(() => {
      a.value = 1;
      b.value = 2;
    });
    // batch 外から観測できるのは flush 後の状態のみ — 計 2 回 (初回 + flush 後 1 回)
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("batch 内での同一 Effect に対する notify は重複排除される", () => {
    const a = signal(0);
    const fn = vi.fn(() => {
      void a.value;
    });
    effect(fn);

    batch(() => {
      a.value = 1;
      a.value = 2;
      a.value = 3;
    });
    // 初回 + 最後の flush で 1 回 = 2 回
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("nested batch は最外で 1 回だけ flush される", () => {
    const a = signal(0);
    const b = signal(0);
    const fn = vi.fn(() => {
      void a.value;
      void b.value;
    });
    effect(fn);

    batch(() => {
      a.value = 1;
      batch(() => {
        b.value = 2;
      });
      // ここで内側 batch を抜けたが外側が生きているので flush されない
      expect(fn).toHaveBeenCalledTimes(1);
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("batch は fn の戻り値をそのまま返す", () => {
    const result = batch(() => 42);
    expect(result).toBe(42);
  });

  test("batch 内で fn が throw した場合も queue を flush してから例外を再送する", () => {
    const a = signal(0);
    const b = signal(0);
    const fn = vi.fn(() => {
      void a.value;
      void b.value;
    });
    effect(fn);

    expect(() =>
      batch(() => {
        a.value = 1;
        b.value = 2;
        throw new Error("boom");
      }),
    ).toThrow("boom");

    // flush されて最新状態を observer が見ている
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("例外後も batchDepth が復元されていて次の batch が正しく動く", () => {
    const a = signal(0);
    const fn = vi.fn(() => {
      void a.value;
    });
    effect(fn);

    expect(() =>
      batch(() => {
        throw new Error("boom");
      }),
    ).toThrow();

    batch(() => {
      a.value = 1;
      a.value = 2;
    });
    // 初回 + (boom batch は書き込みなしなので flush されても effect は呼ばれない) + 最後の batch で 1 回 = 2 回
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("batch 中でも Computed は最新値を pull できる (batch は Computed の lazy 性に干渉しない)", () => {
    const a = signal(1);
    const doubled = computed(() => a.value * 2);
    const fn = vi.fn(() => {
      void doubled.value;
    });
    effect(fn);
    expect(fn).toHaveBeenCalledTimes(1);

    batch(() => {
      a.value = 5;
      // batch 中に Computed を直接読む — 再計算されて 10 が取れる
      expect(doubled.value).toBe(10);
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("batch 外の Signal 書き込みは従来どおり即 Effect 実行", () => {
    const a = signal(0);
    const fn = vi.fn(() => {
      void a.value;
    });
    effect(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    a.value = 1;
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
