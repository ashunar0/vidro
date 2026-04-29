export type Todo = { id: number; text: string; done: boolean };

type TodoItemProps = {
  todo: Todo;
  onToggle: () => void;
  onRemove: () => void;
};

export function TodoItem({ todo, onToggle, onRemove }: TodoItemProps) {
  return (
    <li class="flex items-center gap-2 rounded px-2 py-1.5">
      <input type="checkbox" class="h-4 w-4" checked={todo.done} onChange={onToggle} />
      <span class={todo.done ? "flex-1 line-through" : "flex-1"}>{todo.text}</span>
      <button type="button" class="text-sm" onClick={onRemove}>
        削除
      </button>
    </li>
  );
}
