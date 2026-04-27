// @vitest-environment node
// ADR 0031 Phase C-1+C-2 + ADR 0033 out-of-order full streaming + ADR 0034
// review fixes (window resources / shell error / cross-boundary key warn):
// renderToReadableStream の shell + per-boundary partial patch streaming SSR。
//   - boundary なし (Suspense 使わず、bootstrapKey 無し) は shell のみ (root
//     pseudo-boundary が空なら __vidroAddResources も emit しない)
//   - Suspense **外** で bootstrapKey 付き resource → root patch
//     (`__vidroAddResources(...)`) に resolved 値が乗る
//   - Suspense + bootstrapKey: shell に fallback + comment marker、tail に
//     boundary chunk (partial patch + <template> + __vidroFill script)、
//     内側 children は resolved 値で markup
//   - reject も SerializedError 形式で patch に乗る
//   - ADR 0034: shell-pass throw → controller.error → stream errored
//   - ADR 0034: cross-boundary 重複 bootstrapKey で console.warn
//   - ADR 0034: __vidroAddResources は window.__vidroResources object 経由 (DOM
//     textContent 書き換えではない)
//
// stream は ReadableStream<Uint8Array> なので、reader.read() で chunk を順に
// 取り出して連結 + decode して 1 つの string にして検証する。

import { describe, expect, test } from "vite-plus/test";
import { h, _$text, _$dynamicChild } from "../src/jsx";
import { resource } from "../src/resource";
import { Suspense } from "../src/suspense";
import {
  renderToReadableStream,
  VIDRO_STREAMING_RUNTIME,
  VIDRO_BOOT_TRIGGER,
} from "../src/render-to-string";

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

