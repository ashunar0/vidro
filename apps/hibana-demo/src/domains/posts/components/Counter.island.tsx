import { defineIsland } from "@vidro/hibana";
import { signal } from "@vidro/core";

// 動作確認用 island。Step 2/3 merge 後 (= @vidro/plugin の jsxTransform が走る前提):
//   - `{count.value}` の expression は intrinsic 親 children では `_$dynamicChild(() => count.value)`
//     に書き換わり、reactive に update される
//   - adjacent static text と expression のあいだは `_$marker()` (empty Comment) が自動 inject
//     されて SSR/hydrate cursor が一致 (= memory project_jsx_runtime_contract_pending、ADR 0055)
//
// 手書き thunk (`{() => count.value}`) は Step 2 までの workaround、Step 3 で撤去。
function Counter({ initial }: { initial: number }) {
  const count = signal(initial);
  return (
    <button
      onClick={() => {
        count.value = count.value + 1;
      }}
    >
      Count: {count.value}
    </button>
  );
}

export default defineIsland(Counter, "Counter");
