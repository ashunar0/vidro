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

import { describe, expect, test, vi } from "vite-plus/test";
import { h } from "../src/jsx";
import { Suspense } from "../src/suspense";
import { ErrorBoundary } from "../src/error-boundary";
import { renderToReadableStream, renderToStringAsync } from "../src/render-to-string";

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) out += dec.decode(value, { stream: true });
  }
  out += dec.decode();
  return out;
}

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

  // reject 経路 (Q6 ErrorBoundary mutation 機構) は Phase 4-B で扱う。
});

describe("async function component × streaming SSR (ADR 0066 Phase 4-A)", () => {
  test("renderToReadableStream の Suspense boundary 内 async: boundary chunk に markup が焼かれる", async () => {
    async function Inner() {
      const data = await Promise.resolve("streamed");
      return h("p", { id: "ok" }, data);
    }
    // Phase 4-A renderer 保持 fix で、shell-pass 後の async continuation 中も
    // getRenderer() が serverRenderer のまま → Inner 内 h() が VElement を作る →
    // VAsyncSlot.resolved に書き込まれる → flushBoundary の serialize で展開される。
    const stream = renderToReadableStream(() =>
      Suspense({
        fallback: () => h("p", { id: "fb" }, "loading..."),
        children: () => h(Inner as never, null),
      }),
    );
    const html = await collect(stream);
    // shell には fallback markup が乗る (boundary marker pair も)
    expect(html).toContain('id="fb"');
    expect(html).toContain("<!--vb-vb0-start-->");
    expect(html).toContain("<!--vb-vb0-end-->");
    // boundary chunk の template 内に async component の resolved markup が焼かれる
    expect(html).toMatch(/<template id="vidro-tpl-vb0"><p id="ok">streamed<\/p><\/template>/);
    expect(html).toContain('__vidroFill("vb0")');
  });

  test("renderToReadableStream の Suspense 外側 async: shell-pass で同期 evaluate されるので throw する", async () => {
    async function Outer() {
      return h("section", null, "from-async");
    }
    // shell-pass の renderToString は同期完了 → VAsyncSlot.resolved がまだ null の
    // まま serialize に到達 → Q3 確定形 always throw が発火。これは fail-fast の
    // 期待動作で、user に「Suspense で囲むか resource() を使うか」を促す形になる
    // (= memory project_design_north_star の RSC simpler 代替の制約: shell-pass で
    // 同期に await できない async は Suspense 必須)。
    let threw = false;
    try {
      const stream = renderToReadableStream(() => h(Outer as never, null));
      await collect(stream);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("async function component × ErrorBoundary (ADR 0066 Phase 4-B / Q6)", () => {
  test("async component が reject → ErrorBoundary が fallback markup に切り替える", async () => {
    async function Broken() {
      // 簡略化のため await の前で throw (= sync throw 等価ではなく、Promise が
      // reject に転化する経路)
      await Promise.resolve();
      throw new Error("boom");
    }
    const onError = vi.fn();
    const { html } = await renderToStringAsync(() =>
      ErrorBoundary({
        children: () => h(Broken as never, null),
        fallback: (err) => h("p", null, "caught: ", (err as Error).message),
        onError,
      }),
    );
    // Broken の Promise が reject → jsx.ts h() の then-handler で
    // componentOwner.handleError(err) → ErrorBoundary の childrenOwner で setErrorHandler
    // が起動 → fragment.children[0] が fallback Node に mutation で書き換わる。
    expect(html).toContain("<p>caught: boom</p>");
    expect(html).toContain("<!--error-boundary-->");
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect((onError.mock.calls[0]![0] as Error).message).toBe("boom");
  });

  test("sync component の throw も既存通り ErrorBoundary が catch する (regression check)", async () => {
    function Broken(): Node {
      throw new Error("sync-boom");
    }
    const onError = vi.fn();
    const { html } = await renderToStringAsync(() =>
      ErrorBoundary({
        children: () => h(Broken, null),
        fallback: (err) => h("p", null, "sync caught: ", (err as Error).message),
        onError,
      }),
    );
    // Phase 4-B 拡張で sync throw 路も childrenOwner.runCatching → setErrorHandler の
    // 経路に乗る。fragment.children に直接 push される (= 既存 try/catch path 等価)。
    expect(html).toContain("<p>sync caught: sync-boom</p>");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("ErrorBoundary なしで async reject → renderToStringAsync 自体が throw (unhandled)", async () => {
    async function Broken() {
      await Promise.resolve();
      throw new Error("unhandled");
    }
    // ErrorBoundary なし → owner chain の root に handler 無し → handleError が
    // 再 throw → Promise の then-handler 内で throw → settled が rejected →
    // allSettled は reject も settled として扱うので renderToStringAsync の await は
    // 抜ける → ただし VAsyncSlot.resolved が null のまま serialize に到達 → Q3
    // always throw が発火。
    let caught: unknown = null;
    try {
      await renderToStringAsync(() => h(Broken as never, null));
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    // Q3 always throw のメッセージ (= "VAsyncSlot serialized before resolve")
    expect((caught as Error).message).toContain("VAsyncSlot serialized before resolve");
  });
});
