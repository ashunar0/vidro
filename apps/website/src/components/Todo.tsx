import { Signal, For } from "@vidro/core";
import { Button } from "./Button";

type Item = { id: string; label: string };

export function Todo() {
  let nextId = 0;
  const genId = () => `t${nextId++}`;

  const items = new Signal<Item[]>([
    { id: genId(), label: "Apple" },
    { id: genId(), label: "Banana" },
    { id: genId(), label: "Cherry" },
  ]);

  // input を変数に取り出して ref 的に扱う (invoke-once なので評価済み DOM を直接参照できる)
  const inputEl = (
    <input
      type="text"
      placeholder="new item..."
      class="flex-1 max-w-[200px] px-3 py-2 border border-neutral-300 dark:border-neutral-700 rounded-lg bg-transparent"
    />
  ) as HTMLInputElement;

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
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    items.value = arr;
  };

  return (
    <section class="text-center">
      <h2 class="text-2xl font-semibold mb-2 tracking-tight">todo list</h2>
      <p class="text-sm text-neutral-500 dark:text-neutral-400 mb-4">
        For primitive で配列を reactive にレンダリング
      </p>
      <div class="flex gap-2 justify-center mb-4">
        {inputEl}
        <Button onClick={add}>add</Button>
        <Button onClick={shuffle}>shuffle</Button>
      </div>
      <ul class="list-none p-0 m-0 flex flex-col gap-2">
        <For
          each={items}
          fallback={<p class="text-sm text-neutral-500 dark:text-neutral-400">空です</p>}
        >
          {(item) => (
            <li class="flex items-center gap-3 px-4 py-2 border border-neutral-300 dark:border-neutral-700 rounded-lg">
              <span class="flex-1 text-left">{item.label}</span>
              <Button variant="icon-sm" aria-label="remove" onClick={() => removeItem(item.id)}>
                ×
              </Button>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}
