// @vitest-environment node
// ADR 0066 Phase 2-3: async function component (= server-only) の動作確認。
//
// Phase 2 では h() の component branch で Promise<Node> を返す type を判定し、
// VAsyncSlot を生成 + AsyncScope.registerPending する。Phase 1 で立てた
// renderToStringAsync の Promise.allSettled が AsyncScope.pending を待つので、
// 全完了後に server-renderer の serialize が VAsyncSlot.resolved を再帰展開する。
//
// Phase 3 では Suspense との組み合わせを追加で検証:
//   - renderToStringAsync 経由 (= stream context なし) では Suspense は children
//     を直接吐く → 内側 async component も普通に展開される
//   - renderToReadableStream 経由 (= stream context あり) では Suspense が
//     boundary 化、per-boundary AsyncScope (Phase 1 で merge 済) で内側 async
//     component の Promise を集めて、boundary chunk に markup を焼く
//
// reject 経路 (= async component が throw → ErrorBoundary fallback) は ADR 0066
// Phase 4 (= Q6 「ErrorBoundary が VAsyncSlot を fallback markup に mutation」)
// とセットで実装するため、本ファイルでは扱わない。dogfood (apps/blog) は Phase 5。

import { describe, expect, test } from "vite-plus/test";
import { h } from "../src/jsx";
import { Suspense } from "../src/suspense";
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

describe("async function component × Suspense (ADR 0066 Phase 3)", () => {
  test("renderToStringAsync 内 Suspense × async: children 直接吐き経路で markup に展開", async () => {
    async function Inner() {
      const data = await Promise.resolve("hello");
      return h("p", null, data);
    }
    // renderToStringAsync は stream context を立てないので、Suspense は
    // children を直接吐く既存経路 (= boundary 化しない)。内側 async component の
    // Promise は renderToStringAsync 直下の AsyncScope に register されるので、
    // 全 await 後に markup が完成する (= ADR 0066 論点 3 古典 SSR 動作)。
    const { html } = await renderToStringAsync(() =>
      Suspense({
        fallback: () => h("span", null, "loading"),
        children: () => h(Inner as never, null),
      }),
    );
    expect(html).toContain("<p>hello</p>");
    // Suspense の anchor `<!--suspense-->` が末尾に出る (ADR 0021 規約)
    expect(html).toContain("<!--suspense-->");
  });

  test("renderToStringAsync 内 Suspense × async: 兄弟 sync component と async component が混在", async () => {
    async function AsyncSibling() {
      const data = await Promise.resolve("from-async");
      return h("li", null, data);
    }
    function SyncSibling() {
      return h("li", null, "from-sync");
    }
    const { html } = await renderToStringAsync(() =>
      Suspense({
        fallback: () => h("span", null, "loading"),
        children: () => h("ul", null, h(SyncSibling, null), h(AsyncSibling as never, null)),
      }),
    );
    // sync sibling は JSX 評価即座、async sibling は AsyncScope.pending に
    // register された Promise が settle 後に VAsyncSlot.resolved 経由で展開される。
    // 両方が同じ ul の子として markup に焼かれる。
    expect(html).toContain("<ul><li>from-sync</li><li>from-async</li></ul>");
  });

  // ADR 0066 Phase 4 で扱う範囲 (= 本 Phase 3 では未着手):
  //   - renderToReadableStream の Suspense boundary 内 async component (= shell-pass の
  //     renderToString が finally で setRenderer(previous) するため、async continuation
  //     中に getRenderer() が serverRenderer から外れて h() が browserRenderer に届く
  //     構造的問題がある。Phase 4 で renderer を outer scope で setRenderer 保持する
  //     fix とセットで test を追加する)
  //   - reject 経路 (Q6 ErrorBoundary mutation 機構)
});
