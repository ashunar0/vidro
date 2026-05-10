// @vitest-environment jsdom
// ADR 0069: formControl primitive の振る舞い test。zod を直依存しないため、
// `safeParse` を持つ duck-type schema を test 内で手書きする (= schema lib agnostic
// の確認も兼ねる)。
import { describe, expect, test } from "vite-plus/test";
import { formControl, isServerFnValidationError, type ParseSchema } from "../src";

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
    const props = f.bind(async (data) => {
      called = data;
      await submitDone;
    });

    fireSubmit(props.onSubmit);
    // 同期 part 終了直後: pending true、user fn は呼び出し済み
    expect(called).toEqual({ title: "Hello", body: "World" });
    expect(f.pending.value).toBe(true);

    // user fn 完了後: pending false (= microtask 待ち)。ADR 0076 で .catch() が
    // chain に挟まり 1 周深くなったので、microtask を 3 周待つ。
    resolveSubmit!();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.pending.value).toBe(false);
  });

  test("schema fail: bind の handler は呼ばれない、per-field error signal が更新される", () => {
    const f = formControl({ schema: makeSchema() });

    let called = false;
    const props = f.bind(() => {
      called = true;
    });

    const result = fireSubmit(props.onSubmit);
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
    const props = f.bind(() => {
      callCount += 1;
      // 完了させない (Promise resolve しない) → pending true のまま
      return new Promise<void>(() => {});
    });

    fireSubmit(props.onSubmit);
    fireSubmit(props.onSubmit);
    fireSubmit(props.onSubmit);

    expect(callCount).toBe(1);
    expect(f.pending.value).toBe(true);
  });

  test("field('title').value() は signal の現在値を返す (= controlled)", () => {
    const f = formControl({ schema: makeSchema() });

    expect(f.field("title").value()).toBe("");
    fireInput(f.field("title").onInput, "Filled");
    expect(f.field("title").value()).toBe("Filled");
  });

  test("defaultValues: edit form の prefill が signal に seed される", () => {
    const f = formControl({
      schema: makeSchema(),
      defaultValues: { title: "Hello", body: "World" },
    });

    // prefill 値が field.value() で返る → spread 経由で SSR / hydrate で同じ値が DOM に乗る
    expect(f.field("title").value()).toBe("Hello");
    expect(f.field("body").value()).toBe("World");

    // 検証も初期 snapshot で通る → user 入力なしでも submit OK (= edit で title 変えず
    // body だけ変えるケースで「title 必須」error が出ない)
    let called: FormShape | null = null;
    const props = f.bind((data) => {
      called = data;
    });
    fireSubmit(props.onSubmit);
    expect(called).toEqual({ title: "Hello", body: "World" });
  });

  test("defaultValues: reset で seed 値に戻る (= 「変更を破棄」操作)", () => {
    const f = formControl({
      schema: makeSchema(),
      defaultValues: { title: "Hello", body: "World" },
    });

    fireInput(f.field("title").onInput, "Modified");
    expect(f.field("title").value()).toBe("Modified");

    f.reset();
    expect(f.field("title").value()).toBe("Hello");
    expect(f.field("body").value()).toBe("World");
  });

  // ADR 0078: defaultValues に渡す source data の型 D を generic で infer、
  // `(keyof D & keyof T) extends never` (= source に schema field が 1 個も
  // 存在しない) なら never を要求して build error 化する。typo 単独 / 全 field
  // rename を build 時に検出、`post` (= Post 型まるごと、第 12 周目規約) は
  // title/body overlap で素通り。partial rename (= 1 field だけ rename、もう
  // 1 field は match) は overlap が残るので検出限界 (= ADR 0078 §検出限界)。
  describe("ADR 0078: defaultValues source ⟷ schema field overlap", () => {
    test("post まるごと (= 第 12 周目規約) は overlap 成立で型 pass + 値 seed", () => {
      type Post = {
        id: string;
        slug: string;
        title: string;
        body: string;
        createdAt: number;
      };
      const post: Post = {
        id: "1",
        slug: "test",
        title: "Hello",
        body: "World",
        createdAt: 0,
      };
      // keyof Post & keyof FormShape = "title" | "body" → not never → D を返す
      const f = formControl({ schema: makeSchema(), defaultValues: post });
      expect(f.field("title").value()).toBe("Hello");
      expect(f.field("body").value()).toBe("World");
    });

    test("partial (= title だけ prefill) は overlap 成立で型 pass", () => {
      const f = formControl({
        schema: makeSchema(),
        defaultValues: { title: "Hello" },
      });
      expect(f.field("title").value()).toBe("Hello");
      // body は seed されないので空 (= signal 初期値)
      expect(f.field("body").value()).toBe("");
    });

    test("defaultValues 省略は型 pass (= D が default Partial<T> で固定、第 2 枝 overlap で素通り)", () => {
      const f = formControl({ schema: makeSchema() });
      expect(f.field("title").value()).toBe("");
      expect(f.field("body").value()).toBe("");
    });

    test("defaultValues 空 object {} は制約スキップで型 pass (= 第 1 枝 keyof D extends never)", () => {
      const f = formControl({ schema: makeSchema(), defaultValues: {} });
      expect(f.field("title").value()).toBe("");
    });

    test("typo 単独 (= 変数経由で source に schema field 0 個) は build error", () => {
      const opts = { titlee: "typo" };
      // @ts-expect-error ADR 0078: keyof {titlee} & keyof FormShape = never で
      // ValidDefaults が never を要求 → build error。変数経由 (= excess check 無し)
      // でも ADR 0078 制約で reject される、これが本 ADR の core 効用。
      formControl({ schema: makeSchema(), defaultValues: opts });
    });

    test("全 field rename 想定 (= 変数経由で schema 想定外 field のみ) は build error", () => {
      const opts: { headline: string; content: string } = {
        headline: "h",
        content: "c",
      };
      // @ts-expect-error ADR 0078: schema を title→headline + body→content と
      // 全 rename したのに source は旧 field のまま、というケースを build 時 catch
      formControl({ schema: makeSchema(), defaultValues: opts });
    });
  });

  // ADR 0075: bind 戻り値は form props object、spread で marker と onSubmit が同時注入される。
  // 旧形式 (= bind が event handler を返す) は廃止、user は `<form {...f.bind(fn)}>` の
  // 1 expression で router intercept escape も手に入れる。
  describe("ADR 0075: bind 戻り値は form props object", () => {
    test("bind 戻り値に onSubmit と data-vidro-no-intercept marker が含まれる", () => {
      const f = formControl({ schema: makeSchema() });
      const props = f.bind(() => {});

      // shape: object (= 旧 event handler 関数ではない)
      expect(typeof props).toBe("object");
      expect(typeof props.onSubmit).toBe("function");
      // router の global form interceptor (ADR 0051) escape marker、空文字列で OK
      // (= dataset 経由の判定は値ではなく key の存在を見る)
      expect(props["data-vidro-no-intercept"]).toBe("");
    });

    test("bind 戻り値の onSubmit は従来通り validate / pending を回す", () => {
      const f = formControl({ schema: makeSchema() });
      fireInput(f.field("title").onInput, "T");
      fireInput(f.field("body").onInput, "B");

      let called: FormShape | null = null;
      const props = f.bind((data) => {
        called = data;
      });
      const result = fireSubmit(props.onSubmit);

      expect(result.prevented).toBe(true);
      expect(called).toEqual({ title: "T", body: "B" });
    });
  });

  // ADR 0076: bind が `ServerFnValidationError` 形 (= name + fields shape) を duck-type で
  // 自動 catch、setFieldErrors に流す。user の handleSubmit から try/catch boilerplate が消える。
  // 判定は `@vidro/router/client` への peer dep を避けるため duck-type、cross-bundle で
  // instanceof が壊れる事象 (memory feedback_dev_restart_after_dist_change) も回避する。
  describe("ADR 0076: bind が ServerFnValidationError を自動 catch", () => {
    /**
     * `@vidro/router/client` の `ServerFnValidationError` を test 内で再現した mock。
     * formControl は import せず duck-type で判定するので、本 class は同 file に依存しない
     * (= cross-bundle で同じ name + shape なら判定が通ることの検証も兼ねる)。
     */
    class FakeServerFnValidationError extends Error {
      readonly fields: Record<string, string>;
      constructor(fields: Record<string, string>) {
        super("validation failed");
        this.name = "ServerFnValidationError";
        this.fields = fields;
      }
    }

    test("handler が ServerFnValidationError 形 throw → setFieldErrors が呼ばれる + pending false", async () => {
      const f = formControl({ schema: makeSchema() });
      fireInput(f.field("title").onInput, "T");
      fireInput(f.field("body").onInput, "B");

      const props = f.bind(() => {
        throw new FakeServerFnValidationError({ title: "already taken" });
      });
      fireSubmit(props.onSubmit);

      // catch / finally 解決待ち (= microtask 2 周)
      await Promise.resolve();
      await Promise.resolve();

      expect(f.error("title").value).toBe("already taken");
      expect(f.error("body").value).toBeUndefined();
      expect(f.pending.value).toBe(false);
    });

    test("handler が ServerFnValidationError 形 reject → setFieldErrors 経路で消化", async () => {
      const f = formControl({ schema: makeSchema() });
      fireInput(f.field("title").onInput, "T");
      fireInput(f.field("body").onInput, "B");

      const props = f.bind(async () => {
        throw new FakeServerFnValidationError({ body: "too short" });
      });
      fireSubmit(props.onSubmit);

      // async handler の microtask 連鎖を捌く
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(f.error("body").value).toBe("too short");
      expect(f.pending.value).toBe(false);
    });

    // bubble up 経路 (= 非 ServerFnValidationError throw 時に setFieldErrors に
    // 流さず再 throw する) の behavior verify は、`isServerFnValidationError` helper
    // の直接 unit test で代替する。bind 内部の Promise chain が rethrow した結果は
    // unhandled rejection として vitest reporter に拾われ、test 環境を汚すため。
    // 機構契約 (= 「name + fields shape を持つ error だけ catch」) は本 helper の
    // 振る舞いそのものなので、helper を直接 verify すれば十分。
    describe("isServerFnValidationError: duck-type 判定", () => {
      test("name + fields shape が揃った Error で true", () => {
        class FakeServerFnValidationError extends Error {
          readonly fields: Record<string, string>;
          constructor(fields: Record<string, string>) {
            super("validation failed");
            this.name = "ServerFnValidationError";
            this.fields = fields;
          }
        }
        const err = new FakeServerFnValidationError({ title: "x" });
        expect(isServerFnValidationError(err)).toBe(true);
      });

      test("name が違う Error で false (= 通常の Error は素通り)", () => {
        const err = new Error("network down");
        expect(isServerFnValidationError(err)).toBe(false);
      });

      test("name は ServerFnValidationError だが fields を持たない場合 false", () => {
        const err = new Error("not really validation");
        err.name = "ServerFnValidationError";
        expect(isServerFnValidationError(err)).toBe(false);
      });

      test("fields があっても Error subclass でない plain object は false", () => {
        const fake = { name: "ServerFnValidationError", fields: { title: "x" } };
        expect(isServerFnValidationError(fake)).toBe(false);
      });

      test("null / undefined / 文字列等の primitive は false", () => {
        expect(isServerFnValidationError(null)).toBe(false);
        expect(isServerFnValidationError(undefined)).toBe(false);
        expect(isServerFnValidationError("ServerFnValidationError")).toBe(false);
      });
    });
  });
});
