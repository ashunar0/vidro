import { signal, computed, effect, Show } from "@vidro/core";
import { Button } from "./Button";

export function Stopwatch() {
  const elapsed = signal(0); // 経過時間 (ms)
  const running = signal(false);

  // mm:ss.cs 形式の表示文字列。elapsed が変わるたび再計算される。
  const display = computed(() => {
    const ms = elapsed.value;
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const cs = Math.floor((ms % 1000) / 10);
    return `${pad(m)}:${pad(s)}.${pad(cs)}`;
  });

  // running が true の間だけ setInterval を走らせる。effect から cleanup を返すので、
  // running=false への切替 or component dispose 時に自動で clearInterval される。
  effect(() => {
    if (!running.value) return;
    const id = setInterval(() => {
      elapsed.value += 10;
    }, 10);
    return () => clearInterval(id);
  });

  const toggle = () => {
    running.value = !running.value;
  };

  const reset = () => {
    running.value = false;
    elapsed.value = 0;
  };

  return (
    <section class="text-center">
      <h1 class="text-2xl font-semibold mb-2 tracking-tight">vidro stopwatch</h1>
      <p class="text-sm text-neutral-500 dark:text-neutral-400 mb-8">
        Effect の cleanup 戻り値で setInterval を自動解除。
      </p>
      <div class="text-6xl font-semibold tabular-nums mb-8">{display.value}</div>
      <div class="flex gap-2 justify-center">
        <Show when={running} fallback={<Button onClick={toggle}>start</Button>}>
          <Button onClick={toggle}>stop</Button>
        </Show>
        <Button variant="muted" onClick={reset}>
          reset
        </Button>
      </div>
    </section>
  );
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
