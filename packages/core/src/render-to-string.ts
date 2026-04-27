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
// `bootstrapKey` 付き resource を server で resolve してから markup を作る
// 2-pass async 版。詳細は関数 doc。
//
// renderToReadableStream(fn): ReadableStream<Uint8Array> — ADR 0031 Step C-1+C-2 で導入、
// ADR 0033 で out-of-order full streaming に拡張。shell 即時 flush + 各 Suspense
// boundary を **resolve 順** に独立 enqueue する (= 速い boundary が遅い boundary
// に律速されない)。per-boundary ResourceScope で fetcher を分離し、boundary 単位
// で並列 Promise.allSettled。詳細は関数 doc。

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
 * server で `bootstrapKey` 付き resource を resolve してから markup を作る
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
 * shell 即時 flush + 各 Suspense boundary を **resolve 順** に独立 emit する
 * out-of-order streaming SSR API (ADR 0031 + ADR 0033)。
 *
 * 流れ:
 *   1. shell-pass: StreamingContext を active にして renderToString。Suspense は
 *      `getCurrentStream()` を見て boundary 化 — per-boundary ResourceScope を
 *      立てて children を 1 回評価し fetcher 収集、shell には marker + fallback
 *      markup + suspense anchor を吐く。boundary {id, scope, childrenFactory} を
 *      ctx に push
 *   2. emit(shellHtml) — shell を即 flush (TTFB / FCP に効く)
 *   3. boundary 並列 flush (ADR 0033 out-of-order):
 *      各 boundary について `Promise.allSettled(boundary.scope.fetchers)` を独立
 *      kick。resolve したら hits を組み、boundary-pass で hits 入り ResourceScope
 *      で childrenFactory を renderToString → 1 chunk
 *      (`<script>__vidroAddResources(...)</script>` + `<template>...</template>` +
 *      `<script>__vidroFill("${id}")</script>`) にまとめて emit。controller.enqueue
 *      は sync なので Promise の resolve 順 = stream chunk 順
 *   4. 全 boundary flush 完了で controller.close()
 *
 * caller (router/server.ts) は本 stream を shell prefix (`<head>` + `<body>` +
 * `<div id="app">`) と shell suffix (`</div></body></html>`) で挟んで Response
 * body にする。bootstrap data の `<script id="__vidro_data">` は caller が
 * inject (router 部分のみ、resources は本 stream の partial patch で後出し累積)。
 *
 * ネスト Suspense は内側 boundary-pass で streaming context が解除されるので、
 * 既存 (renderToStringAsync 互換) 動作で children 直吐きになる。内側を独立 chunk
 * 化する true full out-of-order は将来案件 (project_pending_rewrites)。
 */
export function renderToReadableStream(fn: () => Node): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const emit = (chunk: string) => controller.enqueue(enc.encode(chunk));

      try {
        // 1. shell-pass: per-boundary scope に fetcher を集めつつ shell markup を作る
        //    `__vidroFill` / `__vidroAddResources` は caller が `<head>` に inject
        //    済み前提。core は #app の中身に当たる stream chunks (shell + 各
        //    boundary chunk) のみを担当する責務分離。
        //
        //    rootScope (ADR 0033 論点 9): Suspense **外** で declare された
        //    bootstrapKey 付き resource を吸収する root pseudo-boundary scope。
        //    Suspense 内側では runWithResourceScope の push/pop で boundaryScope
        //    に切り替わるので、Suspense 外の resource だけが rootScope に残る。
        const stream = new StreamingContext();
        const rootScope = new ResourceScope();
        let shellHtml = "";
        runWithStream(stream, () => {
          runWithResourceScope(rootScope, () => {
            shellHtml = renderToString(fn);
          });
        });
        emit(shellHtml);

        // 2. boundary 並列 flush + root scope flush (ADR 0033 out-of-order)
        //    各 boundary に対して独立に Promise.allSettled。resolve した順で chunk
        //    を emit する。controller.enqueue は sync なので serialize される。
        //    rootScope は template/fill を持たないので __vidroAddResources のみ。
        //    Promise.allSettled で全完了を待ってから controller.close() する。
        await Promise.allSettled([
          flushRoot(rootScope, emit),
          ...stream.boundaries.map((b) => flushBoundary(b.id, b.scope, b.childrenFactory, emit)),
        ]);

        controller.close();
      } catch (err) {
        // ADR 0034 Issue 2: shell-pass throw (= renderToString が同期 throw、
        // または runWithResourceScope の push/pop 中の例外) を明示的に
        // controller.error に流す。WhatWG 仕様では start() reject = stream
        // errored 状態になるので動作は同じだが、明示する方が consumer 側
        // (router の composeResponseStream) に意図が伝わりやすい + stack trace
        // 情報も失われない。boundary-pass 内の throw は Promise.allSettled が
        // 拾うので本 catch には到達しない (= fallback がそのまま残る、ADR 0033
        // 論点 6)。
        controller.error(err);
      }
    },
  });
}

