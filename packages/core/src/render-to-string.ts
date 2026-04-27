// renderToString(fn): string — JSX を server renderer で評価して HTML string に焼く。
// ADR 0016 Step B-2a で導入。
//
// 流れ:
//   1. 現 renderer を退避 → serverRenderer に差し替え
//   2. 独立した root Owner を立て、runWithMountScope で fn を評価
//   3. 評価中に作られる effect は isServer 分岐で body 1 回実行 + 即 dispose
//   4. onMount は queue に積まれるが flushMountQueue を呼ばないので走らない
//   5. 結果の VNode tree を serialize → HTML string
//   6. owner.dispose で evaluate 中に残ったリソースを解放、renderer を defensive reset
//
// renderToStringAsync(fn): Promise<{html, resources}> — ADR 0030 Step B-5c で追加。
// `bootstrapKey` 付き createResource を server で resolve してから markup を作る
// 2-pass async 版。詳細は関数 doc。
//
// renderToReadableStream(fn): ReadableStream<Uint8Array> — ADR 0031 Step C-1+C-2 で追加。
// shell + tail streaming SSR。shell 即時 flush + 全 resource 解決後に boundary を
// 後追い fill。詳細は関数 doc。

import { setRenderer, getRenderer, type Renderer } from "./renderer";
import { runWithMountScope, discardMountQueue } from "./mount-queue";
import { Owner } from "./owner";
import { serverRenderer, serialize, type VNode } from "./server-renderer";
import {
  ResourceScope,
  runWithResourceScope,
  type BootstrapValue,
  type SerializedError,
} from "./resource-scope";
import { StreamingContext, runWithStream } from "./streaming-scope";

export function renderToString(fn: () => Node): string {
  const previous = getRenderer();
  // serverRenderer は VNode を返すので、Renderer<Node, Element, Text> に cast して
  // module state に載せる (ADR 0016 の「universal 境界コスト」で許容)。
  setRenderer(serverRenderer as unknown as Renderer<Node, Element, Text>);
  const owner = new Owner(null);
  try {
    const root = runWithMountScope(() => owner.run(fn));
    // root は VNode だが戻り型が Node のまま (jsx.ts の h が Node で返す)。
    // cast で server 側形式として扱う。
    return serialize(root as unknown as VNode);
  } finally {
    // server では onMount を発火しないので、溜まった queue を明示的に捨てる。
    // 放置すると次の renderToString で残り物が見えてしまう。
    discardMountQueue();
    owner.dispose();
    setRenderer(previous);
  }
}

/** renderToStringAsync の戻り値。`__vidro_data.resources` に同居させる前提。 */
export type RenderToStringAsyncResult = {
  /** 2-pass で resolved 値が焼かれた HTML markup */
  html: string;
  /** bootstrapKey → BootstrapValue の plain object (JSON.stringify に直接渡せる形) */
  resources: Record<string, BootstrapValue>;
};

/**
 * server で `bootstrapKey` 付き createResource を resolve してから markup を作る
 * 2-pass async 版 (ADR 0030 Step B-5c)。
 *
 *   1-pass: 空 ResourceScope で renderToString → Resource constructor が
 *           server mode を検知して fetcher を scope に register、loading=true
 *           で markup (この markup は捨てる)
 *   resolve: scope.fetchers を Promise.allSettled で待ち、resolved/rejected を
 *           BootstrapValue に整形。reject は SerializedError 形式に変換 (router の
 *           serializeError と同形、5-a)
 *   2-pass: resolved hits 入りの ResourceScope で renderToString → Resource
 *           constructor が hit を引き当てて loading=false スタート、resolved 値で
 *           markup が完成
 *
 * caller (createServerHandler 等) は返ってきた `resources` を `__vidro_data` に
 * 同居させる。client 側 Resource constructor が initial value を引き当てるので
 * blink 解消。
 *
 * `bootstrapKey` 未指定の resource は scope に register されない (B-5b 動作と同じ
 * loading=true 状態で markup に焼かれる)。
 *
 * CPU コストは 2x (JSX 評価 + VNode build を 2 回)。1-pass + 穴埋め化は将来の
 * 最適化案件 (project_pending_rewrites)。
 */
