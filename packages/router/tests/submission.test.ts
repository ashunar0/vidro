// @vitest-environment node
// ADR 0037 Phase 3 R-min: submission() factory の signal-like state transitions。
//   - 初期 state は value=undefined / pending=false / error=undefined
//   - internal mutator (`_setSubmission*`) で各 field 更新
//   - result セット時に error クリア (mutually exclusive)
//   - error セット時に value クリア
//   - reset() で全 field 初期化
//
// submission() は global state 1 個 (R-min)。test 間で state を初期化するため、
// beforeEach で submission().reset() を呼んで isolation を担保する (review fix #5)。
import { beforeEach, describe, expect, test } from "vite-plus/test";
import {
  _setSubmissionError,
  _setSubmissionPending,
  _setSubmissionResult,
  submission,
} from "../src/action";

describe("submission factory (ADR 0037 Phase 3 R-min)", () => {
  beforeEach(() => {
    submission().reset();
  });

  test("初期 state: value/error undefined、pending false", () => {
    const sub = submission();
    expect(sub.value.value).toBeUndefined();
    expect(sub.pending.value).toBe(false);
    expect(sub.error.value).toBeUndefined();
  });

  test("_setSubmissionPending: pending を更新", () => {
    const sub = submission();
    _setSubmissionPending(true);
    expect(sub.pending.value).toBe(true);
    _setSubmissionPending(false);
    expect(sub.pending.value).toBe(false);
  });

  test("_setSubmissionResult: value セット + error 自動クリア", () => {
    const sub = submission();
    // 先に error を入れて、result セットで自動 clear されることを確認
    _setSubmissionError({ name: "Error", message: "boom" });
    expect(sub.error.value?.message).toBe("boom");

    _setSubmissionResult({ ok: true });
    expect(sub.value.value).toEqual({ ok: true });
    expect(sub.error.value).toBeUndefined();
  });

  test("_setSubmissionError: error セット + value 自動クリア", () => {
    const sub = submission();
    _setSubmissionResult({ ok: true });
    expect(sub.value.value).toEqual({ ok: true });

    _setSubmissionError({ name: "ValidationError", message: "title required" });
    expect(sub.error.value?.message).toBe("title required");
    expect(sub.value.value).toBeUndefined();
  });

  test("reset: 全 field 初期化", () => {
    const sub = submission();
    _setSubmissionResult({ ok: true });
    _setSubmissionPending(true);
    sub.reset();
    expect(sub.value.value).toBeUndefined();
    expect(sub.pending.value).toBe(false);
    expect(sub.error.value).toBeUndefined();
  });

  test("submission() は global state を共有する (R-min)", () => {
    const a = submission();
    const b = submission();
    _setSubmissionResult({ shared: true });
    // a / b 両方に同 result が見える (global state、R-min)
    expect(a.value.value).toEqual({ shared: true });
    expect(b.value.value).toEqual({ shared: true });
  });
});
