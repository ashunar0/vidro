import { signal } from "@vidro/core";

export function Todo() {
  const todos = signal([]);
  const newTodo = signal("");

  const handleAddTodo = () => {
    todos.value.push({ id: crypto.randomUUID(), text: newTodo.value });
    newTodo.value = "";
  };

  return (
    <div>
      <h1>Todo</h1>
      <input type="text" value={newTodo.value} onChange={(e) => (newTodo.value = e.target.value)} />
      <button onClick={handleAddTodo}>Add</button>
      <ul>
        {todos.value.map((todo) => (
          <li key={todo.id}>{todo.text}</li>
        ))}
      </ul>
    </div>
  );
}
