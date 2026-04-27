// hydrate(fn, target): SSR で焼かれた既存 DOM に effect / event listener を attach する
// client only API。`mount` (fresh render) との対比 (ADR 0019)。
//
// 流れ (通常 hydrate):
//   1. target を post-order cursor で消費する HydrationRenderer に切替
//   2. fn を runWithMountScope + Owner で評価。h() の呼び出しが cursor を消費し、
//      対応する既存 Node に effect / addEventListener / property を attach
//   3. flushMountQueue で onMount を発火 (server では discardMountQueue で捨てた分)
//   4. renderer を defensive reset
//
// 戻り値は dispose 関数: target の DOM はそのまま残し、Owner 配下の effect / listener
// のみ解放する。DOM を消したい場合は呼び側が target.replaceChildren() する。
//
// 段階 hydration (ADR 0035):
//   target subtree に streaming SSR marker (`<!--vb-*-start-->`) があれば、
//   `StreamingHydrationContext` を立てて HydrationRenderer に `streaming: true` を
//   渡す。Suspense は children を hold + registry に push する経路に分岐する。
//   shell hydrate 完了後に registry を walk:
//     - 既に boundary fill 済みの entry → 即 hydrateBoundary を呼ぶ
//     - 未着の entry → `window.__vidroPendingHydrate[id]` に hydrate runner を
//       登録、後続の `__vidroFill(id)` 内で発火される

import { setRenderer, getRenderer, type Renderer } from "./renderer";
import { runWithMountScope, flushMountQueue } from "./mount-queue";
import { Owner } from "./owner";
import { createHydrationRenderer } from "./hydration-renderer";
import {
  StreamingHydrationContext,
  runWithStreamingHydration,
  type StreamingHydrationEntry,
} from "./streaming-hydration";

export function hydrate(fn: () => Node, target: Element): () => void {
  const previous = getRenderer();
  const streaming = hasStreamingMarker(target);
  const hydrationRenderer = createHydrationRenderer(target, { streaming });
  setRenderer(hydrationRenderer as unknown as Renderer<Node, Element, Text>);

  const owner = new Owner(null);
  const ctx = streaming ? new StreamingHydrationContext() : null;
  try {
    runWithStreamingHydration(ctx, () => {
      runWithMountScope(() => owner.run(fn));
    });
    flushMountQueue();
  } finally {
    setRenderer(previous);
  }

  if (ctx) {
    flushPending(ctx);
  }

  return () => {
    owner.dispose();
  };
}

/**
 * shell hydrate 完了後の registry walk。各 entry について:
 *   - 既に fill 済み (= start.nextSibling が end でない、かつ template が居ない) →
 *     boundary 単位 hydrate runner を即実行
 *   - 未着 (まだ fallback markup のまま) → `__vidroPendingHydrate[id]` に runner を
 *     登録、`__vidroFill(id)` runtime が後で呼ぶ
 *
 * fill 済みの判定は registry の id に対応する `<template id="vidro-tpl-${id}">` の
 * 存在をベースにする (fill 完了時に template が remove される設計、render-to-string
 * の VIDRO_STREAMING_RUNTIME 参照)。template が居る = まだ未 fill。
 */
function flushPending(ctx: StreamingHydrationContext): void {
  const pending = (globalThis as { __vidroPendingHydrate?: Record<string, () => void> })
    .__vidroPendingHydrate;
  for (const entry of ctx.entries) {
    if (isBoundaryFilled(entry.id)) {
      // 既に fill 済み (= template 不在) → 即時 hydrate
      tryHydrateBoundary(entry);
    } else if (pending) {
      // 未 fill + runtime 健在 → registry に登録、`__vidroFill` 経由で発火される
      pending[entry.id] = () => tryHydrateBoundary(entry);
    }
    // 未 fill + runtime 不在 (= VIDRO_STREAMING_RUNTIME 未 inject 等の異常状態) は
    // silent skip。fallback markup のまま hydrate を試みると cursor mismatch で
    // throw するので、保守的に何もしない (実害より silence の方が安全、ADR 0034
    // 系の「shell-pass error は silent degrade しない」原則とは別レイヤの話)。
  }
}

