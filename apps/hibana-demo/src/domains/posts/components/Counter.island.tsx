import { defineIsland } from "@vidro/hibana";
import { signal } from "@vidro/core";

// 動作確認用 island。Step 2 では @vidro/plugin の JSX reactive transform を使ってないので、
// reactive な child は手書き thunk `() => ...` で渡す必要がある (= JSX runtime が function
// child を dynamic slot として扱う規約)。Step 3 で Vite + @vidro/plugin を導入したら
// `{count.value}` のみで reactive になる。
//
// 構造的注意 (= memory project_jsx_runtime_contract_pending):
// thunk と static text を混ぜると SSR/hydrate cursor が divergent するので、button の
// children は **thunk 単独** に揃える。`Count: {() => count.value}` のような混在は cursor
// mismatch する。
function Counter({ initial }: { initial: number }) {
  const count = signal(initial);
  return (
    <button
      onClick={() => {
        count.value = count.value + 1;
      }}
    >
      {() => `Count: ${count.value}`}
    </button>
  );
}

export default defineIsland(Counter, "Counter");
