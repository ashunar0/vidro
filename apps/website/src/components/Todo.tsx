import { Signal, For, Computed } from "@vidro/core";
import { Button } from "./Button";

type Item = { id: string; label: string };

export function Todo() {
  const items = new Signal<Item[]>([
    { id: crypto.randomUUID(), label: "Apple" },
    { id: crypto.randomUUID(), label: "Banana" },
    { id: crypto.randomUUID(), label: "Cherry" },
  ]);
  const draft = new Signal("");
  // items.length の派生値。For の reconcile と同じ依存 (items) を共有するが Computed
  // が memoize してるので表示用の読み取りは安く済む。
  const itemCount = new Computed(() => items.value.length);

  const handleAddItem = () => {
    const label = draft.value.trim();
    if (!label) return;
    items.value = [...items.value, { id: crypto.randomUUID(), label }];
    draft.value = "";
  };

  const handleRemoveItem = (id: string) => {
    items.value = items.value.filter((x) => x.id !== id);
  };

  return (
    <section class="text-center">
      <h2 class="text-2xl font-semibold mb-2 tracking-tight">todo list</h2>
      <p class="text-sm text-neutral-500 dark:text-neutral-400 mb-4">
        For primitive で配列を reactive にレンダリング ({itemCount.value} 件)
      </p>
      <div class="flex gap-2 justify-center mb-4">
        <input
          type="text"
          placeholder="new item..."
          value={draft.value}
          onInput={(e: Event) => {
            draft.value = (e.target as HTMLInputElement).value;
          }}
          class="flex-1 max-w-[200px] px-3 py-2 border border-neutral-300 dark:border-neutral-700 rounded-lg bg-transparent"
        />
        <Button onClick={handleAddItem}>add</Button>
      </div>
      <ul class="list-none p-0 m-0 flex flex-col gap-2">
        <For
          each={items.value}
          fallback={<p class="text-sm text-neutral-500 dark:text-neutral-400">空です</p>}
        >
          {(item) => (
            <li class="flex items-center gap-3 px-4 py-2 border border-neutral-300 dark:border-neutral-700 rounded-lg">
              <span class="flex-1 text-left">{item.label}</span>
              <Button
                variant="icon-sm"
                aria-label="remove"
                onClick={() => handleRemoveItem(item.id)}
              >
                ×
              </Button>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}