/** template が remove されてる = boundary chunk が `__vidroFill` で完了済み。 */
function isBoundaryFilled(id: string): boolean {
  if (typeof document === "undefined") return false;
  return document.getElementById(`vidro-tpl-${id}`) === null;
}

/**
 * boundary 単位 hydrate runner。`<!--vb-${id}-start-->` / `<!--vb-${id}-end-->`
 * 間を target subtree とする新 HydrationRenderer を作って childrenFactory を
 * 評価する。
 *
 * marker が見つからない (= 想定外 DOM 状態) なら dev warn して return (server /
 * client 採番 desync の signature)。
 */
function tryHydrateBoundary(entry: StreamingHydrationEntry): void {
  const start = findCommentMarker(`vb-${entry.id}-start`);
  const end = findCommentMarker(`vb-${entry.id}-end`);
  if (!start || !end) {
    // ADR 0035 review #7 (dev assertion): client と server で boundary id 採番が
    // desync した可能性 (e.g. server 側で `<Suspense>` が streaming context 外で
    // render されたが、client 側 shell hydrate run で streaming branch に入って
    // counter を進めた)。silent ignore は silent hydration mismatch に化けるので
    // warn を出す。production 取り除きは将来の dead-code-elimination で対応。
    console.warn(
      `[vidro] boundary "${entry.id}": start/end markers not found in DOM — ` +
        `client / server boundary id allocation may be desynced`,
    );
    return;
  }
  const parent = start.parentNode;
  if (!parent || parent.nodeType !== Node.ELEMENT_NODE) return;

  // boundary 単位の Renderer を作って childrenFactory を hydrate モードで run。
  // `streaming: false` にして内側 Suspense は通常 client mode で children を
  // そのまま評価する (本 ADR では nested Suspense は外側 boundary の一部扱い)。
  const previous = getRenderer();
  const renderer = createHydrationRenderer(parent as Element, {
    streaming: false,
    range: { start, end },
  });
  setRenderer(renderer as unknown as Renderer<Node, Element, Text>);

  const owner = new Owner(null);
  try {
    runWithMountScope(() => owner.run(entry.childrenFactory));
    flushMountQueue();
  } finally {
    setRenderer(previous);
  }
  // owner は親 Owner と未接続 (root level)、本 toy 段階では明示的 dispose 経路
  // 無し。本当に GC で済むか:
  //   - **event listener**: 直接 DOM Element に attach されるので、target ごと
  //     消えれば listener も消える (= leak しない)
  //   - **effect**: childrenFactory 内で global / long-lived signal を購読すると、
  //     その signal の subscriber list に effect が残り続ける。effect は Owner を
  //     親ポインタに持つので、効果として **Owner も signal 経由で reachable** に
  //     なり GC されない。これは leak。toy 段階では受容するが、router navigation
  //     で boundary が頻繁に作られる app では見過ごせなくなる
  //   - **onCleanup**: Owner.dispose 経路で発火する設計なので、dispose しないと
  //     setInterval / AbortController.abort などの cleanup が呼ばれない
  // → 本 ADR は「機構整備」で着地させ、boundary 単位の lifecycle / dispose API は
  // 別 ADR で扱う (`project_pending_rewrites.md` に追記)。
}

/** document 内で指定 value の comment Node を最初に 1 つ見つける。無ければ null。 */
function findCommentMarker(value: string): Comment | null {
  if (typeof document === "undefined") return null;
  const iter = document.createNodeIterator(document.body, NodeFilter.SHOW_COMMENT);
  let n: Node | null;
  while ((n = iter.nextNode())) {
    if ((n as Comment).nodeValue === value) return n as Comment;
  }
  return null;
}

/** target subtree 内に `<!--vb-*-start-->` 形式の comment があれば streaming SSR markup と判定。 */
function hasStreamingMarker(target: Element): boolean {
  if (typeof document === "undefined") return false;
  const iter = document.createNodeIterator(target, NodeFilter.SHOW_COMMENT);
  let n: Node | null;
  while ((n = iter.nextNode())) {
    const v = (n as Comment).nodeValue ?? "";
    if (v.startsWith("vb-") && v.endsWith("-start")) return true;
  }
  return false;
}
