// @vitest-environment jsdom
// ADR 0069: formControl primitive の振る舞い test。zod を直依存しないため、
// `safeParse` を持つ duck-type schema を test 内で手書きする (= schema lib agnostic
// の確認も兼ねる)。
import { describe, expect, test } from "vite-plus/test";
import { formControl, type ParseSchema } from "../src";

type FormShape = { title: string; body: string };

/** zod 互換の duck-type schema mock。non-empty string を要求する単純 validator。 */
function makeSchema(): ParseSchema<FormShape> {
  return {
    safeParse(input: unknown) {
      if (typeof input !== "object" || input === null) {
        return {
          success: false,
          error: { issues: [{ path: [], message: "expected object" }] },
        };
      }
      const obj = input as Record<string, unknown>;
      const issues: Array<{ path: ReadonlyArray<string | number>; message: string }> = [];
      const title = typeof obj["title"] === "string" ? obj["title"] : "";
      const body = typeof obj["body"] === "string" ? obj["body"] : "";
      if (!title) issues.push({ path: ["title"], message: "Title is required" });
      if (!body) issues.push({ path: ["body"], message: "Body is required" });
      if (issues.length > 0) return { success: false, error: { issues } };
      return { success: true, data: { title, body } };
    },
  };
}

/** Event を伴わずに input.onInput を起動する小道具。currentTarget を input element に偽装。 */
function fireInput(handler: (event: Event) => void, value: string) {
  const target = { value } as unknown as HTMLInputElement;
  const event = { currentTarget: target } as unknown as Event;
  handler(event);
}

/** SubmitEvent を伴わずに onSubmit を起動する。preventDefault は呼ばれた回数を記録。 */
function fireSubmit(handler: (event: SubmitEvent) => void): { prevented: boolean } {
  let prevented = false;
  const event = {
    preventDefault: () => {
      prevented = true;
    },
  } as unknown as SubmitEvent;
  handler(event);
  return { prevented };
}

describe("formControl — ADR 0069", () => {
  test("schema pass: bind の handler が parsed data を受け取る、pending true → false", async () => {
    const f = formControl({ schema: makeSchema() });

    // 値を入れる
    fireInput(f.field("title").onInput, "Hello");
    fireInput(f.field("body").onInput, "World");

    let called: FormShape | null = null;
    let resolveSubmit: (() => void) | null = null;
    const submitDone = new Promise<void>((res) => (resolveSubmit = res));
    const handler = f.bind(async (data) => {
      called = data;
      await submitDone;
    });

    fireSubmit(handler);
    // 同期 part 終了直後: pending true、user fn は呼び出し済み
    expect(called).toEqual({ title: "Hello", body: "World" });
    expect(f.pending.value).toBe(true);

    // user fn 完了後: pending false (= microtask 待ち)
    resolveSubmit!();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.pending.value).toBe(false);
  });

  test("schema fail: bind の handler は呼ばれない、per-field error signal が更新される", () => {
    const f = formControl({ schema: makeSchema() });

    let called = false;
    const handler = f.bind(() => {
      called = true;
    });

    const result = fireSubmit(handler);
    expect(result.prevented).toBe(true);
    expect(called).toBe(false);
    expect(f.error("title").value).toBe("Title is required");
    expect(f.error("body").value).toBe("Body is required");
    expect(f.pending.value).toBe(false);
  });

  test("blur: 該当 field のみ validate される、他 field の error は触らない", () => {
    const f = formControl({ schema: makeSchema() });

    // title blur 単独 → title error 出る、body はまだ undefined (= 未 validate)
    f.field("title").onBlur();
    expect(f.error("title").value).toBe("Title is required");
    expect(f.error("body").value).toBeUndefined();

    // body blur → body だけ追加で error
    f.field("body").onBlur();
    expect(f.error("body").value).toBe("Body is required");
  });

  test("once-errored becomes reactive: error 表示中の field は input でも revalidate", () => {
    const f = formControl({ schema: makeSchema() });

    // blur で title に error
    f.field("title").onBlur();
    expect(f.error("title").value).toBe("Title is required");

    // input で値を入れる → revalidate されて error 解消
    fireInput(f.field("title").onInput, "Filled");
    expect(f.error("title").value).toBeUndefined();
  });

  test("error 表示前の field は input で revalidate されない (= 過剰表示しない)", () => {
    const f = formControl({ schema: makeSchema() });

    // blur 前 (error なし状態) で空文字を input → error 出ない
    fireInput(f.field("title").onInput, "");
    expect(f.error("title").value).toBeUndefined();
  });

  test("setFieldErrors: server 戻り 422 の fields を error signal に流す", () => {
    const f = formControl({ schema: makeSchema() });

    f.setFieldErrors({ title: "already taken" });
    expect(f.error("title").value).toBe("already taken");
    expect(f.error("body").value).toBeUndefined();
  });

  test("reset: 全 field 値 + error + pending クリア", () => {
    const f = formControl({ schema: makeSchema() });

    fireInput(f.field("title").onInput, "Filled");
    f.field("title").onBlur();
    f.setFieldErrors({ body: "required" });

    f.reset();

    expect(f.field("title").value()).toBe("");
    expect(f.error("title").value).toBeUndefined();
    expect(f.error("body").value).toBeUndefined();
    expect(f.pending.value).toBe(false);
  });

  test("pending 中の double submit は no-op (= 二重 submit 防止)", () => {
    const f = formControl({ schema: makeSchema() });
    fireInput(f.field("title").onInput, "T");
    fireInput(f.field("body").onInput, "B");

    let callCount = 0;
    const handler = f.bind(() => {
      callCount += 1;
      // 完了させない (Promise resolve しない) → pending true のまま
      return new Promise<void>(() => {});
    });

    fireSubmit(handler);
    fireSubmit(handler);
    fireSubmit(handler);

    expect(callCount).toBe(1);
    expect(f.pending.value).toBe(true);
  });

  test("field('title').value() は signal の現在値を返す (= controlled)", () => {
    const f = formControl({ schema: makeSchema() });

    expect(f.field("title").value()).toBe("");
    fireInput(f.field("title").onInput, "Filled");
    expect(f.field("title").value()).toBe("Filled");
  });
});