export async function renderToStringAsync(fn: () => Node): Promise<RenderToStringAsyncResult> {
  // --- 1-pass: fetcher 集め ---
  const collectScope = new ResourceScope();
  runWithResourceScope(collectScope, () => {
    // markup 結果は捨てる。意義は scope.fetchers 集めること。
    renderToString(fn);
  });

  // --- resolve all ---
  // Map → entries 配列に固定。Promise.allSettled の結果と添字対応するため。
  const entries = Array.from(collectScope.fetchers.entries());
  const settled = await Promise.allSettled(entries.map(([, fetcher]) => fetcher()));

  const hits = new Map<string, BootstrapValue>();
  for (let i = 0; i < entries.length; i++) {
    const key = entries[i]![0];
    const result = settled[i]!;
    if (result.status === "fulfilled") {
      hits.set(key, { data: result.value });
    } else {
      hits.set(key, { error: serializeBootstrapError(result.reason) });
    }
  }

  // --- 2-pass: resolved 値で markup ---
  const renderScope = new ResourceScope(hits);
  let html = "";
  runWithResourceScope(renderScope, () => {
    html = renderToString(fn);
  });

  // hits Map を JSON serializable な plain object に変換
  const resources: Record<string, BootstrapValue> = {};
  for (const [k, v] of hits) resources[k] = v;

  return { html, resources };
}

/** Promise.allSettled の reject reason を SerializedError 形式に整形。 */
function serializeBootstrapError(reason: unknown): SerializedError {
  if (reason instanceof Error) {
    return { name: reason.name, message: reason.message, stack: reason.stack };
  }
  return { name: "Error", message: String(reason) };
}

// --- Phase C streaming SSR ---

/**
 * shell 即時 flush + 全 resource resolve 後に各 Suspense boundary を
 * `<template>` + `__vidroFill` で後追い埋めする streaming SSR API (ADR 0031)。
 *
 * 流れ:
 *   1. shell-pass: StreamingContext を active にして renderToString。Suspense は
 *      `getCurrentStream()` を見て boundary 化 — children を 1 回評価して
 *      ResourceScope に fetcher を集めつつ、shell には `<div data-vidro-boundary>`
 *      で fallback markup を吐く + childrenFactory を ctx.boundaries に push
 *   2. controller.enqueue(inline runtime) — shell の先頭で 1 回 emit
 *   3. controller.enqueue(shell HTML)
 *   4. resolve all: ResourceScope.fetchers を Promise.allSettled で待ち、hits を組む
 *   5. controller.enqueue(`__vidroSetResources(...)`) — `<script id="__vidro_data">`
 *      を caller (router) が body に inject 済み前提。本 patch script で
 *      resources field を書き加える
 *   6. boundary-pass: 各 boundary について streaming context を **解除** し、
 *      hits 入り ResourceScope で childrenFactory を renderToString。`<template
 *      id="vidro-tpl-${id}">${childrenHtml}</template><script>__vidroFill("${id}")
 *      </script>` を順次 enqueue
 *   7. controller.close()
 *
 * caller (router/server.ts) は本 stream を shell prefix (`<head>` + `<body>` +
 * `<div id="app">`) と shell suffix (`</div></body></html>`) で挟んで Response
 * body にする。bootstrap data の `<script id="__vidro_data">` は caller が
 * inject (router 部分のみ、resources は本 stream の patch script で後出し)。
 *
 * ネスト Suspense は内側 boundary-pass で streaming context が解除されるので、
 * 既存 (renderToStringAsync 互換) 動作で children 直吐きになる。完全な
 * out-of-order streaming は将来案件 (project_pending_rewrites)。
 */
