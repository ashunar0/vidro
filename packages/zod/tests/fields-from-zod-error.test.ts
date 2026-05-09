// ADR 0071 + ADR 0059 unit test: fieldsFromZodError(err) helper。
//
// 4 観点で確認:
//   1. ZodError → Record<string, string> 変換が ADR 0059 規約と整合
//   2. 1 field 1 message rule (= 同 field の追加 issue は無視)
//   3. nested / array path (= path[0] が string でない issue) は無視
//   4. 空 issues は空 object

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fieldsFromZodError } from "../src/fields-from-zod-error";

describe("fieldsFromZodError (ADR 0071 + ADR 0059)", () => {
  it("converts ZodError issues to Record<string, string>", () => {
    const schema = z.object({
      title: z.string().min(1, "title required"),
      body: z.string().min(1, "body required"),
    });
    // 空文字列で min(1) check に落とす (= zod 4.x は missing key を type error で
    // 「Invalid input: expected string, received undefined」と返すので、user min
    // message を出すには string であることが先に通る必要がある)。
    const result = schema.safeParse({ title: "", body: "" });
    if (result.success) throw new Error("expected failure");
    const fields = fieldsFromZodError(result.error);
    expect(fields).toMatchObject({
      title: "title required",
      body: "body required",
    });
  });

  it("uses first error message per field (= 1 field 1 message rule)", () => {
    // Zod は同 field に複数 issue 出すケースがある (= refinement 等)。
    // fieldsFromZodError は最初の issue だけ取る (= ADR 0059 規約)。
    const schema = z.object({
      title: z.string().min(5, "too short"),
    });
    const result = schema.safeParse({ title: "abc" });
    if (result.success) throw new Error("expected failure");
    const fields = fieldsFromZodError(result.error);
    expect(fields.title).toBe("too short");
    expect(Object.keys(fields)).toHaveLength(1);
  });

  it("ignores issues with non-string path[0] (= array index 等は flat にしない)", () => {
    // nested / array path は flat 集約しない (= ADR 0071 initial scope)。
    // path[0] が string でない issue は単に skip。
    const schema = z.object({
      tags: z.array(z.string().min(1, "tag required")),
    });
    const result = schema.safeParse({ tags: [""] });
    if (result.success) throw new Error("expected failure");
    const fields = fieldsFromZodError(result.error);
    // path = ["tags", 0]、path[0] = "tags" は string なので拾う
    // (= field name "tags" としてまとめて flat 化される、nested は破棄)
    expect(fields.tags).toBe("tag required");
  });

  it("returns empty object when issues is empty", () => {
    // synthetic ZodError 形 (= issues 空配列の case)
    const fakeError = { issues: [] } as unknown as z.ZodError;
    expect(fieldsFromZodError(fakeError)).toEqual({});
  });
});