describe("renderToReadableStream", () => {
  test("Suspense なし、bootstrapKey 無し: shell のみ (root patch は emit しない)", async () => {
    const stream = renderToReadableStream(() => h("p", null, _$text("hello")));
    const html = await collect(stream);
    expect(html).toContain("<p>hello</p>");
    // root pseudo-boundary が空なので __vidroAddResources は emit しない (ADR 0033 論点 9)
    expect(html).not.toContain("__vidroAddResources");
    // boundary fill も無いので template / __vidroFill 呼び出しも出ない
    expect(html).not.toContain("vidro-tpl-");
    expect(html).not.toContain("__vidroFill(");
  });

  test("Suspense 外の bootstrapKey 付き resource: root partial patch に resolved 値が乗る", async () => {
    const stream = renderToReadableStream(() => {
      const r = resource(() => Promise.resolve({ name: "Asahi" }), {
        bootstrapKey: "user:1",
      });
      // Suspense なしで使うと shell-pass で loading=true 表示、root scope で
      // 集めた fetcher が __vidroAddResources patch に乗る (caller が patch 後に
      // hydrate して bootstrap-hit で blink 解消する前提)
      return h(
        "p",
        null,
        _$dynamicChild(() => (r.value as { name: string } | undefined)?.name ?? "loading"),
      );
    });
    const html = await collect(stream);
    expect(html).toContain("<p>loading</p>");
    expect(html).toContain('__vidroAddResources({"user:1":{"data":{"name":"Asahi"}}})');
  });

  test("reject は SerializedError 形式で root patch に乗る", async () => {
    const stream = renderToReadableStream(() => {
      resource(() => Promise.reject(new Error("boom")), { bootstrapKey: "broken" });
      return h("p", null, _$text("shell"));
    });
    const html = await collect(stream);
    expect(html).toContain("<p>shell</p>");
    expect(html).toMatch(
      /__vidroAddResources\(\{"broken":\{"error":\{"name":"Error","message":"boom"/,
    );
  });

  test("Suspense + bootstrapKey: shell に fallback + marker、boundary chunk に partial patch + template + fill", async () => {
    const stream = renderToReadableStream(() =>
      Suspense({
        fallback: () => h("p", { id: "fb" }, _$text("loading...")),
        children: () => {
          const r = resource(() => Promise.resolve("hi"), { bootstrapKey: "x" });
          return h(
            "p",
            { id: "ok" },
            _$dynamicChild(() => r.value ?? ""),
          );
        },
      }),
    );
    const html = await collect(stream);

    // shell: fallback + comment marker pair + suspense anchor
    expect(html).toContain('<!--vb-vb0-start--><p id="fb">loading...</p><!--vb-vb0-end-->');
    expect(html).toContain("<!--suspense-->");

    // boundary chunk: partial patch + template + fill (1 chunk にまとまっている)
    expect(html).toContain(
      '<script>__vidroAddResources({"x":{"data":"hi"}})</script>' +
        '<template id="vidro-tpl-vb0"><p id="ok">hi</p></template>' +
        '<script>__vidroFill("vb0")</script>',
    );

    // 順序: shell → boundary chunk (出現順)
    const shellIdx = html.indexOf("<!--vb-vb0-start-->");
    const patchIdx = html.indexOf("__vidroAddResources");
    const fillIdx = html.indexOf("__vidroFill");
    expect(shellIdx).toBeLessThan(patchIdx);
    expect(patchIdx).toBeLessThan(fillIdx);

    // root scope は空なので root partial patch は出ない (= __vidroAddResources は 1 回だけ)
    expect(html.match(/__vidroAddResources/g)?.length).toBe(1);

    // ADR 0036: boot trigger は shell 直後 (= boundary chunks より前) に出る。
    // VIDRO_BOOT_TRIGGER 全体の出現位置を見る (内部文字列 "__vidroBoot" の代用は
    // trigger 内容の rename に弱いので避ける)。
    const bootTriggerIdx = html.indexOf(VIDRO_BOOT_TRIGGER);
    expect(bootTriggerIdx).toBeGreaterThanOrEqual(0);
    const boundaryStartIdx = html.indexOf("<!--vb-vb0-start-->");
    expect(boundaryStartIdx).toBeLessThan(bootTriggerIdx);
    expect(bootTriggerIdx).toBeLessThan(fillIdx);
  });

  test("out-of-order: 速い boundary が遅い boundary より先に emit される (ADR 0033)", async () => {
    // Suspense 2 つ。slow が ~30ms 遅延、fast は即時 resolve。emit 順は
    // fast → slow になることを assert (= 旧 shell+tail なら slow に律速される)。
    const stream = renderToReadableStream(() =>
      h(
        "div",
        null,
        // vb0: slow (~30ms)
        Suspense({
          fallback: () => h("p", { id: "sf" }, _$text("slow-fb")),
          children: () => {
            const r = resource(
              () => new Promise<string>((res) => setTimeout(() => res("slow-data"), 30)),
              { bootstrapKey: "slow" },
            );
            return h(
              "p",
              { id: "so" },
              _$dynamicChild(() => r.value ?? ""),
            );
          },
        }),
        // vb1: fast (即時 resolve)
        Suspense({
          fallback: () => h("p", { id: "ff" }, _$text("fast-fb")),
          children: () => {
            const r = resource(() => Promise.resolve("fast-data"), { bootstrapKey: "fast" });
            return h(
              "p",
              { id: "fo" },
              _$dynamicChild(() => r.value ?? ""),
            );
          },
        }),
      ),
    );
    const html = await collect(stream);

    const slowFillIdx = html.indexOf('__vidroFill("vb0")');
    const fastFillIdx = html.indexOf('__vidroFill("vb1")');
    expect(slowFillIdx).toBeGreaterThanOrEqual(0);
    expect(fastFillIdx).toBeGreaterThanOrEqual(0);
    // out-of-order: vb1 (fast) が vb0 (slow) より先に emit される
    expect(fastFillIdx).toBeLessThan(slowFillIdx);
  });

  test("ADR 0036: VIDRO_BOOT_TRIGGER は registry idiom (__vidroBoot 即発火 or pending flag)", () => {
    // bundle が先着 → __vidroBoot を即呼ぶ、未着 → __vidroBootPending=true で flag。
    // 短い classic <script> (type="module" 不可: 即時実行が必要)。
    expect(VIDRO_BOOT_TRIGGER).toContain("__vidroBoot");
    expect(VIDRO_BOOT_TRIGGER).toContain("__vidroBootPending");
    expect(VIDRO_BOOT_TRIGGER.startsWith("<script>")).toBe(true);
    expect(VIDRO_BOOT_TRIGGER.endsWith("</script>")).toBe(true);
    // module ではなく classic script (= 即時実行、type 属性なし)
    expect(VIDRO_BOOT_TRIGGER).not.toContain('type="module"');
  });

  test("ADR 0036: boundary 無し (shell のみ) でも boot trigger は emit される", async () => {
    const stream = renderToReadableStream(() => h("p", null, _$text("hello")));
    const html = await collect(stream);
    expect(html).toContain("<p>hello</p>");
    expect(html).toContain("__vidroBoot");
    // shell より後ろ
    const shellIdx = html.indexOf("<p>hello</p>");
    const bootIdx = html.indexOf("__vidroBoot");
    expect(shellIdx).toBeLessThan(bootIdx);
  });

  test("VIDRO_STREAMING_RUNTIME に __vidroFill / __vidroAddResources の定義が含まれる", () => {
    expect(VIDRO_STREAMING_RUNTIME).toContain("__vidroFill");
    expect(VIDRO_STREAMING_RUNTIME).toContain("__vidroAddResources");
    // ADR 0033 で rename した旧名は残っていない
    expect(VIDRO_STREAMING_RUNTIME).not.toContain("__vidroSetResources");
    // ADR 0034: window.__vidroResources object 経由 (DOM textContent 書き換えなし)
    expect(VIDRO_STREAMING_RUNTIME).toContain("window.__vidroResources");
    // 旧実装の getElementById("__vidro_data") 経路は残っていない (__vidroAddResources 内)
    // __vidroFill は別途 getElementById を使うので、__vidro_data 文字列だけで判定
    expect(VIDRO_STREAMING_RUNTIME).not.toContain('getElementById("__vidro_data")');
    // ADR 0035: 段階 hydration の registry / 後着 fill 経由 trigger
    expect(VIDRO_STREAMING_RUNTIME).toContain("__vidroPendingHydrate");
    // ADR 0035 (B-α): __vidroFill は start/end marker を **remove しない** (boundary
    // 単位 hydrate target の境界として保持)。runtime body 内に
    // `s.parentNode.removeChild(s)` / `e.parentNode.removeChild(e)` が無い。
    expect(VIDRO_STREAMING_RUNTIME).not.toContain("removeChild(s)");
    expect(VIDRO_STREAMING_RUNTIME).not.toContain("removeChild(e)");
  });

  test("ADR 0034 Issue 2: shell-pass throw は controller.error → stream errored になる", async () => {
    const stream = renderToReadableStream(() => {
      throw new Error("shell boom");
    });
    const reader = stream.getReader();
    // start() の reject = stream.error なので reader.read() が reject する
    await expect(reader.read()).rejects.toThrow("shell boom");
  });

  test("ADR 0034 Issue 3: cross-boundary 重複 bootstrapKey で console.warn", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const stream = renderToReadableStream(() =>
        h(
          "div",
          null,
          // boundary A: bootstrapKey "shared"
          Suspense({
            fallback: () => h("p", null, _$text("a-fb")),
            children: () => {
              const r = resource(() => Promise.resolve("a"), { bootstrapKey: "shared" });
              return h(
                "p",
                null,
                _$dynamicChild(() => r.value ?? ""),
              );
            },
          }),
          // boundary B: 同じ bootstrapKey "shared" → cross-boundary 重複
          Suspense({
            fallback: () => h("p", null, _$text("b-fb")),
            children: () => {
              const r = resource(() => Promise.resolve("b"), { bootstrapKey: "shared" });
              return h(
                "p",
                null,
                _$dynamicChild(() => r.value ?? ""),
              );
            },
          }),
        ),
      );
      await collect(stream);
    } finally {
      console.warn = origWarn;
    }
    const dup = warnings.filter((w) => w.includes('duplicate bootstrapKey "shared"'));
    expect(dup.length).toBeGreaterThanOrEqual(1);
    expect(dup[0]).toContain("across Suspense boundaries");
  });
});
