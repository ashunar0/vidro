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
  // 入力値を Signal で双方向バインド。value / onInput で DOM property と同期する。
  const draft = new Signal("");

  const add = () => {
    const label = draft.value.trim();
    if (!label) return;
    items.value = [...items.value, { id: genId(), label }];
    draft.value = ""; // Signal 経由で input の DOM value もクリアされる
  };

  const removeItem = (id: string) => {
    items.value = items.value.filter((x) => x.id !== id);
  };

  return (
    <section class="text-center">
      <h2 class="text-2xl font-semibold mb-2 tracking-tight">todo list</h2>
      <p class="text-sm text-neutral-500 dark:text-neutral-400 mb-4">
        For primitive で配列を reactive にレンダリング
      </p>
      <div class="flex gap-2 justify-center mb-4">
        <input
          type="text"
          placeholder="new item..."
          value={draft}
          onInput={(e: Event) => {
            draft.value = (e.target as HTMLInputElement).value;
          }}
          class="flex-1 max-w-[200px] px-3 py-2 border border-neutral-300 dark:border-neutral-700 rounded-lg bg-transparent"
        />
        <Button onClick={add}>add</Button>
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
