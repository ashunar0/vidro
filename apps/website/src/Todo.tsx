import { Signal, For } from "@vidro/core";

type Item = { id: string; label: string };

// For の実地デモ用 Todo。参照 identity keyed な reconciliation で、shuffle しても
// 同じ <li> が再利用され、DOM 内の state (input のフォーカス等) が保持される。
export function Todo() {
  let nextId = 0;
  const genId = () => `t${nextId++}`;

  const items = new Signal<Item[]>([
    { id: genId(), label: "Apple" },
    { id: genId(), label: "Banana" },
    { id: genId(), label: "Cherry" },
  ]);

  // input の value は DOM から直接読み書きする (invoke-once なので ref 的に使える)
  const inputEl = (<input type="text" placeholder="new item..." />) as HTMLInputElement;

  const add = () => {
    const label = inputEl.value.trim();
    if (!label) return;
    items.value = [...items.value, { id: genId(), label }];
    inputEl.value = "";
  };

  const removeItem = (id: string) => {
    items.value = items.value.filter((x) => x.id !== id);
  };

  const shuffle = () => {
    const arr = [...items.value];
    // Fisher-Yates
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    items.value = arr;
  };

  return (
    <section class="todo">
      <h2>todo list</h2>
      <p class="note">For primitive で配列を reactive にレンダリング</p>
      <div class="todo-input">
        {inputEl}
        <button type="button" onClick={add}>
          add
        </button>
        <button type="button" onClick={shuffle}>
          shuffle
        </button>
      </div>
      <ul class="todo-list">
        <For each={items} fallback={<p class="hint">空です</p>}>
          {(item) => (
            <li>
              <span>{item.label}</span>
              <button type="button" aria-label="remove" onClick={() => removeItem(item.id)}>
                ×
              </button>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}
