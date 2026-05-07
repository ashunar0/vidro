// @vitest-environment node
// ADR 0066 Phase 2: async function component (= server-only) の最低限の動作確認。
//
// Phase 2 では h() の component branch で Promise<Node> を返す type を判定し、
// VAsyncSlot を生成 + AsyncScope.registerPending する。Phase 1 で立てた
// renderToStringAsync の Promise.allSettled が AsyncScope.pending を待つので、
// 全完了後に server-renderer の serialize が VAsyncSlot.resolved を再帰展開する。
//
// 詳細 test (sync/error/nested、Suspense との組み合わせ、islands) は ADR 0066
// Phase 3-5 で追加していく。本ファイルは Phase 2 が dead code でないことを示す
// minimal smoke test。

import { describe, expect, test } from "vite-plus/test";
import { h } from "../src/jsx";
import { renderToStringAsync } from "../src/render-to-string";

describe("async function component (ADR 0066 Phase 2)", () => {
  test("sync resolve: async component が await 後の VNode を markup に展開する", async () => {
    async function Greeting() {
      const name = await Promise.resolve("world");
      return h("p", null, "hello ", name);
    }
    const { html } = await renderToStringAsync(() => h(Greeting as never, null));
    expect(html).toBe("<p>hello world</p>");
  });

  test("nested async component: 直列 await chain で動く", async () => {
    async function Inner({ data }: { data: string }) {
      const more = await Promise.resolve(`${data}!`);
      return h("span", null, more);
    }
    async function Outer() {
      const data = await Promise.resolve("hi");
      return h(Inner as never, { data });
    }
    const { html } = await renderToStringAsync(() => h(Outer as never, null));
    expect(html).toBe("<span>hi!</span>");
  });
});
