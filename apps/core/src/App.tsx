import { signal, computed, For } from "@vidro/core";

type Todo = { id: number; text: string; done: boolean };

function App() {
  const todos = signal<Todo[]>([]);
  const draft = signal("");

  // todo を追加する
  const handleAddTodo = () => {
    const text = draft.value.trim();
    if (!text) return;
    todos.value = [...todos.value, { id: Date.now(), text, done: false }];
    draft.value = "";
  };

  // todo を完了状態にする
  const handleToggle = (id: number) => {
    todos.value = todos.value.map((t) => (t.id === id ? { ...t, done: !t.done } : t));
  };

  // todo を削除する
  const handleRemove = (id: number) => {
    todos.value = todos.value.filter((t) => t.id !== id);
  };

  // 残りの todo の数を計算する
  const remaining = computed(() => todos.value.filter((t) => !t.done).length);

  return (
    <div class="mx-auto max-w-md p-8 font-sans">
      <h1 class="mb-6 text-2xl font-bold">Todos</h1>
      <div class="mb-3 flex gap-2">
        <input
          class="flex-1 rounded border px-3 py-2 outline-none "
          value={draft.value}
          onInput={(e: InputEvent) => (draft.value = (e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e: KeyboardEvent) => e.key === "Enter" && handleAddTodo()}
        />
        <button type="button" class="rounded px-4 py-2 bg-black text-white" onClick={handleAddTodo}>
          追加
        </button>
      </div>
      <p class="mb-3 text-sm">残り {remaining.value} 件 </p>
      <ul class="space-y-1">
        <For each={todos.value}>
          {(todo) => (
            <li class="flex items-center gap-2 rounded px-2 py-1.5">
              <input
                type="checkbox"
                class="h-4 w-4"
                checked={todo.done}
                onChange={() => handleToggle(todo.id)}
              />
              <span class={todo.done ? "flex-1 line-through" : "flex-1"}>{todo.text}</span>
              <button type="button" class="text-sm" onClick={() => handleRemove(todo.id)}>
                削除
              </button>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}

export default App;
