// 段階 hydration の boundary registry (ADR 0035)。
//
// streaming SSR 経由で焼かれた markup を hydrate するとき、Suspense streaming
// branch は cursor 過剰消費の回避のため shell hydrate run 中は children を
// **評価せず closure として hold** する。closure は本 context の registry に push
// され、shell hydrate 完了後 (hydrate.ts の `flushPending`) または `__vidroFill`
// runtime が後着 chunk を fill した時 (`window.__vidroPendingHydrate[id]`) に
// 引き当てて hydrate を発火する。
//
// boundary id は server-side `StreamingContext.allocBoundaryId()` と同じ規則
// (`vb${counter++}`) で採番する。client の shell hydrate run 中の Suspense 評価順は
// server の shell render 評価順と一致 (同じ JSX を同じ post-order で walk するため)
// なので、id が server / client で一致して、`<!--vb-${id}-start-->` marker と
// boundary chunk の template id が結びつく。
//
// suspense-scope / streaming-scope と同パターンの module-level state + try/finally
// で push/pop する。

export type StreamingHydrationEntry = {
  /** server-side `StreamingContext.allocBoundaryId()` と一致する `vb${counter++}` 形式 */
  id: string;
  /** Suspense が hold した children factory。boundary fill 後に新 Renderer で評価される */
  childrenFactory: () => Node;
};

export class StreamingHydrationContext {
  #counter = 0;
  readonly entries: StreamingHydrationEntry[] = [];

  /** server-side StreamingContext と同規則で id を採番。 */
  allocBoundaryId(): string {
    return `vb${this.#counter++}`;
  }

  registerBoundary(entry: StreamingHydrationEntry): void {
    this.entries.push(entry);
  }
}

let currentStreamingHydration: StreamingHydrationContext | null = null;

/**
 * shell hydrate run 中だけ ctx を active にする。fn の内側で Suspense streaming
 * branch が `getCurrentStreamingHydration()` を見て children を hold するか判定する。
 * try/finally で previous に戻すのは nested 安全のため (ただし toy 段階では nest
 * しない想定)。
 */
export function runWithStreamingHydration<T>(
  ctx: StreamingHydrationContext | null,
  fn: () => T,
): T {
  const prev = currentStreamingHydration;
  currentStreamingHydration = ctx;
  try {
    return fn();
  } finally {
    currentStreamingHydration = prev;
  }
}

/** 現在 active な streaming hydration context。なければ null (= 通常 hydrate)。 */
export function getCurrentStreamingHydration(): StreamingHydrationContext | null {
  return currentStreamingHydration;
}