/**
 * Suspense 外で declare された bootstrapKey 付き resource (= rootScope の
 * fetcher) を解決して、`__vidroAddResources(...)` partial patch だけ emit する。
 * template / fill は無し (root に DOM 配置を持たない)。fetcher 0 個なら何も
 * emit しないで早期 return (空 patch を出す意味は無い、ADR 0033 論点 9)。
 */
async function flushRoot(scope: ResourceScope, emit: (chunk: string) => void): Promise<void> {
  const entries = Array.from(scope.fetchers.entries());
  if (entries.length === 0) return;
  const settled = await Promise.allSettled(entries.map(([, fetcher]) => fetcher()));
  const hits: Record<string, BootstrapValue> = {};
  for (let i = 0; i < entries.length; i++) {
    const key = entries[i]![0];
    const result = settled[i]!;
    hits[key] =
      result.status === "fulfilled"
        ? { data: result.value }
        : { error: serializeBootstrapError(result.reason) };
  }
  emit(`<script>__vidroAddResources(${escapeJsonForScript(hits)})</script>`);
}

/**
 * 1 boundary 分の resolve + render + emit。out-of-order の核。
 *
 *   1. boundary scope の全 fetcher を Promise.allSettled
 *   2. hits を組む (data / error 両対応、SerializedError 経由)
 *   3. boundary-pass: streaming context **解除済み** state で childrenFactory を
 *      hits 入り ResourceScope で renderToString。内側 Suspense は children 直吐き
 *   4. partial bootstrap patch + template + fill script を 1 chunk で emit
 *
 * boundary 単位の throw (例: childrenFactory 内 sync throw) は呼び出し元の
 * Promise.allSettled が拾うので、stream 全体は止めない (= fallback がそのまま
 * 残る、ADR 0033 論点 6)。
 */
async function flushBoundary(
  id: string,
  scope: ResourceScope,
  childrenFactory: () => unknown,
  emit: (chunk: string) => void,
): Promise<void> {
  const entries = Array.from(scope.fetchers.entries());
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

  // boundary-pass: hits 入り scope で再 render。streaming context は本 task の
  // call stack 上では立っていない (start(controller) 内の runWithStream は既に
  // try/finally で抜けて null に戻っている) ので、内側 Suspense は children 直吐き。
  const renderScope = new ResourceScope(hits);
  let childrenHtml = "";
  runWithResourceScope(renderScope, () => {
    childrenHtml = renderToString(childrenFactory as () => Node);
  });

  // partial bootstrap patch (この boundary 分だけ key 単位 merge) + template + fill。
  // 1 emit にまとめるのは、3 個別 enqueue でも順序保証は同じだが、Workers の
  // chunk 境界を boundary 単位で揃えたい (debug / トレース性) ため。
  const partial: Record<string, BootstrapValue> = {};
  for (const [k, v] of hits) partial[k] = v;
  emit(
    `<script>__vidroAddResources(${escapeJsonForScript(partial)})</script>` +
      `<template id="vidro-tpl-${id}">${childrenHtml}</template>` +
      `<script>__vidroFill("${id}")</script>`,
  );
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
 * `__vidroAddResources(r)` (ADR 0033 + ADR 0034): per-boundary partial bootstrap
 * を **`window.__vidroResources` object に key 単位 merge** する。
 * `bootstrap.ts` の `readVidroData()` は cache 確定時にこの window object を
 * `parsed.resources` に shallow merge する設計 (ADR 0034 Issue 1 fix)。
 *
 * 旧仕様 (ADR 0033 初版) は `<script id="__vidro_data">` の textContent を
 * 直接書き換えていたが、`readVidroData()` が `el.remove()` した後に届く partial
 * patch が silent drop される race があった (将来段階 hydration で確実に踏む
 * 地雷)。ADR 0034 で window object 経由に変更してこれを根治。
 *
 * minify はあえてしない (size < 700B、可読性優先)。production では bundler が
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
window.__vidroResources=window.__vidroResources||{};
window.__vidroAddResources=function(r){for(var k in r)window.__vidroResources[k]=r[k];};
`.replace(/\n/g, "");

/** `<script>...</script>` 内に JSON を inline する用の escape (XSS 対策、`</script>` 閉じ防止)。 */
function escapeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}
