// @vitest-environment jsdom
import { describe, expect, test } from "vite-plus/test";
import { mount, h } from "../src/jsx";
import { ref } from "../src/ref";

describe("Ref", () => {
  describe("生成", () => {
    test("ref() は .current が null の Ref を返す", () => {
      const r = ref<HTMLInputElement>();
      expect(r.current).toBeNull();
    });
  });

  describe("JSX 経由で要素を受け取る", () => {
    test("<input ref={myRef} /> で .current に要素が入る", () => {
      const target = document.createElement("div");
      const myRef = ref<HTMLInputElement>();
      mount(() => h("input", { ref: myRef }), target);
      expect(myRef.current).toBeInstanceOf(HTMLInputElement);
      expect(myRef.current?.tagName).toBe("INPUT");
    });

    test("ref 属性は attribute として setAttribute されない", () => {
      const target = document.createElement("div");
      const myRef = ref<HTMLInputElement>();
      mount(() => h("input", { ref: myRef }), target);
      // ref は特別扱いなので DOM 属性には出ない
      expect(myRef.current?.hasAttribute("ref")).toBe(false);
    });

    test("ref 以外の props (class / onClick) と共存できる", () => {
      const target = document.createElement("div");
      const myRef = ref<HTMLButtonElement>();
      const clicks: number[] = [];
      mount(
        () =>
          h("button", {
            ref: myRef,
            class: "btn",
            onClick: () => clicks.push(1),
          }),
        target,
      );
      expect(myRef.current?.className).toBe("btn");
      myRef.current?.click();
      expect(clicks).toEqual([1]);
    });
  });

  describe("エラー耐性", () => {
    test("ref に Ref 以外の値 (string) を渡すと無視される (属性化されない)", () => {
      const target = document.createElement("div");
      mount(() => h("input", { ref: "not-a-ref" }), target);
      // 何もクラッシュしない、ref 属性は attribute として残らない
      const input = target.querySelector("input");
      expect(input?.hasAttribute("ref")).toBe(false);
    });

    test("ref に null を渡しても crash しない", () => {
      const target = document.createElement("div");
      expect(() => {
        mount(() => h("input", { ref: null }), target);
      }).not.toThrow();
    });
  });
});
