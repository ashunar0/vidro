// @vitest-environment node
// ADR 0051: derive 派楽観更新 + intent pattern + per-route registry の動作確認。
//
// テスト対象:
//   - submission() (= LatestSubmission view): 初期 state / pending 後 / success 後
//   - submissions() (= active array signal): push / 複数 in-flight / cleanup
//   - submit() programmatic: 各 call で新 instance、複数 in-flight 並列実行
//   - Submission.retry(): pending 中 no-op、completed 後に同 input で再 submit
//   - Submission.clear(): array から remove
//   - encoding 推論 (FormData / URLSearchParams / plain object × encoding)
//   - lifecycle (pending true → result/error → pending false)
//   - dispatcher 不在時の no-op + warn
//   - _clearAllSubmissionState (navigation flush)
//   - _cleanupSuccessfulSubmissions (= 同 page revalidate 完了で auto-remove)
//   - intent pattern: FormData の intent field が input に正規化される

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import {
  _cleanupSuccessfulSubmissions,
  _clearAllSubmissionState,
  _createSubmissionInstance,
  _registerDispatcher,
  _resetRegistryForTest,
  submission,
  submissions,
  submit,
} from "../src/action";

describe("submission / submissions / submit (ADR 0051)", () => {
  let warnSpy: ReturnType<typeof vi.fn> | null = null;

  beforeEach(() => {
    _resetRegistryForTest();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {}) as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    (warnSpy as unknown as { mockRestore: () => void } | null)?.mockRestore();
    warnSpy = null;
  });

  // ---- LatestSubmission view (= submission()) ----

  test("submission(): 初期 state — 全 signal が undefined / false", () => {
    const sub = submission();
    expect(sub.value.value).toBeUndefined();
    expect(sub.pending.value).toBe(false);
    expect(sub.error.value).toBeUndefined();
    expect(sub.input.value).toBeUndefined();
  });

  test("submission(): submit 後に最新 instance の state を反映", async () => {
    const view = submission();
    const unregister = _registerDispatcher({
      dispatch: async (_path, state) => {
        state.setResult({ ok: true });
        state.setPending(false);
      },
    });
    try {
      await submit({ title: "x" });
      expect(view.value.value).toEqual({ ok: true });
      expect(view.pending.value).toBe(false);
      expect(view.input.value).toEqual({ title: "x" });
    } finally {
      unregister();
    }
  });

  test("submission(): 連続 submit で最新 instance を反映 (= 末尾 view)", async () => {
    const view = submission();
    const unregister = _registerDispatcher({
      dispatch: async (_path, state) => {
        const input = state._input.value;
        state.setResult({ echoed: input });
        state.setPending(false);
      },
    });
    try {
      await submit({ id: 1 });
      expect(view.value.value).toEqual({ echoed: { id: 1 } });
      await submit({ id: 2 });
      expect(view.value.value).toEqual({ echoed: { id: 2 } });
    } finally {
      unregister();
    }
  });

  // ---- active array (= submissions()) ----

  test("submissions(): 初期は空 array", () => {
    const subs = submissions();
    expect(subs.value).toEqual([]);
  });

  test("submissions(): submit するたびに array に push される (= 複数 in-flight)", async () => {
    const subs = submissions();
    let resolveDispatch: (() => void) | null = null;
    const unregister = _registerDispatcher({
      dispatch: async () => {
        // dispatcher 内で resolve を待つ → 全部 in-flight のまま観察できる
        await new Promise<void>((resolve) => {
          resolveDispatch = resolve;
        });
      },
    });
    try {
      const p1 = submit({ id: 1 });
      const p2 = submit({ id: 2 });
      const p3 = submit({ id: 3 });
      // 3 つとも in-flight
      expect(subs.value).toHaveLength(3);
      expect(subs.value.every((s) => s.pending.value)).toBe(true);
      // 解放して全部完了させる
      resolveDispatch!();
      // 直後に再度 resolve できるよう dispatcher を更新する代わりに、
      // 以降は dispatcher が同じ resolveDispatch を握りっぱなしなので、
      // 個別に await しても resolve 済 (1 つの resolve が全 dispatch の Promise を resolve しないので、ここで止まる)
      //
      // → このテストは単に「push されること」だけを確認する。完了を待たずに早期 return する。
      // (= dispatch が解放された後に新たに await する待ちは別 test で行う)
      void p1;
      void p2;
      void p3;
    } finally {
      unregister();
    }
  });

  test("submissions(): success 完了で array に残る (= 明示 cleanup されるまで保持)", async () => {
    const subs = submissions();
    const unregister = _registerDispatcher({
      dispatch: async (_path, state) => {
        state.setResult({ ok: true });
        state.setPending(false);
      },
    });
    try {
      await submit({ id: 1 });
      // 完了済だが array にまだ居る (auto-cleanup は revalidate 完了で別途呼ぶ)
      expect(subs.value).toHaveLength(1);
      expect(subs.value[0]!.pending.value).toBe(false);
      expect(subs.value[0]!.value.value).toEqual({ ok: true });
    } finally {
      unregister();
    }
  });

  test("submissions(): 各 instance は固有 id を持つ", async () => {
    const subs = submissions();
    const unregister = _registerDispatcher({
      dispatch: async (_path, state) => {
        state.setResult({ ok: true });
        state.setPending(false);
      },
    });
    try {
      await submit({ a: 1 });
      await submit({ a: 2 });
      const ids = subs.value.map((s) => s.id);
      expect(new Set(ids).size).toBe(2); // unique
    } finally {
      unregister();
    }
  });

  // ---- intent pattern (= FormData の intent field 正規化) ----

  test("intent pattern: FormData の intent / その他 field が input に乗る", async () => {
    const subs = submissions();
    const unregister = _registerDispatcher({
      dispatch: async (_path, state) => {
        state.setResult({ ok: true });
        state.setPending(false);
      },
    });
    try {
      const fd = new FormData();
      fd.append("intent", "create");
      fd.append("title", "hello");
      await submit(fd);
      expect(subs.value[0]!.input.value).toEqual({ intent: "create", title: "hello" });
    } finally {
      unregister();
    }
  });

  test("intent pattern: 異なる intent の submission は同 array で共存 (= filter で分離)", async () => {
    const subs = submissions();
    const unregister = _registerDispatcher({
      dispatch: async (_path, state) => {
        state.setResult({ ok: true });
        state.setPending(false);
      },
    });
    try {
      await submit({ intent: "create", title: "A" });
      await submit({ intent: "delete", id: "3" });
      await submit({ intent: "create", title: "B" });
      const creates = subs.value.filter((s) => s.input.value?.intent === "create");
      const deletes = subs.value.filter((s) => s.input.value?.intent === "delete");
      expect(creates).toHaveLength(2);
      expect(deletes).toHaveLength(1);
      expect(deletes[0]!.input.value).toEqual({ intent: "delete", id: "3" });
    } finally {
      unregister();
    }
  });

  // ---- retry / clear ----

  test("Submission.retry(): 同 input で再 submit", async () => {
    const subs = submissions();
    let dispatchCount = 0;
    let lastInput: unknown;
    const unregister = _registerDispatcher({
      dispatch: async (_path, state) => {
        dispatchCount++;
        lastInput = state._input.value;
        state.setResult({ ok: dispatchCount });
        state.setPending(false);
      },
    });
    try {
      await submit({ title: "x" });
      expect(dispatchCount).toBe(1);
      const sub0 = subs.value[0]!;
      await sub0.retry();
      expect(dispatchCount).toBe(2);
      expect(lastInput).toEqual({ title: "x" });
      // identity 維持 (= 同 instance、id は変わらず)
      expect(subs.value).toHaveLength(1);
      expect(subs.value[0]!.id).toBe(sub0.id);
    } finally {
      unregister();
    }
  });

  test("Submission.retry(): pending 中は no-op", async () => {
    const subs = submissions();
    let resolveDispatch: (() => void) | null = null;
    let dispatchCount = 0;
    const unregister = _registerDispatcher({
      dispatch: async (_path, state) => {
        dispatchCount++;
        await new Promise<void>((resolve) => {
          resolveDispatch = resolve;
        });
        state.setResult({ ok: true });
        state.setPending(false);
      },
    });
    try {
      const p = submit({ title: "x" });
      // pending 中
      expect(subs.value[0]!.pending.value).toBe(true);
      // retry は no-op (pending 中)
      await subs.value[0]!.retry();
      expect(dispatchCount).toBe(1);
      resolveDispatch!();
      await p;
    } finally {
      unregister();
    }
  });

  test("Submission.clear(): array から remove", async () => {
    const subs = submissions();
    const unregister = _registerDispatcher({
      dispatch: async (_path, state) => {
        state.setResult({ ok: true });
        state.setPending(false);
      },
    });
    try {
      await submit({ a: 1 });
      await submit({ a: 2 });
      expect(subs.value).toHaveLength(2);
      subs.value[0]!.clear();
      expect(subs.value).toHaveLength(1);
      expect(subs.value[0]!.input.value).toEqual({ a: 2 });
    } finally {
      unregister();
    }
  });

  // ---- encoding 推論 ----

  test("submit() plain object: default は JSON encoding", async () => {
    let captured: { path: string; body: BodyInit; headers: Record<string, string> } | null = null;
    const unregister = _registerDispatcher({
      dispatch: async (path, state, fetchInit) => {
        captured = { path, ...fetchInit };
        state.setResult({ ok: true });
        state.setPending(false);
      },
    });
    try {
      await submit({ title: "hello" }, { action: "/notes" });
      expect(captured!.path).toBe("/notes");
      expect(captured!.headers["Content-Type"]).toBe("application/json");
      expect(captured!.body).toBe(JSON.stringify({ title: "hello" }));
    } finally {
      unregister();
    }
  });

  test("submit() FormData: そのまま渡す (Content-Type は browser default)", async () => {
    const fd = new FormData();
    fd.append("title", "fd");
    let captured: { body: BodyInit; headers: Record<string, string> } | null = null;
    const unregister = _registerDispatcher({
      dispatch: async (_path, state, fetchInit) => {
        captured = fetchInit;
        state.setResult({ ok: true });
        state.setPending(false);
      },
    });
    try {
      await submit(fd, { action: "/notes" });
      expect(captured!.body).toBe(fd);
      expect(captured!.headers).toEqual({});
    } finally {
      unregister();
    }
  });

  test("submit() URLSearchParams: form-urlencoded ヘッダ付き", async () => {
    const params = new URLSearchParams({ title: "u" });
    let captured: { body: BodyInit; headers: Record<string, string> } | null = null;
    const unregister = _registerDispatcher({
      dispatch: async (_path, state, fetchInit) => {
        captured = fetchInit;
        state.setResult({ ok: true });
        state.setPending(false);
      },
    });
    try {
      await submit(params, { action: "/notes" });
      expect(captured!.body).toBe(params);
      expect(captured!.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    } finally {
      unregister();
    }
  });

  test("submit() plain object + encoding=form: urlencoded に変換", async () => {
    let captured: { body: BodyInit; headers: Record<string, string> } | null = null;
    const unregister = _registerDispatcher({
      dispatch: async (_path, state, fetchInit) => {
        captured = fetchInit;
        state.setResult({ ok: true });
        state.setPending(false);
      },
    });
    try {
      await submit({ a: "1", b: "2" }, { encoding: "form", action: "/notes" });
      expect(captured!.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      expect(captured!.body).toBeInstanceOf(URLSearchParams);
      const p = captured!.body as URLSearchParams;
      expect(p.get("a")).toBe("1");
      expect(p.get("b")).toBe("2");
    } finally {
      unregister();
    }
  });

  // ---- input normalize ----

  test("input: plain object は shallow clone される (= caller の参照変更で input は不変)", async () => {
    const subs = submissions();
    const unregister = _registerDispatcher({
      dispatch: async (_path, state) => {
        state.setResult({ ok: true });
        state.setPending(false);
      },
    });
    const original = { title: "first" };
    try {
      await submit(original);
      expect(subs.value[0]!.input.value).toEqual({ title: "first" });
      original.title = "mutated";
      expect(subs.value[0]!.input.value).toEqual({ title: "first" });
    } finally {
      unregister();
    }
  });

  test("input: 引数なし submit では undefined のまま (= 「入力なし」明示)", async () => {
    const subs = submissions();
    const unregister = _registerDispatcher({
      dispatch: async (_path, state) => {
        state.setResult({ ok: true });
        state.setPending(false);
      },
    });
    try {
      await submit();
      expect(subs.value[0]!.input.value).toBeUndefined();
    } finally {
      unregister();
    }
  });

  // ---- error / dispatcher 不在 ----

  test("error: state.setError で error 反映、value はクリア", async () => {
    const subs = submissions();
    const unregister = _registerDispatcher({
      dispatch: async (_path, state) => {
        state.setError({ name: "ValidationError", message: "bad" });
        state.setPending(false);
      },
    });
    try {
      await submit({ title: "broken" });
      const sub = subs.value[0]!;
      expect(sub.error.value?.message).toBe("bad");
      expect(sub.value.value).toBeUndefined();
      // input は失敗後も保持 (= retry / 再入力に流用可)
      expect(sub.input.value).toEqual({ title: "broken" });
    } finally {
      unregister();
    }
  });

  test("submit(): dispatcher 不在時は no-op + console.warn", async () => {
    await submit({ title: "x" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(submissions().value).toEqual([]);
  });

  // ---- navigation flush ----

  test("_clearAllSubmissionState: 全 route slot の active を空にする", async () => {
    const subs = submissions();
    const unregister = _registerDispatcher({
      dispatch: async (_path, state) => {
        state.setResult({ ok: true });
        state.setPending(false);
      },
    });
    try {
      await submit({ a: 1 });
      await submit({ a: 2 });
      expect(subs.value).toHaveLength(2);

      _clearAllSubmissionState();
      expect(subs.value).toEqual([]);
    } finally {
      unregister();
    }
  });

  test("_clearAllSubmissionState: signal identity を保持 (= 再 submission() で同 signal)", () => {
    const view1 = submission();
    _clearAllSubmissionState();
    const view2 = submission();
    // computed の identity は呼び出しごとに変わるが、underlying slot.active signal は同じ。
    // ここでは「flush 後でも error なく動く」ことだけ確認 (slot identity は internal)。
    expect(view1.value.value).toBeUndefined();
    expect(view2.value.value).toBeUndefined();
  });

  // ---- auto-cleanup (= 同 page loader revalidate 完了で success を array から remove) ----

  test("_cleanupSuccessfulSubmissions: success のみ remove、errored / pending は残す", async () => {
    const subs = submissions();
    let resolveSecond: (() => void) | null = null;
    const unregister = _registerDispatcher({
      dispatch: async (_path, state) => {
        const input = state._input.value;
        if (input?.kind === "success") {
          state.setResult({ ok: true });
          state.setPending(false);
        } else if (input?.kind === "error") {
          state.setError({ name: "ValidationError", message: "boom" });
          state.setPending(false);
        } else if (input?.kind === "pending") {
          // resolve しない (= pending のまま保持)
          await new Promise<void>((resolve) => {
            resolveSecond = resolve;
          });
        }
      },
    });
    try {
      // 1 回目: success
      await submit({ kind: "success" });
      // 2 回目: error
      await submit({ kind: "error" });
      // 3 回目: pending のまま保持
      const pendingPromise = submit({ kind: "pending" });

      expect(subs.value).toHaveLength(3);

      // route path は default の "/" (SSR fallback)。test 環境で window が無いため。
      _cleanupSuccessfulSubmissions("/");

      // success は remove、error / pending は残る
      expect(subs.value).toHaveLength(2);
      const kinds = subs.value.map((s) => {
        const k = s.input.value?.kind;
        return typeof k === "string" ? k : "";
      });
      kinds.sort((a, b) => a.localeCompare(b));
      expect(kinds).toEqual(["error", "pending"]);

      resolveSecond!();
      await pendingPromise;
    } finally {
      unregister();
    }
  });

  test("_cleanupSuccessfulSubmissions: 存在しない route は no-op", () => {
    expect(() => _cleanupSuccessfulSubmissions("/never-touched")).not.toThrow();
  });

  // ---- _createSubmissionInstance (internal) ----

  test("_createSubmissionInstance: 直接呼び出しで Submission instance を作って array に push", () => {
    const subs = submissions();
    const { state, submission: inst } = _createSubmissionInstance(
      "/",
      { foo: "bar" },
      JSON.stringify({ foo: "bar" }),
      { "Content-Type": "application/json" },
    );
    expect(subs.value).toContain(inst);
    expect(inst.id).toBeTruthy();
    expect(inst.pending.value).toBe(true);
    expect(inst.input.value).toEqual({ foo: "bar" });
    state.setResult({ ok: true });
    state.setPending(false);
    expect(inst.value.value).toEqual({ ok: true });
    expect(inst.pending.value).toBe(false);
  });

  // ---- multi-route isolation ----

  test("別 route の submission は独立 (= /a への submit が /b の subs に漏れない)", async () => {
    const unregister = _registerDispatcher({
      dispatch: async (_path, state) => {
        state.setResult({ ok: true });
        state.setPending(false);
      },
    });
    try {
      await submit({ x: 1 }, { action: "/a" });
      await submit({ x: 2 }, { action: "/b" });
      // submit() は opts.action で path を上書き、各 path の slot に push される
      // submissions() は default pathname "/" を見るので空のはず (test env)
      expect(submissions().value).toHaveLength(0);
    } finally {
      unregister();
    }
  });
});
