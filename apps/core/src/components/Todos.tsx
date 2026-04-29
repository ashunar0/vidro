import { signal, computed, effect, For } from "@vidro/core";
import { TodoItem, type Todo } from "./TodoItem";

const STORAGE_KEY = "vidro-todos";

// localStorage から todo を読み込む。壊れてたり空だったら [] で開始
function loadTodos(): Todo[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function Todos() {
  const initialTodos = loadTodos();

  const todos = signal<Todo[]>(initialTodos);
  const draft = signal("");

  // todos が変わるたびに localStorage に保存。
  effect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(todos.value));
  });

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
            <TodoItem
              todo={todo}
              onToggle={() => handleToggle(todo.id)}
              onRemove={() => handleRemove(todo.id)}
            />
          )}
        </For>
      </ul>
    </div>
  );
}
