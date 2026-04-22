import { Signal } from "@vidro/core";
import { Button } from "./Button";

export function Counter() {
  const count = new Signal(0);

  const handleDecrement = () => {
    count.value--;
  };

  const handleIncrement = () => {
    count.value++;
  };

  const handleReset = () => {
    count.value = 0;
  };

  return (
    <section class="text-center">
      <h1 class="text-2xl font-semibold mb-2 tracking-tight">vidro counter</h1>
      <p class="text-sm text-neutral-500 dark:text-neutral-400 mb-8">
        Signal + Effect + JSX で DOM を自動反映。
      </p>
      <div class="flex items-center gap-4 justify-center mb-6">
        <Button variant="icon" onClick={handleDecrement}>
          -
        </Button>
        <span class="text-5xl font-semibold tabular-nums min-w-20">{count.value}</span>
        <Button variant="icon" onClick={handleIncrement}>
          +
        </Button>
      </div>
      <Button variant="muted" onClick={handleReset}>
        reset
      </Button>
    </section>
  );
}
