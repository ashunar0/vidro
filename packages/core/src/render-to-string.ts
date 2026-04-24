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

import { setRenderer, getRenderer, type Renderer } from "./renderer";
import { runWithMountScope, discardMountQueue } from "./mount-queue";
import { Owner } from "./owner";
import { serverRenderer, serialize, type VNode } from "./server-renderer";

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
