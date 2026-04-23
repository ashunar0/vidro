import { signal, ref, For, computed, effect, batch, onMount, untrack } from "@vidro/core";
import { Button } from "./Button";

type Item = { id: string; label: string };

export function Todo() {
  const items = signal<Item[]>([
    { id: crypto.randomUUID(), label: "Apple" },
    { id: crypto.randomUUID(), label: "Banana" },
    { id: crypto.randomUUID(), label: "Cherry" },
  ]);
  const draft = signal("");
  // items.length の派生値。For の reconcile と同じ依存 (items) を共有するが Computed
  // が memoize してるので表示用の読み取りは安く済む。
  const itemCount = computed(() => items.value.length);

  // batch の効果を可視化する観測用 Effect。items が変わるたびに +1 される。
  // 書き込みは untrack で包み、自身の再実行ループを断つ。
  const effectRuns = signal(0);
  effect(() => {
    void items.value;
    untrack(() => {
      effectRuns.value = effectRuns.value + 1;
    });
  });

  const handleAddItem = () => {
    const label = draft.value.trim();
    if (!label) return;
    items.value = [...items.value, { id: crypto.randomUUID(), label }];
    draft.value = "";
  };

  const handleRemoveItem = (id: string) => {
    items.value = items.value.filter((x) => x.id !== id);
  };

  // batch なし: 3 回 write するので Effect が 3 回走る
  const handleBulkAddNoBatch = () => {
    const tag = Date.now().toString(36).slice(-4);
    items.value = [...items.value, { id: crypto.randomUUID(), label: `no-batch ${tag}-1` }];
    items.value = [...items.value, { id: crypto.randomUUID(), label: `no-batch ${tag}-2` }];
    items.value = [...items.value, { id: crypto.randomUUID(), label: `no-batch ${tag}-3` }];
  };

  // batch あり: 3 回 write しても Effect は 1 回だけ flush される
  const handleBulkAddBatched = () => {
    const tag = Date.now().toString(36).slice(-4);
    batch(() => {
      items.value = [...items.value, { id: crypto.randomUUID(), label: `batched ${tag}-1` }];
      items.value = [...items.value, { id: crypto.randomUUID(), label: `batched ${tag}-2` }];
      items.value = [...items.value, { id: crypto.randomUUID(), label: `batched ${tag}-3` }];
    });
  };

  // ref で input 要素を受け取り、onMount で focus を当てる。
  // Vidro では App の mount 時に 1 回だけ flush されるため、Todo が Show の
  // fallback 側 (初期表示でない) だと focus() は DOM detach 状態で no-op になる
  // 点に注意 (docs/decisions/0002-on-mount.md の gotcha 参照)。
  const draftInput = ref<HTMLInputElement>();
  onMount(() => draftInput.current?.focus());

  return (
    <section class="text-center">
      <h2 class="text-2xl font-semibold mb-2 tracking-tight">todo list</h2>
      <p class="text-sm text-neutral-500 dark:text-neutral-400 mb-4">
        For primitive で配列を reactive にレンダリング ({itemCount.value} 件)
      </p>
      <div class="flex gap-2 justify-center mb-4">
        <input
          ref={draftInput}
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
      <div class="flex flex-col gap-2 items-center mb-4">
        <p class="text-xs text-neutral-500 dark:text-neutral-400">
          items 観測 effect 実行回数: {effectRuns.value} 回
        </p>
        <div class="flex gap-2 justify-center">
          <Button variant="muted" onClick={handleBulkAddNoBatch}>
            3 件追加 (batch なし → +3)
          </Button>
          <Button variant="muted" onClick={handleBulkAddBatched}>
            3 件追加 (batch あり → +1)
          </Button>
        </div>
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
