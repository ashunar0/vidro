import { signal, Switch, Match } from "@vidro/core";
import { Counter } from "./components/Counter";
import { Todo } from "./components/Todo";
import { BoundaryDemo } from "./components/BoundaryDemo";
import { Stopwatch } from "./components/Stopwatch";

type View = "counter" | "todo" | "stopwatch" | "boundary";

const VIEWS: { value: View; label: string }[] = [
  { value: "counter", label: "counter" },
  { value: "todo", label: "todo" },
  { value: "stopwatch", label: "stopwatch" },
  { value: "boundary", label: "boundary" },
];

export function App() {
  const view = signal<View>("counter");

  const handleChange = (e: Event) => {
    view.value = (e.currentTarget as HTMLSelectElement).value as View;
  };

  // Switch + Match は早い者勝ちで 1 branch だけ mount。各 view は invoke-once で
  // 初期化されるので、切替は attach/detach のみ → state が保持される。
  return (
    <main class="flex flex-col gap-6 p-8 w-[min(100%,480px)]">
      <nav class="flex justify-center">
        <select
          value={view.value}
          onChange={handleChange}
          class="px-4 py-2 text-sm border border-neutral-300 dark:border-neutral-700 rounded-lg bg-transparent text-neutral-700 dark:text-neutral-300 cursor-pointer hover:border-indigo-500 dark:hover:border-indigo-400 transition-colors"
        >
          {VIEWS.map((v) => (
            <option value={v.value}>{v.label}</option>
          ))}
        </select>
      </nav>
      <Switch>
        <Match when={() => view.value === "counter"}>
          <Counter />
        </Match>
        <Match when={() => view.value === "todo"}>
          <Todo />
        </Match>
        <Match when={() => view.value === "stopwatch"}>
          <Stopwatch />
        </Match>
        <Match when={() => view.value === "boundary"}>
          <BoundaryDemo />
        </Match>
      </Switch>
    </main>
  );
}
