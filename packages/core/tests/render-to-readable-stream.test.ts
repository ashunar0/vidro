// @vitest-environment node
// ADR 0031 Phase C-1+C-2 + ADR 0033 out-of-order full streaming:
// renderToReadableStream の shell + per-boundary partial patch streaming SSR。
//   - boundary なし (Suspense 使わず、bootstrapKey 無し) は shell のみ (root
//     pseudo-boundary が空なら __vidroAddResources も emit しない)
//   - Suspense **外** で bootstrapKey 付き resource → root patch
//     (`__vidroAddResources(...)`) に resolved 値が乗る
//   - Suspense + bootstrapKey: shell に fallback + comment marker、tail に
//     boundary chunk (partial patch + <template> + __vidroFill script)、
//     内側 children は resolved 値で markup
//   - reject も SerializedError 形式で patch に乗る
//
// stream は ReadableStream<Uint8Array> なので、reader.read() で chunk を順に
// 取り出して連結 + decode して 1 つの string にして検証する。

import { describe, expect, test } from "vite-plus/test";
import { h, _$text, _$dynamicChild } from "../src/jsx";
import { resource } from "../src/resource";
import { Suspense } from "../src/suspense";
import { renderToReadableStream, VIDRO_STREAMING_RUNTIME } from "../src/render-to-string";

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

  test("VIDRO_STREAMING_RUNTIME に __vidroFill / __vidroAddResources の定義が含まれる", () => {
    expect(VIDRO_STREAMING_RUNTIME).toContain("__vidroFill");
    expect(VIDRO_STREAMING_RUNTIME).toContain("__vidroAddResources");
    // ADR 0033 で rename した旧名は残っていない
    expect(VIDRO_STREAMING_RUNTIME).not.toContain("__vidroSetResources");
  });
});
