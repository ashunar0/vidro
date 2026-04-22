import { Signal, Show } from "@vidro/core";
import { Counter } from "./components/Counter";
import { Todo } from "./components/Todo";
import { Button } from "./components/Button";

type View = "counter" | "todo";

export function App() {
  const view = new Signal<View>("counter");

  // Show の children / fallback は mount 時 1 回だけ評価される (invoke-once)。
  // 切替は attach/detach のみ → Counter の count、Todo の items はどちらも保持される。
  return (
    <main class="flex flex-col gap-6 p-8 w-[min(100%,480px)]">
      <nav class="flex gap-2 justify-center">
        <Button
          variant="muted"
          active={() => view.value === "counter"}
          onClick={() => {
            view.value = "counter";
          }}
        >
          counter
        </Button>
        <Button
          variant="muted"
          active={() => view.value === "todo"}
          onClick={() => {
            view.value = "todo";
          }}
        >
          todo
        </Button>
      </nav>
      <Show when={() => view.value === "counter"} fallback={<Todo />}>
        <Counter />
      </Show>
    </main>
  );
}
