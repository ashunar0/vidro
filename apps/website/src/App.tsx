import { Signal, Show } from "@vidro/core";
import { Counter } from "./components/Counter";
import { Todo } from "./components/Todo";
import { BoundaryDemo } from "./components/BoundaryDemo";
import { Button } from "./components/Button";

type View = "counter" | "todo" | "boundary";

export function App() {
  const view = new Signal<View>("counter");

  // 各 view の Show は mount 時 1 回だけ children を評価する (invoke-once)。
  // 切替は attach/detach のみ → Counter / Todo / BoundaryDemo の state はどれも保持される。
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
        <Button
          variant="muted"
          active={() => view.value === "boundary"}
          onClick={() => {
            view.value = "boundary";
          }}
        >
          boundary
        </Button>
      </nav>
      <Show when={() => view.value === "counter"}>
        <Counter />
      </Show>
      <Show when={() => view.value === "todo"}>
        <Todo />
      </Show>
      <Show when={() => view.value === "boundary"}>
        <BoundaryDemo />
      </Show>
    </main>
  );
}
