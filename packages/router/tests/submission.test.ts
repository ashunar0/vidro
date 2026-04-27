// @vitest-environment node
// ADR 0038 Phase 3 R-mid-1: submission() factory の per-key registry +
// `bind()` + programmatic `submit()` の動作確認。
//
// テスト対象:
//   - 初期 state (value=undefined / pending=false / error=undefined)
//   - per-key 共有: 同 key の `submission()` を 2 回呼ぶと同じ signal セット
//   - 別 key 独立: 別 key の signal は互いに干渉しない
//   - bind() は data-vidro-sub に key を入れる
//   - state 永続: setResult 後に再度 submission(key) を呼んでも value 保持
//     (= swap シミュレーション、registry が module scope なので OK)
//   - submit() の encoding 推論 (FormData / URLSearchParams / plain object × encoding)
//   - submit() の lifecycle (pending true → result/error → pending false)
//   - 連打 guard (同 key の in-flight 中は no-op)
//   - dispatcher 不在時の no-op + warn
//   - reset() で当該 key の field 初期化

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import {
  _getSubmissionMutator,
  _registerDispatcher,
  _resetRegistryForTest,
  submission,
  type SubmitDispatcher,
} from "../src/action";

describe("submission factory (ADR 0038 Phase 3 R-mid-1, per-key)", () => {
  // console.warn の spy: dispatcher 不在時の warn を観察 + テスト出力を黙らせる。
  let warnSpy: ReturnType<typeof vi.fn> | null = null;

  beforeEach(() => {
    // registry 全 entry を一括 reset (将来 key が増えても test 間 leak しない)
    _resetRegistryForTest();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {}) as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    (warnSpy as unknown as { mockRestore: () => void } | null)?.mockRestore();
    warnSpy = null;
  });

  test("初期 state: value/error undefined、pending false", () => {
    const sub = submission();
    expect(sub.value.value).toBeUndefined();
    expect(sub.pending.value).toBe(false);
    expect(sub.error.value).toBeUndefined();
  });

  test("同 key 共有: 2 回 call で同じ signal セット", () => {
    const a = submission("k1");
    const b = submission("k1");

    const mu = _getSubmissionMutator("k1")!;
    mu.setResult({ ok: "shared" });
    expect(a.value.value).toEqual({ ok: "shared" });
    expect(b.value.value).toEqual({ ok: "shared" }); // 同じ signal
  });

  test("別 key 独立: 別 key の signal は干渉しない", () => {
    const a = submission("k1");
    const b = submission("k2");

    _getSubmissionMutator("k1")!.setResult({ ok: "a" });
    expect(a.value.value).toEqual({ ok: "a" });
    expect(b.value.value).toBeUndefined();

    _getSubmissionMutator("k2")!.setError({ name: "ValidationError", message: "boom" });
    expect(b.error.value?.message).toBe("boom");
    expect(a.error.value).toBeUndefined();
  });

  test("bind() は data-vidro-sub に key を入れる", () => {
    expect(submission().bind()["data-vidro-sub"]).toBe("default");
    expect(submission("create").bind()["data-vidro-sub"]).toBe("create");
    expect(submission("delete").bind()["data-vidro-sub"]).toBe("delete");
  });

  test("state 永続: setResult 後の再 submission(key) で value 保持 (swap simulation)", () => {
    const first = submission("create");
    _getSubmissionMutator("create")!.setResult({ added: { title: "x" } });
    expect(first.value.value).toEqual({ added: { title: "x" } });

    // 再 mount を simulate: 新 component が再度 submission("create") を呼ぶ
    // (= 古い NotesPage は swap で破棄されたが registry は module scope で残る)
    const second = submission("create");
    expect(second.value.value).toEqual({ added: { title: "x" } });
  });

  test("mutator 経由で result セットすると error は自動クリア", () => {
    const sub = submission("k1");
    const mu = _getSubmissionMutator("k1")!;
    mu.setError({ name: "Error", message: "first" });
    expect(sub.error.value?.message).toBe("first");
    mu.setResult({ ok: true });
    expect(sub.value.value).toEqual({ ok: true });
    expect(sub.error.value).toBeUndefined();
  });

  test("mutator 経由で error セットすると value は自動クリア", () => {
    const sub = submission("k1");
    const mu = _getSubmissionMutator("k1")!;
    mu.setResult({ ok: true });
    mu.setError({ name: "Error", message: "boom" });
    expect(sub.error.value?.message).toBe("boom");
    expect(sub.value.value).toBeUndefined();
  });

  test("reset: 当該 key の全 field 初期化、別 key には影響なし", () => {
    const a = submission("k1");
    const b = submission("k2");
    _getSubmissionMutator("k1")!.setResult({ ok: "a" });
    _getSubmissionMutator("k2")!.setResult({ ok: "b" });

    a.reset();
    expect(a.value.value).toBeUndefined();
    expect(b.value.value).toEqual({ ok: "b" });
  });

  test("submit() — dispatcher 不在時は no-op + console.warn", async () => {
    const sub = submission();
    await sub.submit({ title: "x" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(sub.pending.value).toBe(false);
    expect(sub.value.value).toBeUndefined();
  });

  test("submit() plain object: default は JSON encoding", async () => {
    const sub = submission("create");
    let captured: { path: string; body: BodyInit; headers: Record<string, string> } | null = null;
    const dispatcher: SubmitDispatcher = {
      dispatch: async (path, mutator, fetchInit) => {
        captured = { path, ...fetchInit };
        mutator.setResult({ ok: true });
      },
    };
    const unregister = _registerDispatcher(dispatcher);
    try {
      await sub.submit({ title: "hello" }, { action: "/notes" });
      expect(captured!.path).toBe("/notes");
      expect(captured!.headers["Content-Type"]).toBe("application/json");
      expect(captured!.body).toBe(JSON.stringify({ title: "hello" }));
      expect(sub.value.value).toEqual({ ok: true });
    } finally {
      unregister();
    }
  });

  test("submit() FormData: そのまま渡す (Content-Type は browser default)", async () => {
    const sub = submission("create");
    const fd = new FormData();
    fd.append("title", "fd");
    let captured: { body: BodyInit; headers: Record<string, string> } | null = null;
    const unregister = _registerDispatcher({
      dispatch: async (_path, _mu, fetchInit) => {
        captured = fetchInit;
      },
    });
    try {
      await sub.submit(fd, { action: "/notes" });
      expect(captured!.body).toBe(fd);
      expect(captured!.headers).toEqual({});
    } finally {
      unregister();
    }
  });

  test("submit() URLSearchParams: form-urlencoded ヘッダ付き", async () => {
    const sub = submission("create");
    const params = new URLSearchParams({ title: "u" });
    let captured: { body: BodyInit; headers: Record<string, string> } | null = null;
    const unregister = _registerDispatcher({
      dispatch: async (_path, _mu, fetchInit) => {
        captured = fetchInit;
      },
    });
    try {
      await sub.submit(params, { action: "/notes" });
      expect(captured!.body).toBe(params);
      expect(captured!.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    } finally {
      unregister();
    }
  });

  test("submit() plain object + encoding=form: urlencoded に変換", async () => {
    const sub = submission("create");
    let captured: { body: BodyInit; headers: Record<string, string> } | null = null;
    const unregister = _registerDispatcher({
      dispatch: async (_path, _mu, fetchInit) => {
        captured = fetchInit;
      },
    });
    try {
      await sub.submit({ a: "1", b: "2" }, { encoding: "form", action: "/notes" });
      expect(captured!.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      expect(captured!.body).toBeInstanceOf(URLSearchParams);
      const params = captured!.body as URLSearchParams;
      expect(params.get("a")).toBe("1");
      expect(params.get("b")).toBe("2");
    } finally {
      unregister();
    }
  });

  test("submit() 連打 guard: 同 key の in-flight 中は 2 回目 no-op", async () => {
    const sub = submission("k1");
    let dispatchCount = 0;
    let resolveFirst: (() => void) | null = null;

    const unregister = _registerDispatcher({
      dispatch: async (_path, mutator) => {
        dispatchCount++;
        mutator.setPending(true);
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
        mutator.setPending(false);
      },
    });

    try {
      const p1 = sub.submit({ a: 1 }, { action: "/" });
      // 連打: pending true 中の 2 回目は dispatch されない
      const p2 = sub.submit({ a: 2 }, { action: "/" });
      // p2 は即時 resolve (pending guard で no-op)
      await p2;
      expect(dispatchCount).toBe(1);

      resolveFirst!();
      await p1;
      expect(sub.pending.value).toBe(false);
    } finally {
      unregister();
    }
  });

  test("別 key は並列 submit 可能 (= 連打 guard は per-key)", async () => {
    const subA = submission("k1");
    const subB = submission("k2");
    let count = 0;
    const unregister = _registerDispatcher({
      dispatch: async (_path, mutator) => {
        count++;
        mutator.setPending(true);
        await Promise.resolve();
        mutator.setPending(false);
      },
    });
    try {
      await Promise.all([
        subA.submit({ x: 1 }, { action: "/" }),
        subB.submit({ y: 1 }, { action: "/" }),
      ]);
      expect(count).toBe(2);
    } finally {
      unregister();
    }
  });

  // ---- ADR 0040 Phase 4 step 1: input lifecycle ----

  test("input: 初期値は undefined", () => {
    const sub = submission("p4-init");
    expect(sub.input.value).toBeUndefined();
  });

  test("input: plain object で submit すると normalize された input が見える", async () => {
    const sub = submission("p4-plain");
    let observedInput: Record<string, unknown> | undefined;
    const unregister = _registerDispatcher({
      dispatch: async (_path, mutator) => {
        // dispatcher 内で input が確定済みであること (= dispatch 前に setInput 済)
        observedInput = sub.input.value;
        mutator.setResult({ ok: true });
      },
    });
    try {
      await sub.submit({ title: "hello", count: 3 }, { action: "/" });
      expect(observedInput).toEqual({ title: "hello", count: 3 });
      // 完了後も保持
      expect(sub.input.value).toEqual({ title: "hello", count: 3 });
    } finally {
      unregister();
    }
  });

  test("input: FormData は Object.fromEntries で normalize される", async () => {
    const sub = submission("p4-fd");
    const fd = new FormData();
    fd.append("title", "fd-title");
    fd.append("intent", "create");
    const unregister = _registerDispatcher({
      dispatch: async (_path, mutator) => {
        mutator.setResult({ ok: true });
      },
    });
    try {
      await sub.submit(fd, { action: "/" });
      expect(sub.input.value).toEqual({ title: "fd-title", intent: "create" });
    } finally {
      unregister();
    }
  });

  test("input: URLSearchParams も Object.fromEntries で normalize される", async () => {
    const sub = submission("p4-params");
    const params = new URLSearchParams({ a: "1", b: "2" });
    const unregister = _registerDispatcher({
      dispatch: async (_path, mutator) => {
        mutator.setResult({ ok: true });
      },
    });
    try {
      await sub.submit(params, { action: "/" });
      expect(sub.input.value).toEqual({ a: "1", b: "2" });
    } finally {
      unregister();
    }
  });

  test("input: 引数なし submit では undefined のまま (= 「入力なし」明示)", async () => {
    const sub = submission("p4-none");
    const unregister = _registerDispatcher({
      dispatch: async (_path, mutator) => {
        mutator.setResult({ ok: true });
      },
    });
    try {
      await sub.submit();
      expect(sub.input.value).toBeUndefined();
    } finally {
      unregister();
    }
  });

  test("input: 連打 guard で 2 回目 no-op の時は input も上書きされない", async () => {
    const sub = submission("p4-guard");
    let resolveFirst: (() => void) | null = null;
    const unregister = _registerDispatcher({
      dispatch: async (_path, mutator) => {
        mutator.setPending(true);
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
        mutator.setPending(false);
      },
    });
    try {
      const p1 = sub.submit({ a: 1 }, { action: "/" });
      // 1 回目で input が反映され、pending true 中
      expect(sub.input.value).toEqual({ a: 1 });
      // 連打: 2 回目は pending guard で setInput 自体に到達しない
      const p2 = sub.submit({ a: 99 }, { action: "/" });
      await p2;
      expect(sub.input.value).toEqual({ a: 1 }); // 上書きされていない
      resolveFirst!();
      await p1;
    } finally {
      unregister();
    }
  });

  test("input: error 後も保持 (UI で再入力に流用可)", async () => {
    const sub = submission("p4-err");
    const unregister = _registerDispatcher({
      dispatch: async (_path, mutator) => {
        mutator.setError({ name: "ValidationError", message: "bad" });
      },
    });
    try {
      await sub.submit({ title: "broken" }, { action: "/" });
      expect(sub.error.value?.message).toBe("bad");
      expect(sub.input.value).toEqual({ title: "broken" });
    } finally {
      unregister();
    }
  });

  test("input: reset() で undefined に戻る", async () => {
    const sub = submission("p4-reset");
    const unregister = _registerDispatcher({
      dispatch: async (_path, mutator) => {
        mutator.setResult({ ok: true });
      },
    });
    try {
      await sub.submit({ title: "x" }, { action: "/" });
      expect(sub.input.value).toEqual({ title: "x" });
      sub.reset();
      expect(sub.input.value).toBeUndefined();
      // value/pending/error も合わせてクリア (既存挙動の re-confirm)
      expect(sub.value.value).toBeUndefined();
      expect(sub.pending.value).toBe(false);
      expect(sub.error.value).toBeUndefined();
    } finally {
      unregister();
    }
  });

  test("input: 別 key 独立 (registry per-key)", async () => {
    const subA = submission("p4-a");
    const subB = submission("p4-b");
    const unregister = _registerDispatcher({
      dispatch: async (_path, mutator) => {
        mutator.setResult({ ok: true });
      },
    });
    try {
      await subA.submit({ x: 1 }, { action: "/" });
      await subB.submit({ y: 2 }, { action: "/" });
      expect(subA.input.value).toEqual({ x: 1 });
      expect(subB.input.value).toEqual({ y: 2 });
    } finally {
      unregister();
    }
  });

  test("input: plain object は shallow clone される (caller の参照変更で input は不変)", async () => {
    const sub = submission("p4-clone");
    const original = { title: "first" };
    const unregister = _registerDispatcher({
      dispatch: async (_path, mutator) => {
        mutator.setResult({ ok: true });
      },
    });
    try {
      await sub.submit(original, { action: "/" });
      expect(sub.input.value).toEqual({ title: "first" });
      // caller が後から書き換えても input は不変であること
      original.title = "mutated";
      expect(sub.input.value).toEqual({ title: "first" });
    } finally {
      unregister();
    }
  });

  test("_registerDispatcher の戻り値 unregister: 後勝ち上書きで stale unregister は no-op", async () => {
    const d1: SubmitDispatcher = { dispatch: async () => {} };
    let d2Called = false;
    const d2: SubmitDispatcher = {
      dispatch: async () => {
        d2Called = true;
      },
    };

    const u1 = _registerDispatcher(d1);
    const u2 = _registerDispatcher(d2); // d2 が active

    u1(); // d1 を unregister するが、現在 active は d2 なので no-op (d2 を消さない)

    const sub = submission("k1");
    await sub.submit({ a: 1 }, { action: "/" });
    expect(d2Called).toBe(true);
    u2();
  });
});
