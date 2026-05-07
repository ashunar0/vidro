// ADR 0060 partial hydration: per-render の island seq counter scope。
//
// 同一 component が同じ JSX 内で複数回出現 (= map で複数 instance 化される) ケース
// に対して、build-time scan の出現順では足りない。runtime で per-render の name →
// counter を引いて seq を決める必要がある。
//
// scope の寿命:
//   - renderToString の入口で `runWithIslandScope` で wrap、render call の中だけ
//     scope active。renderToStringAsync は内部で renderToString を 1 回 (= 1-pass、
//     ADR 0064 で 2-pass 撤廃済) 呼ぶ
//   - renderToReadableStream の各 Suspense boundary は per-boundary scope を立てる
//     (ADR 0064 Phase 4)。Suspense は `.server.tsx` で import 禁止 (= ADR 0058 +
//     `assertNoReactivePrimitive`) なので、boundary 内側で `__VidroIsland` が呼ばれる
//     経路は現状到達不可 (= reviewer M-2)
//   - **ADR 0065 で AsyncLocalStorage 化済**: scope context は `await` を生き残る。
//     async function component (ADR 0066) の continuation 内で `__VidroIsland` が
//     呼ばれても seq counter が引ける。並行 request safety も同時解決 (= isolate 内
//     並行 request が独立 Map を持つ)
//
// Map shape: name → これまでに割り当てた最大 seq。`__VidroIsland` が +1 して取得 + set。

import { createScope } from "./scope-context";

export type IslandSeqState = Map<string, number>;

const islandScope = createScope<IslandSeqState>();

export function getIslandSeqState(): IslandSeqState | null {
  return islandScope.getCurrent();
}

export function runWithIslandScope<T>(fn: () => T): T {
  return islandScope.runWith(new Map(), fn);
}
