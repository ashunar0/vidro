// Phase C streaming SSR の boundary registry (ADR 0031 + ADR 0033)。
//
// renderToReadableStream が shell-pass を実行する間、Suspense は
// `getCurrentStream()` が non-null かを見て boundary 化するか既存動作 (children
// 直吐き) かを分岐する。boundary 化したら id を採番 + per-boundary ResourceScope
// を立てつつ、scope と childrenFactory を本 ctx に push する。後で
// renderToReadableStream は各 boundary の scope.fetchers を独立に Promise.allSettled
// で待ち、resolve 順に template + fill chunk を emit する (out-of-order)。
//
// suspense-scope / resource-scope と同パターンの module-level state。

import type { ResourceScope } from "./resource-scope";

export type Boundary = {
  /** shell の `<!--vb-${id}-start--> ... <!--vb-${id}-end-->` marker pair と tail の `<template id="vidro-tpl-${id}">` を結ぶ識別子 */
  id: string;
  /** boundary 内 resource の fetcher を集める per-boundary scope (ADR 0033)。boundary-pass で hits 入りで再構築する hydration cache 元にもなる。 */
  scope: ResourceScope;
  /** tail で resolved scope のもとに再評価する Suspense の children (元 props.children をそのまま握る) */
  childrenFactory: () => unknown;
};

export class StreamingContext {
  #counter = 0;
  /** 登録順 = shell 内の出現順。out-of-order では emit 順とは無関係 (resolve 順に descend する) が、debug / 安定性目的で順序保持。 */
  readonly boundaries: Boundary[] = [];

  allocBoundaryId(): string {
    return `vb${this.#counter++}`;
  }

  registerBoundary(id: string, scope: ResourceScope, childrenFactory: () => unknown): void {
    this.boundaries.push({ id, scope, childrenFactory });
  }
}

let currentStream: StreamingContext | null = null;

/**
 * stream を active にして fn を評価。fn の内側 (= shell-pass の renderToString)
 * で Suspense が server mode を見ると `getCurrentStream()` で本 ctx を取り出して
 * boundary 化する。Owner.run と同じく try/finally で前 ctx に戻す (nested 呼び出し
 * 安全、boundary-pass で解除される動作も同じ機構で表現)。
 */
export function runWithStream<T>(ctx: StreamingContext | null, fn: () => T): T {
  const prev = currentStream;
  currentStream = ctx;
  try {
    return fn();
  } finally {
    currentStream = prev;
  }
}

/** 現在 active な streaming context。なければ null (= 既存 SSR 動作)。 */
export function getCurrentStream(): StreamingContext | null {
  return currentStream;
}
