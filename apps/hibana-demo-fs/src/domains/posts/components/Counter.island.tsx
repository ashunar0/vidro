import { signal } from "@vidro/core";

// 動作確認用 island。Phase 1 Step 3-b Phase B-1 以降:
//   - `defineIsland` 手書き wrap は不要 (= `@vidro/hibana/vite` plugin が default export を
//     auto-wrap する。name は filename "Counter" から自動付与)
//   - `{count.value}` は intrinsic 親 children で `_$dynamicChild(() => count.value)` に
//     書き換わって reactive 動作 (= memory project_jsx_runtime_contract_pending、ADR 0055)
//
// user 体験: islands FW 業界 default の「`export default function Name(props) { ... }` を書くだけ」
// に揃った。`@vidro/hibana/vite` plugin (= `hibanaVite()`) が走る前提。
export default function Counter({ initial }: { initial: number }) {
  const count = signal(initial);
  return (
    <button
      onClick={() => {
        count.value++;
      }}
    >
      Count: {count.value}
    </button>
  );
}
