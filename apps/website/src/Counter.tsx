import { Signal, Show } from "@vidro/core";

// JSX 経由のカウンター。Signal を children に渡すと @vidro/core 側が Effect で textNode を
// 自動更新する (B 書き)。onClick 内で count.value++ すると即座に DOM に反映される。
export function Counter() {
  const count = new Signal(0);

  return (
    <section class="counter">
      <h1>vidro counter</h1>
      <p class="note">Signal + Effect + JSX で DOM を自動反映。</p>
      <div class="display">
        <button type="button" aria-label="decrement" onClick={() => count.value--}>
          -
        </button>
        <span>{count}</span>
        <button type="button" aria-label="increment" onClick={() => count.value++}>
          +
        </button>
      </div>
      <Show when={() => count.value >= 3} fallback={<p class="hint">3 以上で褒めます</p>}>
        <p class="cheer">Well done!</p>
      </Show>
      <button
        type="button"
        class="reset"
        onClick={() => {
          count.value = 0;
        }}
      >
        reset
      </button>
    </section>
  );
}