export function renderToReadableStream(fn: () => Node): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const emit = (chunk: string) => controller.enqueue(enc.encode(chunk));

      // 1. shell-pass: fetcher 集め + shell markup
      // `__vidroFill` / `__vidroSetResources` は caller が `<head>` に inject 済み
      // 前提。core は #app の中身に当たる stream chunks (shell + resources patch +
      // boundary fills) のみを担当する責務分離。
      const stream = new StreamingContext();
      const collectScope = new ResourceScope();
      let shellHtml = "";
      runWithStream(stream, () => {
        runWithResourceScope(collectScope, () => {
          shellHtml = renderToString(fn);
        });
      });
      emit(shellHtml);

      // 2. resolve all fetchers
      const entries = Array.from(collectScope.fetchers.entries());
      const settled = await Promise.allSettled(entries.map(([, fetcher]) => fetcher()));
      const hits = new Map<string, BootstrapValue>();
      for (let i = 0; i < entries.length; i++) {
        const key = entries[i]![0];
        const result = settled[i]!;
        if (result.status === "fulfilled") {
          hits.set(key, { data: result.value });
        } else {
          hits.set(key, { error: serializeBootstrapError(result.reason) });
        }
      }

      // 3. resources patch script (`__vidro_data` の resources field を書き換える)。
      //    hits が空でも emit しておく — Resource.constructor が hit lookup する時に
      //    `resources` field 自体は存在してた方が安全 (undefined check の差は無いが
      //    将来 reactive_source 拡張で per-key push があれば一貫性ある)
      const resources: Record<string, BootstrapValue> = {};
      for (const [k, v] of hits) resources[k] = v;
      const resourcesJson = escapeJsonForScript(resources);
      emit(`<script>__vidroSetResources(${resourcesJson})</script>`);

      // 4. boundary-pass: 各 boundary を再 render → template + fill script
      //    streaming context は **解除** (内側 Suspense は既存動作 = children 直吐き)。
      //    hits 入り ResourceScope を active にすれば、内側 createResource は
      //    bootstrap-hit branch で markup に焼かれる。
      const renderScope = new ResourceScope(hits);
      for (const b of stream.boundaries) {
        let childrenHtml = "";
        runWithResourceScope(renderScope, () => {
          childrenHtml = renderToString(b.childrenFactory as () => Node);
        });
        emit(
          `<template id="vidro-tpl-${b.id}">${childrenHtml}</template>` +
            `<script>__vidroFill("${b.id}")</script>`,
        );
      }

      controller.close();
    },
  });
}

/**
 * caller (例: `@vidro/router/server`) が `<head>` に 1 回 inject する最小 inline
 * runtime。`<script>${VIDRO_STREAMING_RUNTIME}</script>` の形で埋める想定。
 *
 * `__vidroFill(id)`: shell 内の `<!--vb-${id}-start-->` と `<!--vb-${id}-end-->`
 * の間に挟まった fallback markup を `<template id="vidro-tpl-${id}">` の content
 * と差し替える。start/end marker / template も remove して DOM 構造を綺麗にする
 * (hydrate cursor を fallback ではなく resolved children に合わせるため)。
 *
 * `__vidroSetResources(r)`: `<script id="__vidro_data">` の textContent (JSON) に
 * resources field を書き加える。Resource constructor は readVidroData() 経由で
 * 1 回 parse + cache するので、この patch は **hydrate より前** に走る必要がある
 * — streaming order (`__vidroSetResources` → boundary fills → DOMContentLoaded →
 * hydrate) で自然に成立する。
 *
 * minify はあえてしない (size < 600B、可読性優先)。production では bundler が
 * dead code elimination で消すか、別途 minify する余地あり。
 */
export const VIDRO_STREAMING_RUNTIME = `
window.__vidroFill=function(id){
var iter=document.createNodeIterator(document.body,NodeFilter.SHOW_COMMENT),s=null,e=null,n;
while((n=iter.nextNode())){if(n.nodeValue==="vb-"+id+"-start")s=n;else if(n.nodeValue==="vb-"+id+"-end")e=n;if(s&&e)break;}
var t=document.getElementById("vidro-tpl-"+id);
if(!s||!e||!t)return;
var c=s.nextSibling;
while(c&&c!==e){var nx=c.nextSibling;c.parentNode.removeChild(c);c=nx;}
e.parentNode.insertBefore(t.content,e);
s.parentNode.removeChild(s);
e.parentNode.removeChild(e);
t.parentNode&&t.parentNode.removeChild(t);
};
window.__vidroSetResources=function(r){
var s=document.getElementById("__vidro_data");
if(!s)return;
try{var d=JSON.parse(s.textContent);d.resources=r;s.textContent=JSON.stringify(d);}catch(e){}
};
`.replace(/\n/g, "");

/** `<script>...</script>` 内に JSON を inline する用の escape (XSS 対策、`</script>` 閉じ防止)。 */
function escapeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}
