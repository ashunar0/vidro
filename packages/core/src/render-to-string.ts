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
import { ResourceScope, runWithResourceScope, type BootstrapValue } from "./resource-scope";
import { StreamingContext, runWithStream } from "./streaming-scope";
import { runWithIslandScope } from "./island-scope";

export function renderToString(fn: () => Node): string {
  const previous = getRenderer();
  // serverRenderer は VNode を返すので、Renderer<Node, Element, Text> に cast して
  // module state に載せる (ADR 0016 の「universal 境界コスト」で許容)。
  setRenderer(serverRenderer as unknown as Renderer<Node, Element, Text>);
  const owner = new Owner(null);
  try {
    // ADR 0060 partial hydration: per-render の island seq counter scope を立てる。
    // `__VidroIsland` (= jsx-transform で `.server.tsx` 内 island JSX を wrap した
    // helper) が同 component 複数 instance を区別するための per-name counter を引く。
    const root = runWithIslandScope(() => runWithMountScope(() => owner.run(fn)));
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
 * 1-pass async tree walk 版 (ADR 0030 Step B-5c → ADR 0064 Phase 3 で 1-pass 化)。
 *
 *   1-pass: 空 ResourceScope を立てて owner.run(fn) で JSX を 1 回評価。
 *           Resource constructor が server mode を見ると fetcher を即時 fire し、
 *           then-handler が scope.resolved + Resource 内部 signal に書き込む
 *           promise を scope.pending に register。server effect は ADR 0064 Phase 3 で
 *           subscribe するので、本 owner が dispose される前は signal 発火に追従して
 *           re-run できる (= text が "..." → resolved 値で更新される)
 *   resolve: `Promise.allSettled(scope.pending.values())` を await。期間中に
 *           Resource ctor の then-handler が signal を書き込み、subscribe 済み
 *           server effect が反応して VNode 木の text を更新する
 *   serialize: 待ち合わせ後の VNode 木を 1 回 serialize して HTML 化。owner.dispose
 *           は serialize 後に行う (effects を await 中も生かしておくため、
 *           renderToString sync 版の owner-dispose-immediately 経路と分離)
 *
 * caller (createServerHandler 等) は返ってきた `resources` を `__vidro_data` に
 * 同居させる。client 側 Resource constructor が initial value を引き当てるので
 * blink 解消。
 *
 * `bootstrapKey` 未指定の resource は scope に register されない (B-5b 動作と同じ
 * loading=true 状態で markup に焼かれる)。
 *
 * 旧 2-pass model (ADR 0030 / ADR 0064 Phase 2 中間状態) では JSX 評価 + VNode build を
 * 2 回行っていたコストを 1 回に縮小 (= ADR 0064 北極星「正しい使い方でも DB query 2x
 * の慢性コスト解消」の JSX 評価面の対応分)。
 */
export async function renderToStringAsync(fn: () => Node): Promise<RenderToStringAsyncResult> {
  const previous = getRenderer();
  setRenderer(serverRenderer as unknown as Renderer<Node, Element, Text>);
  const owner = new Owner(null);
  const scope = new ResourceScope();

  try {
    // --- 1-pass: VNode 木を 1 回だけ build。fetcher は ctor 内で fire 済み。 ---
    let root: Node | undefined;
    runWithResourceScope(scope, () => {
      root = runWithIslandScope(() => runWithMountScope(() => owner.run(fn)));
    });

    // --- await all settled ---
    // server effect が subscribe しているので、ここで then-handler が signal を
    // 書き込むと、effect が即時 re-run して VNode 木の text を resolved 値に更新する。
    // 各 settled は then(success, fail) で reject を吸収しているため allSettled で
    // 事故らない (Promise.all でも実害はないが念のため)。
    await Promise.allSettled(Array.from(scope.pending.values()));

    // --- serialize: signal 反映後の VNode を 1 回 serialize ---
    const html = serialize(root as unknown as VNode);

    const resources: Record<string, BootstrapValue> = {};
    for (const [k, v] of scope.resolved) resources[k] = v;

    return { html, resources };
  } finally {
    discardMountQueue();
    owner.dispose();
    setRenderer(previous);
  }
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
 *      各 boundary について `Promise.allSettled(boundary.scope.pending.values())`
 *      を独立 kick。resolve したら scope.resolved (then-handler が書き込み済み) を
 *      seed として boundary-pass で childrenFactory を同 scope で renderToString → 1 chunk
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

        // ADR 0036: shell flush 直後 (= 後着 boundary chunks より前) に boot
        // trigger を 1 回 enqueue。bundle (= app の main entry を `<script
        // type="module" async>` で head から先読み) が既に load 済みなら即
        // `__vidroBoot()` を呼んで shell hydrate を起動、まだなら
        // `__vidroBootPending` flag を立てる (= bundle の load 完了時に
        // main.tsx 側でフラグを見て即発火)。ADR 0035 の `__vidroPendingHydrate`
        // と同じ registry idiom で、defer (= DOMContentLoaded 待ち) の壁を
        // 取り除き TTI を縮める。
        emit(VIDRO_BOOT_TRIGGER);

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
 * pending) を解決して、`__vidroAddResources(...)` partial patch だけ emit する。
 * template / fill は無し (root に DOM 配置を持たない)。pending 0 個なら何も
 * emit しないで早期 return (空 patch を出す意味は無い、ADR 0033 論点 9)。
 */
async function flushRoot(scope: ResourceScope, emit: (chunk: string) => void): Promise<void> {
  if (scope.pending.size === 0) return;
  await Promise.allSettled(Array.from(scope.pending.values()));
  // Resource ctor の then-handler が registerResolved で書き込み済み。
  if (scope.resolved.size === 0) return;
  const hits: Record<string, BootstrapValue> = {};
  for (const [k, v] of scope.resolved) hits[k] = v;
  emit(`<script>__vidroAddResources(${escapeJsonForScript(hits)})</script>`);
}

/**
 * 1 boundary 分の resolve + render + emit。out-of-order の核 (ADR 0033 → 0064 Phase 2)。
 *
 *   1. boundary scope の全 pending を Promise.allSettled。Resource ctor の
 *      then-handler が scope.resolved に書き込み済み
 *   2. boundary-pass: streaming context **解除済み** state で childrenFactory を
 *      同じ scope で renderToString。内側 Resource ctor は getResolved で hit を
 *      引き当て (= 1-pass で fired した結果が反映される)、内側 Suspense は children 直吐き
 *   3. partial bootstrap patch + template + fill script を 1 chunk で emit
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
  await Promise.allSettled(Array.from(scope.pending.values()));

  // boundary-pass: scope.resolved 入りの同じ scope で再 render。streaming
  // context は本 task の call stack 上では立っていない (start(controller) 内の
  // runWithStream は既に try/finally で抜けて null に戻っている) ので、内側
  // Suspense は children 直吐き。
  let childrenHtml = "";
  runWithResourceScope(scope, () => {
    childrenHtml = renderToString(childrenFactory as () => Node);
  });

  // partial bootstrap patch (この boundary 分だけ key 単位 merge) + template + fill。
  // 1 emit にまとめるのは、3 個別 enqueue でも順序保証は同じだが、Workers の
  // chunk 境界を boundary 単位で揃えたい (debug / トレース性) ため。
  const partial: Record<string, BootstrapValue> = {};
  for (const [k, v] of scope.resolved) partial[k] = v;
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
 * と差し替える。template element は remove して DOM 構造を綺麗にするが、
 * **start/end marker は保持** する (ADR 0035 B-α: 段階 hydration の boundary
 * target 境界として必要)。fill 末尾で `__vidroPendingHydrate[id]` が登録済みなら
 * 発火 (= shell hydrate より遅れて届いた boundary chunk が hydrate を駆動する経路)。
 *
 * `__vidroAddResources(r)` (ADR 0033 + ADR 0034): per-boundary partial bootstrap
 * を **`window.__vidroResources` object に key 単位 merge** する。
 * `bootstrap.ts` の `readVidroData()` は cache 確定時にこの window object を
 * `parsed.resources` に shallow merge する。ADR 0035 (C-α) では Resource が
 * cache を bypass して `window.__vidroResources` を直接 lookup する経路もある
 * (cache 確定後に届いた boundary chunk の resources を引き当てるため)。
 *
 * `__vidroPendingHydrate[id] = fn` (ADR 0035): shell hydrate run の Suspense が
 * children を hold した closure (= boundary 単位 hydrate runner) を保留する registry。
 * fill が後で来たら登録済み runner が走り、boundary 内が hydrate される。fill が
 * shell hydrate より先に来たケースは `flushPending` (hydrate.ts) が即時 walk + 実行。
 *
 * `__vidroIslandHydrate = []` (ADR 0060): partial hydration の island queue。
 * `<!--vi-${name}-${seq}-start:{...}-->` ... `<!--vi-${name}-${seq}-end-->` で
 * 囲まれた island 範囲を hydrate するための entry を server が push 経路で push、
 * client runtime (`@vidro/router`) が walker で順に hydrate する。boundary registry
 * (`__vidroPendingHydrate`) の `vb-` map shape と完全に namespace 分離 (= reviewer
 * C-1)。entry shape は `{ type: "island", name, seq, key, routeFile, props }`。
 * walker / hydrate 実装は本 ADR Phase 2 (= router 改修 + plugin transform) で着地。
 *
 * 旧仕様 (ADR 0033 初版) は `<script id="__vidro_data">` の textContent を
 * 直接書き換えていたが、`readVidroData()` が `el.remove()` した後に届く partial
 * patch が silent drop される race があった。ADR 0034 で window object 経由に
 * 変更してこれを根治。
 *
 * minify はあえてしない (size < 800B、可読性優先)。production では bundler が
 * dead code elimination で消すか、別途 minify する余地あり。
 */
export const VIDRO_STREAMING_RUNTIME = `
window.__vidroResources=window.__vidroResources||{};
window.__vidroAddResources=function(r){for(var k in r)window.__vidroResources[k]=r[k];};
window.__vidroPendingHydrate=window.__vidroPendingHydrate||{};
window.__vidroIslandHydrate=window.__vidroIslandHydrate||[];
window.__vidroFill=function(id){
var iter=document.createNodeIterator(document.body,NodeFilter.SHOW_COMMENT),s=null,e=null,n;
while((n=iter.nextNode())){if(n.nodeValue==="vb-"+id+"-start")s=n;else if(n.nodeValue==="vb-"+id+"-end")e=n;if(s&&e)break;}
var t=document.getElementById("vidro-tpl-"+id);
if(!s||!e||!t)return;
var c=s.nextSibling;
while(c&&c!==e){var nx=c.nextSibling;c.parentNode.removeChild(c);c=nx;}
e.parentNode.insertBefore(t.content,e);
t.parentNode&&t.parentNode.removeChild(t);
var pend=window.__vidroPendingHydrate[id];
if(pend){delete window.__vidroPendingHydrate[id];pend();}
};
`.replace(/\n/g, "");

/**
 * shell flush 直後に 1 回 emit する boot trigger script (ADR 0036)。
 *
 * shell の DOM が乗った瞬間に発火させたい hydrate 起動を、registry 経由で起こす:
 * - bundle (= app entry を `<head>` async で読んだもの) が `window.__vidroBoot`
 *   を既に登録済 → trigger が `__vidroBoot()` を即時呼び出し → shell hydrate
 *   が後着 boundary より早く走り出す
 * - bundle が遅着 → `__vidroBootPending=true` を flag → bundle の load 完了時に
 *   `main.tsx` 側 (本リポジトリでは `apps/router-demo/src/main.tsx`) が flag を
 *   見て即発火
 *
 * この trigger は VIDRO_STREAMING_RUNTIME と違って caller (router/server.ts)
 * が `<head>` に inject するのではなく、core の `renderToReadableStream` 自身が
 * shell-pass 完了直後に 1 回だけ stream に流す。boundary chunks よりも前に並ぶ
 * 順序が API レベルで保証されることが TTI 改善の本質 (ADR 0036)。
 *
 * 内容は最小: classic (non-module) inline script、size ~80B、minify 不要。
 */
export const VIDRO_BOOT_TRIGGER = `<script>window.__vidroBoot?window.__vidroBoot():(window.__vidroBootPending=true);</script>`;

/** `<script>...</script>` 内に JSON を inline する用の escape (XSS 対策、`</script>` 閉じ防止)。 */
function escapeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}
