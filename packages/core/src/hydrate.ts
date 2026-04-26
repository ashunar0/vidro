// hydrate(fn, target): SSR で焼かれた既存 DOM に effect / event listener を attach する
// client only API。`mount` (fresh render) との対比 (ADR 0019)。
//
// 流れ:
//   1. target を post-order cursor で消費する HydrationRenderer に切替
//   2. fn を runWithMountScope + Owner で評価。h() の呼び出しが cursor を消費し、
//      対応する既存 Node に effect / addEventListener / property を attach
//   3. flushMountQueue で onMount を発火 (server では discardMountQueue で捨てた分)
//   4. renderer を defensive reset
//
// 戻り値は dispose 関数: target の DOM はそのまま残し、Owner 配下の effect / listener
// のみ解放する。DOM を消したい場合は呼び側が target.replaceChildren() する。

import { setRenderer, getRenderer, type Renderer } from "./renderer";
import { runWithMountScope, flushMountQueue } from "./mount-queue";
import { Owner } from "./owner";
import { createHydrationRenderer } from "./hydration-renderer";

export function hydrate(fn: () => Node, target: Element): () => void {
  const previous = getRenderer();
  const hydrationRenderer = createHydrationRenderer(target);
  setRenderer(hydrationRenderer as unknown as Renderer<Node, Element, Text>);

  const owner = new Owner(null);
  try {
    runWithMountScope(() => owner.run(fn));
    flushMountQueue();
  } finally {
    setRenderer(previous);
  }
  return () => {
    owner.dispose();
  };
}
