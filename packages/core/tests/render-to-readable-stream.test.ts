// @vitest-environment node
// ADR 0031 Phase C-1+C-2: renderToReadableStream の shell + tail streaming SSR。
//   - boundary なし (Suspense 使わず) は shell + 空 resources patch のみ
//   - bootstrapKey 付き resource → resources patch に resolved 値が乗る
//   - Suspense + bootstrapKey: shell に fallback + comment marker、tail に
//     <template> + __vidroFill script、内側 children は resolved 値で markup
//   - reject も SerializedError 形式で resources に乗る
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
  test("Suspense なし: shell + 空 resources patch のみ", async () => {
    const stream = renderToReadableStream(() => h("p", null, _$text("hello")));
    const html = await collect(stream);
    expect(html).toContain("<p>hello</p>");
    expect(html).toContain("__vidroSetResources({})");
    // boundary fill は無いので template / __vidroFill 呼び出しは出ない
    expect(html).not.toContain("vidro-tpl-");
    expect(html).not.toContain("__vidroFill(");
  });

  test("bootstrapKey 付き resource: resources patch に resolved 値が乗る", async () => {
    const stream = renderToReadableStream(() => {
      const r = resource(() => Promise.resolve({ name: "Asahi" }), {
        bootstrapKey: "user:1",
      });
      // Suspense なしで使うと shell-pass で loading=true 表示、resources patch
      // には resolved 値が乗る (caller が patch 後に hydrate して fetch に流す前提)
      return h(
        "p",
        null,
        _$dynamicChild(() => (r.value as { name: string } | undefined)?.name ?? "loading"),
      );
    });
    const html = await collect(stream);
    expect(html).toContain("<p>loading</p>");
    expect(html).toContain('__vidroSetResources({"user:1":{"data":{"name":"Asahi"}}})');
  });

  test("reject は SerializedError 形式で resources patch に乗る", async () => {
    const stream = renderToReadableStream(() => {
      resource(() => Promise.reject(new Error("boom")), { bootstrapKey: "broken" });
      return h("p", null, _$text("shell"));
    });
    const html = await collect(stream);
    expect(html).toContain("<p>shell</p>");
    expect(html).toMatch(
      /__vidroSetResources\(\{"broken":\{"error":\{"name":"Error","message":"boom"/,
    );
  });

  test("Suspense + bootstrapKey: shell に fallback + marker、tail に template + fill", async () => {
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

    // tail: template に resolved children + __vidroFill 呼び出し
    expect(html).toContain('<template id="vidro-tpl-vb0"><p id="ok">hi</p></template>');
    expect(html).toContain('<script>__vidroFill("vb0")</script>');

    // resources patch
    expect(html).toContain('__vidroSetResources({"x":{"data":"hi"}})');

    // 順序: shell → resources patch → boundary fill (boundary fill は patch より後)
    const shellIdx = html.indexOf("<!--vb-vb0-start-->");
    const patchIdx = html.indexOf("__vidroSetResources");
    const fillIdx = html.indexOf("__vidroFill");
    expect(shellIdx).toBeLessThan(patchIdx);
    expect(patchIdx).toBeLessThan(fillIdx);
  });

  test("VIDRO_STREAMING_RUNTIME に __vidroFill / __vidroSetResources の定義が含まれる", () => {
    expect(VIDRO_STREAMING_RUNTIME).toContain("__vidroFill");
    expect(VIDRO_STREAMING_RUNTIME).toContain("__vidroSetResources");
  });
});
