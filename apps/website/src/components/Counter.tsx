import { Signal, Show } from "@vidro/core";
import { Button } from "./Button";

export function Counter() {
  const count = new Signal(0);

  return (
    <section class="text-center">
      <h1 class="text-2xl font-semibold mb-2 tracking-tight">vidro counter</h1>
      <p class="text-sm text-neutral-500 dark:text-neutral-400 mb-8">
        Signal + Effect + JSX で DOM を自動反映。
      </p>
      <div class="flex items-center gap-4 justify-center mb-6">
        <Button variant="icon" aria-label="decrement" onClick={() => count.value--}>
          -
        </Button>
        <span class="text-5xl font-semibold tabular-nums min-w-20">{count}</span>
        <Button variant="icon" aria-label="increment" onClick={() => count.value++}>
          +
        </Button>
      </div>
      <Show
        when={() => count.value >= 3}
        fallback={
          <p class="text-sm text-neutral-500 dark:text-neutral-400 mb-4">3 以上で褒めます</p>
        }
      >
        <p class="text-sm text-indigo-500 dark:text-indigo-400 mb-4">Well done!</p>
      </Show>
      <Button
        variant="muted"
        onClick={() => {
          count.value = 0;
        }}
      >
        reset
      </Button>
    </section>
  );
}
