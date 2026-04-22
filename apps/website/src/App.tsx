import { Counter } from "./components/Counter";
import { Todo } from "./components/Todo";

export function App() {
  return (
    <main class="flex flex-col gap-12 p-8 w-[min(100%,480px)]">
      <Counter />
      <Todo />
    </main>
  );
}
