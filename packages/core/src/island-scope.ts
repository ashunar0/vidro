// ADR 0060 partial hydration: per-render の island seq counter scope。
//
// 同一 component が同じ JSX 内で複数回出現 (= map で複数 instance 化される) ケース
// に対して、build-time scan の出現順では足りない。runtime で per-render の name →
// counter を引いて seq を決める必要がある。
//
// scope の寿命:
//   - renderToString の入口で `runWithIslandScope` で wrap、各 sync render call の中だけ
//     scope active。renderToStringAsync は内部で renderToString を 2 回 (= 1-pass / 2-pass)
//     呼ぶがどちらも独立 scope を作るので interleave なし
//   - renderToReadableStream の boundary-pass で `flushBoundary` 内 renderToString も
//     独立 scope (= 別 Map 採番)。Suspense は `.server.tsx` で import 禁止 (= ADR 0058 +
//     `assertNoReactivePrimitive`) なので、boundary-pass 経由で `__VidroIsland` が呼ばれる
//     経路は現状到達不可 (= reviewer M-2)。将来 `.server.tsx` で Suspense 許容方向に
//     変えるなら、shell-pass / boundary-pass で同じ Map を共有する設計に再考が必要
//   - 並行 request safety は AsyncLocalStorage 化で将来対応 (= project_pending_rewrites の
//     "global signal race" と一緒に整理)
//
// Map shape: name → これまでに割り当てた最大 seq。`__VidroIsland` が +1 して取得 + set。

export type IslandSeqState = Map<string, number>;

let currentScope: IslandSeqState | null = null;

export function getIslandSeqState(): IslandSeqState | null {
  return currentScope;
}

export function runWithIslandScope<T>(fn: () => T): T {
  const prev = currentScope;
  currentScope = new Map();
  try {
    return fn();
  } finally {
    currentScope = prev;
  }
}
