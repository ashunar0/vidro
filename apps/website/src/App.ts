import { Signal, Effect } from "@vidro/core";

/** Signal + Effect のカウンター。Effect が Signal の変更に自動追従して DOM を書き換える。 */
export function App(root: HTMLElement) {
  const count = new Signal(0);

  root.innerHTML = `
    <main class="counter">
      <h1>vidro counter</h1>
      <p class="note">Signal + Effect で DOM を自動反映。</p>
      <div class="display">
        <button id="minus" type="button" aria-label="decrement">-</button>
        <span id="count">0</span>
        <button id="plus" type="button" aria-label="increment">+</button>
      </div>
      <button id="reset" type="button" class="reset">reset</button>
    </main>
  `;

  const countEl = root.querySelector<HTMLSpanElement>("#count")!;
  const plusBtn = root.querySelector<HTMLButtonElement>("#plus")!;
  const minusBtn = root.querySelector<HTMLButtonElement>("#minus")!;
  const resetBtn = root.querySelector<HTMLButtonElement>("#reset")!;

  // Effect 内で count.value を読むと自動購読、初回即実行 + 以降 count 変更で再実行
  new Effect(() => {
    countEl.textContent = String(count.value);
  });

  plusBtn.addEventListener("click", () => count.value++);
  minusBtn.addEventListener("click", () => count.value--);
  resetBtn.addEventListener("click", () => {
    count.value = 0;
  });
}
